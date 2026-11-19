#!/usr/bin/env python3
"""
Race the spending of one wallet balance.

The student's wallet is brought to exactly the price of one order, then N
WALLET placements are fired at once. There is money for one. A
read-then-write implementation lets every request read the same balance, pass
the same check and place its own order - the same paise held N times and a
balance driven below zero in a ledger that cannot be corrected.

Every round must leave exactly one new order, exactly one ORDER_HOLD row, a
balance of exactly zero, and no ledger row with a negative running total.

    python3 apps/api/test/race-wallet-spend.py [BASE]      (N=5 ROUNDS=20 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

N = h.env_int("N", 5)
ROUNDS = h.env_int("ROUNDS", 20)


def run() -> int:
    tally = h.Tally("race-wallet-spend", N, ROUNDS)
    students = h.RACERS
    total = h.quote_total(students[0])
    print(f"Wallet-spend race: {N} parallel WALLET placements against a balance of exactly "
          f"{total} paise (one order's worth), {ROUNDS} rounds.")

    original = {}
    since = h.db_now()
    for n in range(1, ROUNDS + 1):
        student = students[n % len(students)]
        uid = h.user_id(student)
        where = f"round {n}"
        before = h.set_balance(uid, total, f"race-wallet-spend {h.RUN} fixture: exactly one order's worth")
        original.setdefault(student, before)

        mark = h.psql("SELECT (now() AT TIME ZONE 'utc')::text")
        orders_before = int(h.psql(f'SELECT count(*) FROM "order" WHERE student_id={h.q(uid)}'))
        s0 = h.ledger_sum(uid)

        calls = [h.Call("wallet place", "POST", "/orders", student, h.order_body("WALLET", total), route="place")
                 for _ in range(N)]
        results = tally.fire(where, calls)

        wins = [r for r in results if r.ok]
        new_orders = int(h.psql(f'SELECT count(*) FROM "order" WHERE student_id={h.q(uid)}')) - orders_before
        holds = h.rows(f"user_id={h.q(uid)} AND type='ORDER_HOLD' AND created_at >= {h.q(mark)}")
        negative = h.rows(f"user_id={h.q(uid)} AND balance_after_minor < 0 AND created_at >= {h.q(mark)}")
        b1 = h.balance(uid)
        s1 = h.ledger_sum(uid)
        tally.note_rows("ORDER_HOLD", holds)
        tally.note_rows("new orders", new_orders)
        tally.note_rows("negative-balance rows", negative)

        problems = []
        if len(wins) != 1:
            problems.append(f"{len(wins)} placements answered 201 with money for one (must be exactly 1)")
        if holds != 1:
            problems.append(f"{holds} ORDER_HOLD rows (must be exactly 1)")
        if new_orders != 1:
            problems.append(f"{new_orders} orders created (must be exactly 1; a refused placement must leave nothing)")
        if negative:
            problems.append(f"{negative} ledger row(s) with a negative running balance")
        if b1 != 0:
            problems.append(f"balance is {b1} after spending exactly {total} (must be 0)")
        if s1 - s0 != -total:
            problems.append(f"ledger arithmetic moved by {s1 - s0} paise (must be {-total})")
        refused = {r.code for r in results if not r.ok and r.status < 500}
        if refused - {"INSUFFICIENT_WALLET_BALANCE"}:
            problems.append(f"losers were refused with {sorted(refused)}, expected INSUFFICIENT_WALLET_BALANCE")
        for p in problems:
            tally.fail(where, p)
        tally.rounds_run += 1
        h.progress(not problems)

        # Cancel whatever was placed, so the hold comes back and the next
        # round starts from money rather than from a pile of open orders.
        for r in wins:
            h.http("POST", f"/orders/{r.body['orderId']}/cancel", h.login(student),
                   {"reason": f"race harness {h.RUN} cleanup"})
        for oid in h.psql(f'SELECT id FROM "order" WHERE student_id={h.q(uid)} AND status=\'PLACED\' '
                          f"AND student_note LIKE 'race harness {h.RUN}%'").split():
            h.http("POST", f"/orders/{oid}/cancel", h.login(student), {"reason": f"race harness {h.RUN} cleanup"})

    h.check_ledger(tally, list(original), since)
    for student, before in original.items():
        h.set_balance(h.user_id(student), before, f"race-wallet-spend {h.RUN} fixture: returned")

    return tally.finish("a balance that covers one order bought exactly one order in every round: "
                        "one 201, one ORDER_HOLD, no orphan order, balance never below zero.")


h.main(run)
