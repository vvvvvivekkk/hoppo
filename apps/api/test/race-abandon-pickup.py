#!/usr/bin/env python3
"""
Race a rider's "I give this up" against their own "I have collected it" (M4).

Both act on a task that is ASSIGNED. Abandon hands it back to the pool and
counts against the rider; pickup moves the task and its order to PICKED_UP and
issues the handover code. If each reads ASSIGNED and then writes without
checking again, both succeed: an order marked collected by a rider who no
longer has the task, or a task back on offer while somebody is carrying the
food.

Scenario 1 - abandon vs pickup, same rider, same instant. Exactly one may
succeed, and everything must agree with whichever it was:

                                   abandon won                pickup won
  task.status                      CREATED or BROADCASTING    PICKED_UP
  task.rider_id / otp_hash         NULL / NULL                the rider / set
  order.status                     READY                      PICKED_UP
  rider_state.active_task_id       NULL                       the task
  tasks_abandoned                  +1                         unchanged

Pickup hashes the handover code before it writes, so in a dead heat abandon
nearly always gets there first. The harness therefore gives one side a head
start and steers it from round to round until each has won, and reports the
split; a run where one side never won fails itself, because half the table
above would be untested.

Scenario 2 - the same pickup sent twice (a double tap). Exactly one 200, and
exactly one handover code reaches the student's socket - and that code is the
one that works. Two codes, with the second silently replacing the first,
strands the student holding a dead one.

Fixtures are real orders driven to ASSIGNED / READY through the API. Abandons
count towards the rider ban (college_config.abandonment_ban_threshold in a
rolling window, and the audit log they are counted from is append-only), so
for the length of the run the harness raises that threshold, and puts it back
- and clears any ban on the racer accounts - when it finishes.

    python3 apps/api/test/race-abandon-pickup.py [BASE]   (ROUNDS=10 DOUBLE_ROUNDS=5 by default)
"""
import os
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

ROUNDS = h.env_int("ROUNDS", 10)
DOUBLE_ROUNDS = h.env_int("DOUBLE_ROUNDS", 5)
DOUBLE_N = h.env_int("DOUBLE_N", 4)


def abandoned(uid: str) -> int:
    out = h.psql(f"SELECT tasks_abandoned FROM rider_reliability WHERE user_id={h.q(uid)}")
    return int(out) if out else 0


def state(task: str, order: str, rid: str) -> dict:
    t = h.psql("SELECT status || '|' || COALESCE(rider_id,'NULL') || '|' || (otp_hash IS NOT NULL) "
               f"FROM task WHERE id={h.q(task)}").split("|")
    return {"task": t[0], "rider": t[1], "otp": t[2] == "true",
            "order": h.psql(f'SELECT status FROM "order" WHERE id={h.q(order)}'),
            "holding": h.psql(f"SELECT COALESCE(active_task_id,'NULL') FROM rider_state WHERE user_id={h.q(rid)}")}


def finish_delivery(fx: dict) -> None:
    """Hand the order over properly, so the rider is free for the next batch."""
    code = h.reissue_code(fx["student"], fx["task_id"])
    h.make_room(fx["rider"], "handover", 1)
    h.http("POST", f"/rider/tasks/{fx['task_id']}/handover", h.login(fx["rider"]), {"code": code},
           who=fx["rider"], route="handover")


def run() -> int:
    tally = h.Tally("race-abandon-pickup", 2, ROUNDS + DOUBLE_ROUNDS)
    total = h.quote_total(h.RACERS[0])
    college = h.college_id()
    ids = ",".join(h.q(h.user_id(e)) for e in h.RACERS)
    threshold = h.psql(f"SELECT abandonment_ban_threshold FROM college_config WHERE college_id={h.q(college)}")
    print(f"Abandon-vs-pickup race: {ROUNDS} rounds of one abandon against one pickup, then "
          f"{DOUBLE_ROUNDS} rounds of {DOUBLE_N} identical pickups. "
          f"(Ban threshold {threshold} raised for the run and restored after.)")
    h.free_riders(h.RACERS)
    won = {"abandon": 0, "pickup": 0}
    head_start_ms = 0      # given to pickup; grows until pickup starts winning
    n = 0

    try:
        h.psql(f"UPDATE college_config SET abandonment_ban_threshold=1000000 WHERE college_id={h.q(college)}")
        h.psql(f"UPDATE rider_state SET barred_until=NULL WHERE user_id IN ({ids})")
        with h.Riders(h.RACERS):
            # ---- scenario 1: abandon vs pickup --------------------------------
            for batch in h.batches(ROUNDS, ["CASH"]):
                for fx in h.prepare_assigned_orders(batch, total):
                    n += 1
                    task, order, rider = fx["task_id"], fx["order_id"], fx["rider"]
                    rid = h.user_id(rider)
                    # Favour whichever side is behind.
                    favour = "pickup" if won["pickup"] <= won["abandon"] else "abandon"
                    delay = head_start_ms if favour == "pickup" else 0
                    where = f"round {n} (abandon held back {delay} ms)"
                    before = state(task, order, rid)
                    if (before["task"], before["rider"], before["order"]) != ("ASSIGNED", rid, "READY"):
                        raise RuntimeError(f"fixture for round {n} is not ASSIGNED/READY: {before}")
                    a0 = abandoned(rid)

                    results = tally.fire(where, [
                        h.Call("pickup", "POST", f"/rider/tasks/{task}/pickup", rider, {}, route="pickup"),
                        h.Call("abandon", "POST", f"/rider/tasks/{task}/abandon", rider,
                               {"reason": f"race harness {h.RUN}"}, route="abandon", delay_ms=delay)])
                    after = state(task, order, rid)
                    a1 = abandoned(rid)
                    wins = [r for r in results if r.ok]
                    loser_codes = {r.code for r in results if not r.ok and r.status < 500} - h.DB_CAUGHT

                    problems = []
                    if len(wins) != 1:
                        problems.append(f"{len(wins)} of the two requests answered 200 (must be exactly 1): "
                                        f"{[r.key + ' ' + r.call.label for r in results]}")
                    if loser_codes - {"CANNOT_ABANDON", "NOT_AWAITING_PICKUP", "NOT_YOUR_TASK"}:
                        problems.append(f"the loser was told {sorted(loser_codes)}")
                    # The states that must never exist, whoever won.
                    if after["order"] == "PICKED_UP" and after["rider"] == "NULL":
                        problems.append(f"order PICKED_UP but the task has no rider: {after}")
                    if after["task"] == "PICKED_UP" and after["holding"] != task:
                        problems.append(f"task PICKED_UP but rider_state does not hold it: {after}")
                    winner = wins[0].call.label if len(wins) == 1 else None
                    if winner == "abandon":
                        won["abandon"] += 1
                        if after["task"] not in ("CREATED", "BROADCASTING") or after["rider"] != "NULL" \
                                or after["otp"] or after["order"] != "READY" or after["holding"] != "NULL":
                            problems.append(f"abandon won but the rows say {after}")
                        if a1 - a0 != 1:
                            problems.append(f"abandon won but tasks_abandoned moved by {a1 - a0} (must be +1)")
                    elif winner == "pickup":
                        won["pickup"] += 1
                        if after["task"] != "PICKED_UP" or after["rider"] != rid or not after["otp"] \
                                or after["order"] != "PICKED_UP" or after["holding"] != task:
                            problems.append(f"pickup won but the rows say {after}")
                        if a1 - a0 != 0:
                            problems.append(f"pickup won but tasks_abandoned moved by {a1 - a0} (must be 0)")
                    tally.note_rows(f"won by {winner}", 1)
                    for p in problems:
                        tally.fail(f"{where} task {task}", p)
                    tally.rounds_run += 1
                    h.progress(not problems)

                    if favour == "pickup" and winner != "pickup":
                        head_start_ms = min(400, head_start_ms + 40)
                    if after["task"] == "PICKED_UP" and after["holding"] == task:
                        finish_delivery(fx)
                    elif after["rider"] == "NULL":
                        # Back in the pool with nobody to take it: close it,
                        # so it is not offered to whoever goes online next.
                        h.close_open_order(fx["student"], order, task)
                # Riders that the rows say are free are free; anything a failed
                # round left behind must not poison the next batch.
                h.free_riders(h.RACERS)

            # ---- scenario 2: the same pickup, several times -------------------
            for batch in h.batches(DOUBLE_ROUNDS, ["CASH"]):
                for fx in h.prepare_assigned_orders(batch, total):
                    n += 1
                    where = f"round {n} (pickup x {DOUBLE_N})"
                    task, order, rider = fx["task_id"], fx["order_id"], fx["rider"]
                    rid = h.user_id(rider)
                    listener = h.Socket(h.login(fx["student"])).connect()
                    if not listener.connected:
                        raise RuntimeError("the student's socket did not connect; cannot count handover codes")
                    results = tally.fire(where, [
                        h.Call("pickup", "POST", f"/rider/tasks/{task}/pickup", rider, {}, route="pickup")
                        for _ in range(DOUBLE_N)])
                    listener.wait_for(lambda: len(listener.named("task:handover-code")) >= 2, 2.0)
                    codes = [p.get("code") for p in listener.named("task:handover-code")
                             if isinstance(p, dict) and p.get("taskId") == task]
                    listener.close()
                    after = state(task, order, rid)
                    wins = [r for r in results if r.ok]
                    tally.note_rows("pickup x N: handover codes pushed to the student", len(codes))

                    problems = []
                    if len(wins) != 1:
                        problems.append(f"{len(wins)} pickups answered 200 (must be exactly 1)")
                    if len(codes) != 1:
                        problems.append(f"{len(codes)} handover codes reached the student's socket (must be exactly 1)")
                    if after["task"] != "PICKED_UP" or after["order"] != "PICKED_UP" or after["holding"] != task:
                        problems.append(f"after the pickup the rows say {after}")
                    refused = {r.code for r in results if not r.ok and r.status < 500} - h.DB_CAUGHT
                    if refused - {"NOT_AWAITING_PICKUP", "SHOP_NOT_READY"}:
                        problems.append(f"the repeated pickups were refused with {sorted(refused)}")
                    if codes:
                        # The code the student was shown must be the one that works.
                        h.make_room(rider, "handover", 1)
                        status, body = h.http("POST", f"/rider/tasks/{task}/handover", h.login(rider),
                                              {"code": codes[-1]}, who=rider, route="handover")
                        if status != 200:
                            problems.append(f"the code pushed to the student does not complete the delivery "
                                            f"({status} {body.get('code')})")
                    elif after["task"] == "PICKED_UP":
                        finish_delivery(fx)
                    for p in problems:
                        tally.fail(f"{where} task {task}", p)
                    tally.rounds_run += 1
                    h.progress(not problems)
                h.free_riders(h.RACERS)
    finally:
        h.psql(f"UPDATE college_config SET abandonment_ban_threshold={int(threshold)} "
               f"WHERE college_id={h.q(college)}")
        h.psql(f"UPDATE rider_state SET barred_until=NULL WHERE user_id IN ({ids})")

    split = f"abandon won {won['abandon']}, pickup won {won['pickup']}"
    print(f"\nwho won: {split}")
    if ROUNDS >= 4 and (won["abandon"] == 0 or won["pickup"] == 0):
        tally.invalid.append(f"one side never won ({split}): half of the outcome table was never checked")
    return tally.finish(f"abandon and pickup sent together never both took effect ({split}), and a repeated "
                        "pickup issued exactly one handover code.")


h.main(run)
