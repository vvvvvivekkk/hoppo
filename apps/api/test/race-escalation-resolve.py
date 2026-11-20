#!/usr/bin/env python3
"""
Race two administrators resolving the same escalated delivery (FR-ADM-04).

A delivery whose handover code was entered wrongly too many times is ESCALATED
and waits for an administrator to say what happened: DELIVERED (the rider is
paid, exactly as if the code had been right) or NOT_DELIVERED (task and order
cancelled, the rider paid nothing). Two administrators looking at the same
list can both press a button - and they need not press the same one. A
read-then-write resolve pays the rider and cancels the order, or pays twice.

Each round carries a real order to PICKED_UP, spends the configured number of
wrong codes to escalate it, and then fires N resolves at once from two
administrators of the same college. The pairing rotates: DELIVERED against
NOT_DELIVERED (with the head start alternating so each gets to win), all
DELIVERED (the double-payout race), all NOT_DELIVERED (the double-refund
race). Orders alternate CASH and WALLET; an outcome the server does not offer
for that task (GET /admin/escalations/:id `canResolveAs`) is not sent.

Every round must leave: exactly one 200; the task and order in the state that
one answer describes; at most one DELIVERY_FEE_EARNED row (one if DELIVERED
won, none otherwise) and the rider's completed count moved to match; exactly
one TASK_RESOLVED audit row, carrying the winner's note; and the escalation
reading back as resolved with nothing left to choose.

    python3 apps/api/test/race-escalation-resolve.py [BASE]      (N=6 ROUNDS=6 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

N = h.env_int("N", 6)
ROUNDS = h.env_int("ROUNDS", 6)
HEAD_START_MS = h.env_int("HEAD_START_MS", 15)
ADMINS = ["admin@anurag.edu.in", "admin2@anurag.edu.in"]
OTHER_ADMIN = "admin@rit.edu.in"


def completed(uid: str) -> int:
    out = h.psql(f"SELECT tasks_completed FROM rider_reliability WHERE user_id={h.q(uid)}")
    return int(out) if out else 0


def run() -> int:
    tally = h.Tally("race-escalation-resolve", N, ROUNDS)
    total = h.quote_total(h.RACERS[0])
    cap = int(h.psql(f"SELECT max_otp_attempts FROM college_config WHERE college_id={h.q(h.college_id())}"))
    print(f"Escalation-resolve race: {N} resolves at once from two administrators on one ESCALATED task, "
          f"{ROUNDS} rounds (odd CASH, even WALLET). Each task is escalated by {cap} wrong codes first.")
    h.free_riders(h.RACERS)
    won = {"DELIVERED": 0, "NOT_DELIVERED": 0}
    since = h.db_now()
    n = 0

    with h.Riders(h.RACERS):
        for batch in h.batches(ROUNDS, ["CASH", "WALLET"]):
            for fx in h.prepare_carried_orders(batch, total):
                n += 1
                task, order, rider = fx["task_id"], fx["order_id"], fx["rider"]
                rid = h.user_id(rider)
                wrong = "000000" if fx["code"] != "000000" else "111111"
                last = None
                for _ in range(cap):
                    h.make_room(rider, "handover", 1)
                    last = h.http("POST", f"/rider/tasks/{task}/handover", h.login(rider), {"code": wrong},
                                  who=rider, route="handover")
                if h.psql(f"SELECT status FROM task WHERE id={h.q(task)}") != "ESCALATED":
                    raise RuntimeError(f"task {task} did not escalate after {cap} wrong codes (last answer {last})")

                status, view = h.http("GET", f"/admin/escalations/{task}", h.login(ADMINS[0]))
                if status != 200:
                    raise RuntimeError(f"GET /admin/escalations/{task} -> {status} {view.get('code')}")
                offered = view.get("canResolveAs", [])
                status, res = h.http("POST", f"/admin/escalations/{task}/resolve", h.login(OTHER_ADMIN),
                                     {"outcome": "DELIVERED", "note": "Another college's admin must not be able to."})
                problems = []
                if status not in (403, 404):
                    problems.append(f"another college's admin resolving it got {status} {res.get('code')} (must be refused)")

                # Pairings in rotation: mixed, mixed (other head start), all DELIVERED, all NOT_DELIVERED.
                plan = ["MIXED_D", "MIXED_N", "ALL_D", "ALL_N", "MIXED_N", "MIXED_D"][(n - 1) % 6]
                if "NOT_DELIVERED" not in offered:
                    plan = "ALL_D"
                first = "DELIVERED" if plan == "MIXED_D" else "NOT_DELIVERED"
                where = f"round {n} ({fx['method']}, " + {
                    "MIXED_D": f"DELIVERED with a {HEAD_START_MS} ms head start vs NOT_DELIVERED",
                    "MIXED_N": f"NOT_DELIVERED with a {HEAD_START_MS} ms head start vs DELIVERED",
                    "ALL_D": "DELIVERED x N", "ALL_N": "NOT_DELIVERED x N"}[plan] + ")"
                fee = int(h.psql(f"SELECT fee_minor FROM task WHERE id={h.q(task)}"))
                sid = h.user_id(fx["student"])
                done0, bal0, student0 = completed(rid), h.balance(rid), h.balance(sid)
                order_total = int(h.psql(f'SELECT total_minor FROM "order" WHERE id={h.q(order)}'))
                calls = []
                for i in range(N):
                    if plan.startswith("MIXED"):
                        outcome = "DELIVERED" if i % 2 == 0 else "NOT_DELIVERED"
                    else:
                        outcome = "DELIVERED" if plan == "ALL_D" else "NOT_DELIVERED"
                    who = ADMINS[(i // 2) % 2] if not plan.startswith("MIXED") else ADMINS[i % 2]
                    calls.append(h.Call(f"resolve {outcome}", "POST", f"/admin/escalations/{task}/resolve", who,
                                        {"outcome": outcome, "note": f"race harness {h.RUN} round {n} request {i} {outcome}"},
                                        route="resolve",
                                        delay_ms=HEAD_START_MS if (plan.startswith("MIXED") and outcome != first) else 0))
                results = tally.fire(where, calls)

                wins = [r for r in results if r.ok]
                outcome = wins[0].call.body["outcome"] if len(wins) == 1 else None
                fees = h.rows(f"task_id={h.q(task)} AND type='DELIVERY_FEE_EARNED'")
                task_status = h.psql(f"SELECT status FROM task WHERE id={h.q(task)}")
                order_status, cancelled_by, payment = h.psql(
                    "SELECT status || ',' || COALESCE(cancelled_by::text,'-') || ',' || payment_status "
                    f'FROM "order" WHERE id={h.q(order)}').split(",")
                note = h.psql(f"SELECT COALESCE(resolution_note,'') FROM task WHERE id={h.q(task)}")
                audits = int(h.psql(f"SELECT count(*) FROM audit_log WHERE action='TASK_RESOLVED' AND target_id={h.q(task)}"))
                done1, bal1 = completed(rid), h.balance(rid)
                holding = h.psql(f"SELECT count(*) FROM rider_state WHERE active_task_id={h.q(task)}")
                tally.note_rows(f"won by {outcome}: DELIVERY_FEE_EARNED", fees)
                tally.note_rows("TASK_RESOLVED audit rows", audits)

                if len(wins) != 1:
                    problems.append(f"{len(wins)} resolves answered 200 (must be exactly 1): "
                                    f"{[r.call.body['outcome'] for r in wins]}")
                refused = {r.code for r in results if not r.ok and r.status < 500} - h.DB_CAUGHT
                if refused - {"ALREADY_RESOLVED"}:
                    problems.append(f"losers were refused with {sorted(refused)} (expected ALREADY_RESOLVED)")
                if fees > 1:
                    problems.append(f"the rider was paid {fees} times for one delivery")
                if audits != 1:
                    problems.append(f"{audits} TASK_RESOLVED audit rows (must be exactly 1)")
                elif len(wins) == 1:
                    actor = h.psql(f"SELECT actor_id FROM audit_log WHERE action='TASK_RESOLVED' AND target_id={h.q(task)}")
                    if actor != h.user_id(wins[0].call.email):
                        problems.append(f"the audit row names {actor}, but {wins[0].call.email} got the 200")
                releases = h.rows(f"order_id={h.q(order)} AND type='ORDER_RELEASE'")
                student1 = h.balance(sid)
                if outcome == "DELIVERED":
                    won[outcome] += 1
                    if (task_status, order_status) != ("COMPLETED", "COMPLETED"):
                        problems.append(f"DELIVERED won but task is {task_status}, order {order_status}")
                    if fees != 1 or done1 - done0 != 1:
                        problems.append(f"DELIVERED won: {fees} fee row(s), tasksCompleted moved by {done1 - done0} (must be 1 and +1)")
                    gain = fee if fx["method"] == "WALLET" else 0
                    if bal1 - bal0 != gain:
                        problems.append(f"DELIVERED won: rider balance moved by {bal1 - bal0}, expected {gain}")
                    if wins[0].body.get("riderFeeMinor") != fee or wins[0].body.get("status") != "COMPLETED":
                        problems.append(f"the 200 said riderFeeMinor={wins[0].body.get('riderFeeMinor')}, "
                                        f"status={wins[0].body.get('status')} (fee is {fee})")
                    if fx["method"] == "WALLET" and payment != "CAPTURED":
                        problems.append(f"DELIVERED won on a wallet order but payment_status is {payment}")
                elif outcome == "NOT_DELIVERED":
                    won[outcome] += 1
                    if (task_status, order_status, cancelled_by) != ("CANCELLED", "CANCELLED", "ADMIN"):
                        problems.append(f"NOT_DELIVERED won but task is {task_status}, order {order_status}, "
                                        f"cancelled by {cancelled_by}")
                    if fees != 0 or done1 - done0 != 0 or bal1 != bal0:
                        problems.append(f"NOT_DELIVERED won but the rider has {fees} fee row(s), tasksCompleted "
                                        f"+{done1 - done0}, balance moved by {bal1 - bal0}")
                    if wins[0].body.get("riderFeeMinor") != 0:
                        problems.append(f"the 200 said riderFeeMinor={wins[0].body.get('riderFeeMinor')} for NOT_DELIVERED")
                    if fx["method"] == "WALLET":
                        # The student paid from their wallet for food that did not arrive: all of it back, once.
                        if releases != 1 or student1 - student0 != order_total or payment != "REFUNDED":
                            problems.append(f"NOT_DELIVERED on a wallet order: {releases} ORDER_RELEASE row(s), student "
                                            f"balance moved by {student1 - student0} (order total {order_total}), "
                                            f"payment_status {payment}")
                        if wins[0].body.get("refundedMinor") != order_total:
                            problems.append(f"the 200 said refundedMinor={wins[0].body.get('refundedMinor')}, "
                                            f"the order total is {order_total}")
                    elif releases or student1 != student0:
                        problems.append(f"NOT_DELIVERED on a cash order moved wallet money: {releases} release row(s)")
                if outcome == "DELIVERED" and (releases or student1 != student0):
                    problems.append(f"DELIVERED won but the student's wallet moved by {student1 - student0} "
                                    f"({releases} ORDER_RELEASE row(s))")
                if any(i.get("taskId") == task for i in h.escalations(h.login(ADMINS[0]))):
                    problems.append("the resolved task is still in the escalations list")
                if outcome and note != wins[0].call.body["note"]:
                    problems.append(f"the stored resolution note is not the winner's: {note!r}")
                if holding != "0":
                    problems.append("a rider still holds the resolved task")
                status, after = h.http("GET", f"/admin/escalations/{task}", h.login(ADMINS[0]))
                if status != 200 or after.get("canResolveAs") != [] or after.get("status") not in ("COMPLETED", "CANCELLED"):
                    problems.append(f"read back after resolving: {status}, status {after.get('status')}, "
                                    f"canResolveAs {after.get('canResolveAs')}")
                for p in problems:
                    tally.fail(f"{where} task {task}", p)
                tally.rounds_run += 1
                h.progress(not problems)
            h.free_riders(h.RACERS)

    h.check_ledger(tally, h.RACERS, since)
    split = f"DELIVERED won {won['DELIVERED']}, NOT_DELIVERED won {won['NOT_DELIVERED']}"
    print(f"\nwho won: {split}")
    if ROUNDS >= 6 and (won["DELIVERED"] == 0 or won["NOT_DELIVERED"] == 0):
        tally.invalid.append(f"one outcome never won ({split}), so its assertions never ran")
    return tally.finish(f"an escalated delivery resolved {N} times at once by two administrators was resolved "
                        f"exactly once ({split}): one audit row, the rider paid at most once.")


h.main(run)
