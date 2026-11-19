#!/usr/bin/env python3
"""
Race one rider onto two tasks (FR-WM-07: one rider, one task).

Two tasks are put on offer to the same rider and both are accepted at the same
instant - K copies of each accept, so there is contention on each task as well
as between them. The first-accept guard stops two riders sharing a task; it
says nothing about one rider's rider_state row being overwritten with a second
task, which leaves the first task ASSIGNED to someone who no longer knows they
hold it.

Every round must leave the rider holding exactly one of the two tasks, that
task ASSIGNED to them, and the other still BROADCASTING with no rider.

Tasks are inserted by SQL as BROADCASTING, exactly as race-stress.py does, and
the rider is registered in the dispatcher's offered set in Redis so the accept
goes through the real "was this rider offered it" check rather than its
fail-open path.

    python3 apps/api/test/race-two-tasks.py [BASE]      (K=2 ROUNDS=30 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

K = h.env_int("K", 2)
ROUNDS = h.env_int("ROUNDS", 30)
# dispatch.service.ts: offeredRidersKey, OFFERED_SET_SENTINEL, and a TTL of
# the acceptance window plus 120 seconds.
OFFER_WINDOW_S = 120


def insert_task(task_id: str, college: str, requester: str, riders: list) -> None:
    h.psql(f"""INSERT INTO task (id, college_id, type, status, requester_id,
            pickup_label, pickup_latitude, pickup_longitude,
            drop_label, drop_latitude, drop_longitude,
            distance_m, base_fee_minor, fee_minor, broadcast_round,
            current_proximity_m, offer_expires_at, created_at, updated_at)
            VALUES ({h.q(task_id)},{h.q(college)},'PARCEL_PICKUP','BROADCASTING',{h.q(requester)},
            'Gate',17.3051,78.6194,'Library',17.3047,78.6192,500,2000,2000,1,1500,
            now() + interval '{OFFER_WINDOW_S} seconds', now(), now())""")
    h.psql(f"""INSERT INTO broadcast_log (id, task_id, round, radius_m, fee_minor,
            eligible_count, sent_at, outcome)
            VALUES (gen_random_uuid()::text,{h.q(task_id)},1,1500,2000,{len(riders)},now(),'PENDING')""")
    key = f"dispatch:offered:{task_id}"
    h.redis("SADD", key, "-", *riders)
    h.redis("EXPIRE", key, str(OFFER_WINDOW_S + 120))


def cleanup(prefix: str) -> None:
    like = h.q(prefix + "%")
    h.psql("ALTER TABLE broadcast_log DISABLE TRIGGER broadcast_log_is_insert_or_resolve_only")
    try:
        h.psql(f"UPDATE rider_state SET active_task_id=NULL WHERE active_task_id LIKE {like}")
        h.psql(f"DELETE FROM chat_member WHERE room_id IN (SELECT id FROM chat_room WHERE task_id LIKE {like})")
        h.psql(f"DELETE FROM chat_room WHERE task_id LIKE {like}")
        h.psql(f"DELETE FROM broadcast_log WHERE task_id LIKE {like}")
        h.psql(f"DELETE FROM task WHERE id LIKE {like}")
    finally:
        h.psql("ALTER TABLE broadcast_log ENABLE TRIGGER broadcast_log_is_insert_or_resolve_only")


def run() -> int:
    tally = h.Tally("race-two-tasks", 2 * K, ROUNDS)
    college = h.college_id()
    requester = h.user_id("vivek@anurag.edu.in")
    prefix = f"twotask-{h.RUN}-"
    print(f"Two-task race: one rider accepts two offered tasks at once ({K} request(s) per task), "
          f"{ROUNDS} rounds.")
    h.free_riders(h.RACERS)

    with h.Riders(h.RACERS):
        for n in range(1, ROUNDS + 1):
            rider = h.RACERS[n % len(h.RACERS)]
            rid = h.user_id(rider)
            where = f"round {n}"
            a, b = f"{prefix}{n}-a", f"{prefix}{n}-b"
            insert_task(a, college, requester, [rid])
            insert_task(b, college, requester, [rid])

            calls = []
            for _ in range(K):
                calls.append(h.Call("accept A", "POST", f"/rider/tasks/{a}/accept", rider, route="accept"))
                calls.append(h.Call("accept B", "POST", f"/rider/tasks/{b}/accept", rider, route="accept"))
            results = tally.fire(where, calls)

            wins = [r for r in results if r.ok]
            holding = h.psql(f"SELECT COALESCE(active_task_id,'NULL') FROM rider_state WHERE user_id={h.q(rid)}")
            state = dict(line.split("|", 1) for line in h.psql(
                "SELECT id, status || '|' || COALESCE(rider_id,'NULL') FROM task "
                f"WHERE id IN ({h.q(a)},{h.q(b)})").splitlines())
            assigned = [t for t, s in state.items() if s == f"ASSIGNED|{rid}"]
            untouched = [t for t, s in state.items() if s == "BROADCASTING|NULL"]
            tally.note_rows("tasks ASSIGNED to the rider", len(assigned))
            tally.note_rows("tasks still on offer", len(untouched))

            problems = []
            if len(assigned) != 1:
                problems.append(f"{len(assigned)} tasks ASSIGNED to the rider (must be exactly 1): {state}")
            if len(untouched) != 1:
                problems.append(f"{len(untouched)} tasks still BROADCASTING with no rider (must be exactly 1): {state}")
            if holding not in (a, b) or (assigned and holding != assigned[0]):
                problems.append(f"rider_state says the rider holds {holding}; the task table says {assigned}")
            if len(wins) != 1:
                problems.append(f"{len(wins)} accepts answered 200 (must be exactly 1)")
            elif assigned and wins[0].body.get("taskId") != assigned[0]:
                problems.append(f"the 200 was for {wins[0].body.get('taskId')} but the database assigned {assigned}")
            unexplained = {r.code for r in results if not r.ok and r.status < 500} - {
                "ALREADY_HOLDING_TASK", "ALREADY_TAKEN"}
            if unexplained:
                problems.append(f"unexpected refusals {sorted(unexplained)}")
            for p in problems:
                tally.fail(where, p)
            tally.rounds_run += 1
            h.progress(not problems)
            h.psql(f"UPDATE rider_state SET active_task_id=NULL WHERE user_id={h.q(rid)}")
            h.redis("SREM", f"riders:busy:{college}", rid)

    cleanup(prefix)
    return tally.finish("a rider accepting two tasks at once ended holding exactly one in every round, "
                        "and the other went straight back on offer.")


h.main(run)
