#!/usr/bin/env python3
"""
Race the student's cancel against the accept-window sweep.

A shop that never answers an order has it cancelled for them: every thirty
seconds DispatchService.sweepUnacceptedOrders cancels any order still PLACED
after the college's accept window and, for a WALLET order, releases the hold.
That is a second writer of ORDER_RELEASE, on a timer, in a different module
from the student's own cancel - and a student who gives up waiting does so at
about the moment the window runs out.

Each round places K WALLET orders, makes them old enough for the sweep, and
sends one student cancel per order spread across the instant the sweep runs.
Whoever wins each order, it must be refunded once: one ORDER_RELEASE for the
total, payment_status REFUNDED, order and task CANCELLED, the student told
200 if and only if it was their cancel that did it, and every wallet back
where it started.

How the timing is done, since nothing in the API can be asked to run the
sweep: it is a cron on the wall clock (seconds :00 and :30). The harness
places the orders, then two seconds before the next tick moves their
placed_at back past the accept window with one SQL UPDATE - the window itself
(college_config.shop_accept_window_seconds, 300 by default) is left alone, as
is every other order - and releases the cancels around the tick. The harness
and the API must share a clock, which they do on one machine. The spread of
the cancels is adjusted from round to round until both sides have won.

    python3 apps/api/test/race-sweep-cancel.py [BASE]      (K=10 ROUNDS=4 by default)
"""
import os
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

K = h.env_int("K", 10)
ROUNDS = h.env_int("ROUNDS", 4)
TICK_S = 30            # CronExpression.EVERY_30_SECONDS on sweepUnacceptedOrders


def run() -> int:
    tally = h.Tally("race-sweep-cancel", K, ROUNDS)
    total = h.quote_total(h.RACERS[0])
    window = int(h.psql("SELECT shop_accept_window_seconds FROM college_config "
                        f"WHERE college_id={h.q(h.college_id())}"))
    print(f"Sweep-vs-cancel race: {K} WALLET orders per round, one student cancel each, released around "
          f"the accept-window sweep's tick. {ROUNDS} rounds (up to {TICK_S}s each). Accept window {window}s.")

    since = h.db_now()
    per_student = -(-K // len(h.RACERS))
    start_balance = {}
    for e in h.RACERS:
        uid = h.user_id(e)
        start_balance[e] = h.balance(uid)
        short = per_student * total - start_balance[e]
        if short > 0:
            h.adjust_wallet(uid, short, f"race-sweep-cancel {h.RUN} fixture: funds {per_student} wallet order(s)")

    won = {"STUDENT": 0, "SYSTEM": 0}
    lead_ms = 40          # how long before the tick the first cancel leaves
    for n in range(1, ROUNDS + 1):
        where = f"round {n}"
        b0 = {e: h.balance(h.user_id(e)) for e in h.RACERS}
        s0 = {e: h.ledger_sum(h.user_id(e)) for e in h.RACERS}
        orders = []
        for i in range(K):
            student = h.RACERS[i % len(h.RACERS)]
            order_id, task_id = h.place_order(student, "WALLET", total)
            orders.append((student, order_id, task_id))

        # The next tick that is comfortably far enough away to set up for.
        tick = (int(time.time() + 6) // TICK_S + 1) * TICK_S
        time.sleep(max(0.0, tick - 2.0 - time.time()))
        ids = ",".join(h.q(o) for _, o, _ in orders)
        h.psql(f'UPDATE "order" SET placed_at = placed_at - interval \'{window + 5} seconds\' '
               f"WHERE id IN ({ids}) AND status='PLACED'")

        step = 18   # ms between consecutive cancels
        calls = [h.Call("student cancel", "POST", f"/orders/{order_id}/cancel", student,
                        {"reason": f"race harness {h.RUN}"}, route="cancel", delay_ms=i * step)
                 for i, (student, order_id, _task) in enumerate(orders)]
        time.sleep(max(0.0, tick - lead_ms / 1000.0 - 0.02 - time.time()))
        results = tally.fire(where, calls)
        time.sleep(2.5)   # let the sweep finish its pass

        round_won = {"STUDENT": 0, "SYSTEM": 0}
        ok_round = True
        for (student, order_id, task_id), r in zip(orders, results):
            status, by, payment = h.psql(
                'SELECT status || \',\' || COALESCE(cancelled_by::text, \'-\') || \',\' || payment_status '
                f'FROM "order" WHERE id={h.q(order_id)}').split(",")
            task_status = h.psql(f"SELECT status FROM task WHERE id={h.q(task_id)}")
            releases = h.rows(f"order_id={h.q(order_id)} AND type='ORDER_RELEASE'")
            released = int(h.psql("SELECT COALESCE(SUM(amount_minor),0) FROM wallet_entry "
                                  f"WHERE order_id={h.q(order_id)} AND type='ORDER_RELEASE'"))
            tally.note_rows(f"cancelled by {by}: ORDER_RELEASE", releases)
            problems = []
            if releases != 1 or released != total:
                problems.append(f"{releases} ORDER_RELEASE row(s) totalling {released} paise "
                                f"(must be 1 for {total})")
            if status != "CANCELLED" or task_status != "CANCELLED":
                problems.append(f"order {status}, task {task_status} (both must be CANCELLED)")
            if payment != "REFUNDED":
                problems.append(f"payment_status is {payment} after the refund (must be REFUNDED) [cancelled by {by}]")
            if by not in round_won:
                problems.append(f"cancelled_by is {by}")
            else:
                round_won[by] += 1
                if by == "STUDENT" and not r.ok:
                    problems.append(f"the student's cancel took effect but they were told {r.key}")
                if by == "SYSTEM" and r.ok:
                    problems.append("the sweep cancelled the order but the student's cancel was also told 200")
                if by == "SYSTEM" and r.status < 500 and r.code not in (
                        "TOO_LATE_TO_CANCEL", "ORDER_STATE_CHANGED") and r.code not in h.DB_CAUGHT:
                    problems.append(f"the student lost to the sweep and was told {r.key}")
            for p in problems:
                tally.fail(f"{where} order {order_id}", p)
            ok_round = ok_round and not problems

        for e in h.RACERS:
            uid = h.user_id(e)
            if h.balance(uid) != b0[e] or h.ledger_sum(uid) != s0[e]:
                tally.fail(where, f"{e}: balance {b0[e]} -> {h.balance(uid)}, ledger moved by "
                                  f"{h.ledger_sum(uid) - s0[e]} after every order was refunded (must be unchanged)")
                ok_round = False
        for k in won:
            won[k] += round_won[k]
        sys.stdout.write(f"[student {round_won['STUDENT']} / sweep {round_won['SYSTEM']}]")
        # Steer towards an even split: if the students won everything they
        # left too early, if the sweep did they left too late.
        if round_won["SYSTEM"] == 0:
            lead_ms = max(-400, lead_ms - 60)
        elif round_won["STUDENT"] == 0:
            lead_ms = min(400, lead_ms + 60)
        tally.rounds_run += 1
        h.progress(ok_round)

    h.check_ledger(tally, h.RACERS, since)
    for e in h.RACERS:
        uid = h.user_id(e)
        now = h.balance(uid)
        if now > start_balance[e] and now == max(start_balance[e], per_student * total):
            h.adjust_wallet(uid, start_balance[e] - now, f"race-sweep-cancel {h.RUN} fixture: returned")

    split = f"the student's cancel won {won['STUDENT']} order(s), the sweep won {won['SYSTEM']}"
    print(f"\nwho won: {split}")
    if won["SYSTEM"] == 0 or won["STUDENT"] == 0:
        tally.invalid.append(f"one side never won ({split}): the two writers were not really raced. "
                             "Is the dispatcher's cron running, and do the harness and the API share a clock?")
    return tally.finish(f"an order cancelled by its student and by the accept-window sweep at once was "
                        f"refunded exactly once ({split}).")


h.main(run)
