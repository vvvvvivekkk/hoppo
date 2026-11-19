#!/usr/bin/env python3
"""
Race the refund of one wallet-paid order.

A WALLET order holds its total at placement (one ORDER_HOLD debit). Cancelling
releases it (one ORDER_RELEASE credit). The ledger is append-only, so a second
release is money created from nothing that can never be edited away.

Four variants, one per round in rotation:

  A  N cancels from the student, all at once.
  B  the student's cancels and the shop's rejects, all at once - two
     different endpoints that both refund the same hold.
  C  FR-DLV-07: no rider was found, and the student answers "cancel, full
     refund" N times at once (POST /orders/:id/unfulfilled).
  D  the same, but half the answers say "cancel" and half "I will collect it
     myself" - a full refund racing a delivery-fee-only refund.

Every round must leave exactly one ORDER_RELEASE row for the order, and the
student's balance must have come back by exactly that one release: to where
it was before the order for a cancellation, or short by the food's price when
they chose to collect it.

For C and D the order is placed and accepted by the shop through the API, and
its task is then set to UNFULFILLED by SQL. Getting there for real takes three
expired sixty-second broadcast rounds per order; this is the same shortcut
race-stress.py takes when it inserts a task that is already BROADCASTING.

    python3 apps/api/test/race-refund.py [BASE]      (N=6 ROUNDS=20 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

N = h.env_int("N", 6)
ROUNDS = h.env_int("ROUNDS", 20)


def run() -> int:
    tally = h.Tally("race-refund", N, ROUNDS)
    students = h.RACERS
    total = h.quote_total(students[0])
    listing = h.catalog()["listing_id"]
    print(f"Refund race: {N} parallel requests on one WALLET order of {total} paise, {ROUNDS} rounds "
          f"(variants in rotation: A cancel x N, B cancel vs reject, C unfulfilled cancel x N, "
          f"D unfulfilled cancel vs collect).")

    funded = {}
    since = h.db_now()
    for n in range(1, ROUNDS + 1):
        student = students[n % len(students)]
        uid = h.user_id(student)
        where = f"round {n}"
        funded.setdefault(student, h.balance(uid))
        # Top up before every order, not once: a round where "collect it
        # myself" wins spends the food's price for real.
        short = total - h.balance(uid)
        if short > 0:
            h.adjust_wallet(uid, short, f"race-refund {h.RUN} fixture: funds one order")

        b0 = h.balance(uid)
        s0 = h.ledger_sum(uid)
        order_id, task_id = h.place_order(student, "WALLET", total)
        held = h.balance(uid)
        if held != b0 - total:
            tally.fail(where, f"placement did not hold the total: balance {b0} -> {held}, expected {b0 - total}")

        variant = "ABCD"[(n - 1) % 4]
        label = {"A": "cancel x N", "B": "cancel vs reject", "C": "unfulfilled: cancel x N",
                 "D": "unfulfilled: cancel vs collect"}[variant]
        fee = int(h.psql(f'SELECT delivery_fee_minor FROM "order" WHERE id={h.q(order_id)}'))
        calls = []
        if variant in "CD":
            status, body = h.http("POST", f"/shops/{listing}/orders/{order_id}/accept", h.login(h.SHOP_OWNER),
                                  {"prepMinutes": 60})   # an hour: the dispatcher will not touch it
            if status != 200:
                raise RuntimeError(f"shop accept failed: {status} {body.get('code')} {body.get('message')}")
            moved = h.psql(f"UPDATE task SET status='UNFULFILLED', offer_expires_at=NULL, updated_at=now() "
                           f"WHERE id={h.q(task_id)} AND status='CREATED' RETURNING 1")
            if moved != "1":
                raise RuntimeError(f"could not put task {task_id} into UNFULFILLED for the fixture")
            if variant == "D":
                # "Collect it myself" is only offered once the food is ready.
                status, body = h.http("POST", f"/shops/{listing}/orders/{order_id}/ready", h.login(h.SHOP_OWNER), {})
                if status != 200:
                    raise RuntimeError(f"shop ready failed: {status} {body.get('code')} {body.get('message')}")
                if h.psql(f"SELECT status FROM task WHERE id={h.q(task_id)}") != "UNFULFILLED":
                    raise RuntimeError(f"task {task_id} left UNFULFILLED before the race; fixture is not valid")
        for i in range(N):
            if variant == "B" and i % 2 == 1:
                calls.append(h.Call("shop reject", "POST", f"/shops/{listing}/orders/{order_id}/reject",
                                    h.SHOP_OWNER, {"reason": f"race harness {h.RUN}"}, route="reject"))
            elif variant in "AB":
                calls.append(h.Call("student cancel", "POST", f"/orders/{order_id}/cancel",
                                    student, {"reason": f"race harness {h.RUN}"}, route="cancel"))
            elif variant == "D" and i % 2 == 1:
                calls.append(h.Call("unfulfilled: collect", "POST", f"/orders/{order_id}/unfulfilled",
                                    student, {"choice": "COLLECT_IN_PERSON"}, route="unfulfilled"))
            else:
                calls.append(h.Call("unfulfilled: cancel", "POST", f"/orders/{order_id}/unfulfilled",
                                    student, {"choice": "CANCEL"}, route="unfulfilled"))
        results = tally.fire(where, calls)

        wins = [r for r in results if r.ok]
        releases = h.rows(f"order_id={h.q(order_id)} AND type='ORDER_RELEASE'")
        holds = h.rows(f"order_id={h.q(order_id)} AND type='ORDER_HOLD'")
        released_minor = int(h.psql("SELECT COALESCE(SUM(amount_minor),0) FROM wallet_entry "
                                    f"WHERE order_id={h.q(order_id)} AND type='ORDER_RELEASE'"))
        b1 = h.balance(uid)
        s1 = h.ledger_sum(uid)
        order_status, payment_status = h.psql(
            f'SELECT status || \',\' || payment_status FROM "order" WHERE id={h.q(order_id)}').split(",")
        captures = h.rows(f"order_id={h.q(order_id)} AND type='ORDER_CAPTURE'")
        task_status = h.psql(f"SELECT status FROM task WHERE id={h.q(task_id)}")
        tally.note_rows(f"{variant} ORDER_RELEASE", releases)
        tally.note_rows("ORDER_HOLD", holds)

        # What one, and only one, release should have returned.
        collected = variant == "D" and order_status == "COMPLETED"
        due_back = fee if collected else total

        problems = []
        if releases != 1:
            problems.append(f"{releases} ORDER_RELEASE rows for the order (must be exactly 1)")
        if released_minor != due_back:
            problems.append(f"released {released_minor} paise in total; exactly {due_back} was due back")
        if holds != 1:
            problems.append(f"{holds} ORDER_HOLD rows")
        if b1 != b0 - total + due_back:
            problems.append(f"balance {b0} before the order, {b1} after the refund "
                            f"(must be {b0 - total + due_back})")
        if (s1 - s0) != due_back - total:
            problems.append(f"ledger arithmetic moved by {s1 - s0} paise across hold and refund "
                            f"(must be {due_back - total})")
        if len(wins) != 1:
            problems.append(f"{len(wins)} requests answered 200 (must be exactly 1)")
        if collected:
            if task_status not in ("COMPLETED", "CANCELLED"):
                problems.append(f"collected in person but the task is {task_status}")
            # The food was paid for from the hold: captured, with a zero-amount marker.
            if payment_status != "CAPTURED":
                problems.append(f"collected in person but payment_status is {payment_status} (must be CAPTURED)")
            if captures != 1:
                problems.append(f"{captures} ORDER_CAPTURE rows for a collected order (must be exactly 1)")
        else:
            # A cancelled wallet order has had its money returned, and says so.
            if payment_status != "REFUNDED":
                problems.append(f"refunded in full but payment_status is {payment_status} (must be REFUNDED)")
            if captures:
                problems.append(f"{captures} ORDER_CAPTURE row(s) on an order that was refunded in full")
        tally.note_rows(f"payment_status {payment_status}", 1)
        if not collected and (order_status != "CANCELLED" or task_status != "CANCELLED"):
            problems.append(f"order {order_status}, task {task_status} (both must be CANCELLED)")
        for p in problems:
            tally.fail(f"{where} ({label}) order {order_id}", p)
        tally.rounds_run += 1
        h.progress(not problems)

    h.check_ledger(tally, list(funded), since)
    for student, before in funded.items():
        # Leave every wallet as it was found.
        h.set_balance(h.user_id(student), before, f"race-refund {h.RUN} fixture: returned")

    return tally.finish("every wallet order was refunded exactly once: one ORDER_RELEASE row, "
                        "balance restored to the paise, one 200 per round.")


h.main(run)
