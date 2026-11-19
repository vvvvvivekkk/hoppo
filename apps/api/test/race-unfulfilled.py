#!/usr/bin/env python3
"""
Race the three answers to "no rider was found" (FR-DLV-07).

When every broadcast round has expired, the student is offered three choices
on POST /orders/:id/unfulfilled: KEEP_WAITING, COLLECT_IN_PERSON, or CANCEL.
Each ends the question, and two of them move money: CANCEL releases the whole
wallet hold, COLLECT_IN_PERSON releases the delivery fee and captures the
rest. A student who taps twice, or a client that retries, must get exactly one
of them.

The fixture is real, which is why this harness is slow: WALLET orders are
placed, accepted and readied by the shop with no rider online, and the
harness then waits for the dispatcher to run its rounds out (three
sixty-second windows with the seeded config - about three and a half
minutes, once, for all the orders together). race-refund.py covers the same
endpoints quickly by setting the task to UNFULFILLED with SQL; this one also
has real broadcast_log history behind each task, which is what KEEP_WAITING
has to leave intact.

Each round fires N requests carrying two different choices, one of them with
a short head start, rotating so that each choice gets its turn to win:

  CANCEL wins             one ORDER_RELEASE of the full total, payment_status
                          REFUNDED, order and task CANCELLED
  COLLECT_IN_PERSON wins  one ORDER_RELEASE of the delivery fee, one
                          ORDER_CAPTURE of 0, payment_status CAPTURED, order
                          COMPLETED
  KEEP_WAITING wins       no ledger entry at all, the task back on its way to
                          riders, every earlier broadcast_log row still there
                          and none of them left PENDING

    python3 apps/api/test/race-unfulfilled.py [BASE]      (N=6 ROUNDS=6 by default)
"""
import os
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

N = h.env_int("N", 6)
ROUNDS = h.env_int("ROUNDS", 6)
HEAD_START_MS = h.env_int("HEAD_START_MS", 25)
# (the choice given the head start, the choice it races)
MIXES = [("CANCEL", "KEEP_WAITING"), ("COLLECT_IN_PERSON", "CANCEL"), ("KEEP_WAITING", "COLLECT_IN_PERSON")]


def run() -> int:
    tally = h.Tally("race-unfulfilled", N, ROUNDS)
    total = h.quote_total(h.RACERS[0])
    listing = h.catalog()["listing_id"]
    owner = h.login(h.SHOP_OWNER)
    cfg = h.psql("SELECT acceptance_window_seconds || ',' || max_broadcast_rounds FROM college_config "
                 f"WHERE college_id={h.q(h.college_id())}").split(",")
    budget = int(cfg[0]) * int(cfg[1]) + 90
    print(f"Unfulfilled race: {N} parallel answers (two different choices) per order, {ROUNDS} orders. "
          f"Waiting up to {budget}s for the dispatcher to exhaust {cfg[1]} rounds of {cfg[0]}s first.")

    # Nobody may be eligible, or the orders get delivered instead.
    h.free_riders(h.RACERS)
    for e in h.RACERS + ["srichandana@anurag.edu.in"]:
        h.http("POST", "/rider/work-mode", h.login(e), {"enabled": False})

    since = h.db_now()
    per_student = -(-ROUNDS // len(h.RACERS))
    for e in h.RACERS:
        uid = h.user_id(e)
        short = per_student * total - h.balance(uid)
        if short > 0:
            h.adjust_wallet(uid, short, f"race-unfulfilled {h.RUN} fixture: funds {per_student} wallet order(s)")

    fixtures = []
    for n in range(ROUNDS):
        student = h.RACERS[n % len(h.RACERS)]
        order_id, task_id = h.place_order(student, "WALLET", total)
        for step, body in (("accept", {"prepMinutes": 1}), ("ready", {})):
            status, res = h.http("POST", f"/shops/{listing}/orders/{order_id}/{step}", owner, body)
            if status != 200:
                raise RuntimeError(f"shop {step} failed: {status} {res.get('code')} {res.get('message')}")
        fixtures.append((student, order_id, task_id))

    ids = ",".join(h.q(t) for _, _, t in fixtures)
    deadline = time.time() + budget
    while time.time() < deadline:
        waiting = int(h.psql(f"SELECT count(*) FROM task WHERE id IN ({ids}) AND status <> 'UNFULFILLED'"))
        if waiting == 0:
            break
        sys.stdout.write(f"[{waiting} still on offer]")
        sys.stdout.flush()
        time.sleep(20)
    else:
        states = h.psql(f"SELECT status || ' x' || count(*) FROM task WHERE id IN ({ids}) GROUP BY status")
        raise h.Blocked(f"the tasks did not all reach UNFULFILLED within {budget}s ({states.replace(chr(10), ', ')}); "
                        "is a rider online, or the dispatcher not running?")
    print()

    winners = {"CANCEL": 0, "COLLECT_IN_PERSON": 0, "KEEP_WAITING": 0}
    for n, (student, order_id, task_id) in enumerate(fixtures, start=1):
        uid = h.user_id(student)
        first, second = MIXES[(n - 1) % len(MIXES)]
        where = f"round {n} ({first} with a {HEAD_START_MS} ms head start vs {second})"
        fee = int(h.psql(f'SELECT delivery_fee_minor FROM "order" WHERE id={h.q(order_id)}'))
        b0, s0 = h.balance(uid), h.ledger_sum(uid)
        log_before = h.psql(f"SELECT id FROM broadcast_log WHERE task_id={h.q(task_id)} ORDER BY id").split()

        calls = []
        for i in range(N):
            choice = first if i % 2 == 0 else second
            calls.append(h.Call(f"answer {choice}", "POST", f"/orders/{order_id}/unfulfilled", student,
                                {"choice": choice}, route="unfulfilled",
                                delay_ms=0 if choice == first else HEAD_START_MS))
        results = tally.fire(where, calls)

        wins = [r for r in results if r.ok]
        won = wins[0].body.get("choice") if len(wins) == 1 else None
        if won is None and len(wins) == 1:
            won = wins[0].call.body["choice"]
        releases = h.rows(f"order_id={h.q(order_id)} AND type='ORDER_RELEASE'")
        released = int(h.psql("SELECT COALESCE(SUM(amount_minor),0) FROM wallet_entry "
                              f"WHERE order_id={h.q(order_id)} AND type='ORDER_RELEASE'"))
        captures = h.rows(f"order_id={h.q(order_id)} AND type='ORDER_CAPTURE'")
        captured = int(h.psql("SELECT COALESCE(SUM(amount_minor),0) FROM wallet_entry "
                              f"WHERE order_id={h.q(order_id)} AND type='ORDER_CAPTURE'"))
        order_status, payment = h.psql(
            f'SELECT status || \',\' || payment_status FROM "order" WHERE id={h.q(order_id)}').split(",")
        task_status = h.psql(f"SELECT status FROM task WHERE id={h.q(task_id)}")
        log_after = h.psql(f"SELECT id FROM broadcast_log WHERE task_id={h.q(task_id)} ORDER BY id").split()
        stale_pending = int(h.psql(
            f"SELECT count(*) FROM broadcast_log WHERE task_id={h.q(task_id)} AND outcome='PENDING' "
            f"AND id IN ({','.join(h.q(i) for i in log_before) or 'NULL'})"))
        b1, s1 = h.balance(uid), h.ledger_sum(uid)
        tally.note_rows(f"won by {won}: ORDER_RELEASE", releases)

        problems = []
        if len(wins) != 1:
            problems.append(f"{len(wins)} answers got a 200 (must be exactly 1): "
                            f"{[r.call.body['choice'] for r in wins]}")
        refused = {r.code for r in results if not r.ok and r.status < 500} - h.DB_CAUGHT
        if refused - {"NOT_UNFULFILLED", "ORDER_STATE_CHANGED", "ORDER_NOT_READY"}:
            problems.append(f"losers were refused with {sorted(refused)}")
        if set(log_before) - set(log_after):
            problems.append(f"{len(set(log_before) - set(log_after))} broadcast_log row(s) were deleted")

        if won == "CANCEL":
            winners[won] += 1
            expect = dict(releases=1, released=total, captures=0, order="CANCELLED", payment="REFUNDED", gain=total)
            if task_status != "CANCELLED":
                problems.append(f"cancelled but the task is {task_status}")
        elif won == "COLLECT_IN_PERSON":
            winners[won] += 1
            expect = dict(releases=1, released=fee, captures=1, order="COMPLETED", payment="CAPTURED", gain=fee)
            if captured != 0:
                problems.append(f"the capture marker moved {captured} paise (must be 0)")
        elif won == "KEEP_WAITING":
            winners[won] += 1
            expect = dict(releases=0, released=0, captures=0, order="READY", payment="HELD", gain=0)
            if task_status not in ("CREATED", "BROADCASTING"):
                problems.append(f"kept waiting but the task is {task_status} (must be back on its way to riders)")
            if stale_pending:
                problems.append(f"{stale_pending} broadcast_log row(s) from the finished search are still PENDING")
        else:
            expect = None
        if expect:
            if releases != expect["releases"] or released != expect["released"]:
                problems.append(f"{won}: {releases} ORDER_RELEASE row(s) totalling {released} paise "
                                f"(must be {expect['releases']} totalling {expect['released']})")
            if captures != expect["captures"]:
                problems.append(f"{won}: {captures} ORDER_CAPTURE row(s) (must be {expect['captures']})")
            if order_status != expect["order"]:
                problems.append(f"{won}: order is {order_status} (must be {expect['order']})")
            if payment != expect["payment"]:
                problems.append(f"{won}: payment_status is {payment} (must be {expect['payment']})")
            if b1 - b0 != expect["gain"] or s1 - s0 != expect["gain"]:
                problems.append(f"{won}: balance moved by {b1 - b0}, ledger by {s1 - s0} "
                                f"(both must be {expect['gain']})")
        for p in problems:
            tally.fail(f"{where} order {order_id}", p)
        tally.rounds_run += 1
        h.progress(not problems)
        if won == "KEEP_WAITING":
            # Checked; now close it, or it is re-broadcast for three more
            # minutes to whichever rider goes online next.
            h.close_open_order(student, order_id, task_id)

    h.check_ledger(tally, h.RACERS, since)
    split = ", ".join(f"{k} won {v}" for k, v in winners.items())
    print(f"\nwho won: {split}")
    missing = [k for k, v in winners.items() if v == 0]
    if missing and ROUNDS >= len(MIXES):
        tally.invalid.append(f"{', '.join(missing)} never won a round, so that outcome's assertions never ran "
                             f"(raise HEAD_START_MS or ROUNDS)")
    return tally.finish(f"an unfulfilled order answered {N} times at once was settled exactly once, "
                        f"whichever answer won ({split}).")


h.main(run)
