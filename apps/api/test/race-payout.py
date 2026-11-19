#!/usr/bin/env python3
"""
Race the payout of one delivery.

An order is driven to PICKED_UP through the real flow - placed, accepted and
readied by the shop, offered by the dispatcher, accepted and picked up by a
rider - and the student's handover code is obtained the way their screen gets
it (POST /tasks/:id/handover-code/reissue). Then the rider submits the correct
code N times at once: a double tap, or a retry after a timeout.

A read-then-write completion lets every request see PICKED_UP, and each then
credits the delivery fee and counts a completed task. The ledger is
append-only, so a rider paid twice stays paid twice.

Every round must leave exactly one DELIVERY_FEE_EARNED row for the task, the
rider's completed-task count up by exactly one, and exactly one 200.

Odd rounds are CASH orders, even rounds WALLET orders (the student's wallet is
funded by one ADJUSTMENT row for those).

    python3 apps/api/test/race-payout.py [BASE]      (N=6 ROUNDS=10 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

N = h.env_int("N", 6)
ROUNDS = h.env_int("ROUNDS", 10)
METHODS = [m for m in os.environ.get("METHODS", "CASH,WALLET").split(",") if m]


def completed(uid: str) -> int:
    out = h.psql(f"SELECT tasks_completed FROM rider_reliability WHERE user_id={h.q(uid)}")
    return int(out) if out else 0


def run() -> int:
    tally = h.Tally("race-payout", N, ROUNDS)
    total = h.quote_total(h.RACERS[0])
    print(f"Payout race: {N} parallel correct handover codes on one PICKED_UP task, {ROUNDS} rounds, "
          f"payment methods {METHODS}.")
    h.free_riders(h.RACERS)
    n = 0
    since = h.db_now()

    with h.Riders(h.RACERS):
        for batch in h.batches(ROUNDS, METHODS):
            for fx in h.prepare_carried_orders(batch, total):
                n += 1
                where = f"round {n} ({fx['method']})"
                rid, sid = h.user_id(fx["rider"]), h.user_id(fx["student"])
                task, order = fx["task_id"], fx["order_id"]
                fee = int(h.psql(f"SELECT fee_minor FROM task WHERE id={h.q(task)}"))
                done0, rider_b0, student_b0 = completed(rid), h.balance(rid), h.balance(sid)

                calls = [h.Call("handover", "POST", f"/rider/tasks/{task}/handover", fx["rider"],
                                {"code": fx["code"]}, route="handover") for _ in range(N)]
                results = tally.fire(where, calls)

                wins = [r for r in results if r.ok]
                fees = h.rows(f"task_id={h.q(task)} AND type='DELIVERY_FEE_EARNED'")
                captures = h.rows(f"order_id={h.q(order)} AND type='ORDER_CAPTURE'")
                done1, rider_b1, student_b1 = completed(rid), h.balance(rid), h.balance(sid)
                task_status = h.psql(f"SELECT status FROM task WHERE id={h.q(task)}")
                order_status = h.psql(f'SELECT status FROM "order" WHERE id={h.q(order)}')
                holding = h.psql(f"SELECT COALESCE(active_task_id,'NULL') FROM rider_state WHERE user_id={h.q(rid)}")
                tally.note_rows(f"{fx['method']} DELIVERY_FEE_EARNED", fees)
                tally.note_rows(f"{fx['method']} tasksCompleted delta", done1 - done0)
                if fx["method"] == "WALLET":
                    tally.note_rows("WALLET ORDER_CAPTURE", captures)

                problems = []
                if fees != 1:
                    problems.append(f"{fees} DELIVERY_FEE_EARNED rows for the task (must be exactly 1)")
                if done1 - done0 != 1:
                    problems.append(f"tasksCompleted moved by {done1 - done0} (must be exactly 1)")
                if len(wins) != 1:
                    problems.append(f"{len(wins)} handovers answered 200 (must be exactly 1)")
                # ADR-006: a cash fee is a statement line and leaves the balance alone.
                expected_gain = fee if fx["method"] == "WALLET" else 0
                if rider_b1 - rider_b0 != expected_gain:
                    problems.append(f"rider balance moved by {rider_b1 - rider_b0} paise, expected {expected_gain}")
                if fx["method"] == "WALLET":
                    if captures != 1:
                        problems.append(f"{captures} ORDER_CAPTURE rows (must be exactly 1)")
                    if student_b1 != student_b0:
                        problems.append(f"student balance moved by {student_b1 - student_b0} at handover (must be 0)")
                if task_status != "COMPLETED" or order_status != "COMPLETED":
                    problems.append(f"task {task_status}, order {order_status} (both must be COMPLETED)")
                if holding != "NULL":
                    problems.append(f"rider still holds {holding} after completing")
                unexplained = {r.code for r in results if not r.ok and r.status < 500} - {
                    "NOT_AWAITING_HANDOVER", "OTP_ATTEMPTS_EXHAUSTED"}
                if unexplained:
                    problems.append(f"unexpected refusals {sorted(unexplained)}")
                for p in problems:
                    tally.fail(f"{where} task {task}", p)
                tally.rounds_run += 1
                h.progress(not problems)

    h.check_ledger(tally, h.RACERS, since)
    return tally.finish("a delivery completed N times at once was paid exactly once in every round: "
                        "one DELIVERY_FEE_EARNED row, tasksCompleted +1, one 200.")


h.main(run)
