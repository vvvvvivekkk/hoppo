#!/usr/bin/env python3
"""
Stress the FR-DLV-04 assignment race.

Each round puts one task into BROADCASTING, frees every rider, then fires five
genuinely concurrent accepts from five different riders. Exactly one must win —
both in the HTTP responses and in the database.

Concurrency comes from a thread pool with a barrier, so all five requests leave
at the same moment rather than in sequence.

Since M8 an accept is only open to the riders a task was offered to, and the
dispatcher records that in a Redis set (dispatch:offered:<taskId>) when it
broadcasts. This harness inserts its tasks by SQL, so it writes that set
itself — the same key, sentinel and TTL as DispatchService.recordOfferedRiders
— rather than leaning on the accept path failing open when the set is missing.
A sixth rider who is *not* in the set joins every burst as a control: they
must be refused and must never win.

    python3 apps/api/test/race-stress.py [BASE]      (ROUNDS=30 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

ROUNDS = h.env_int("ROUNDS", 30)
OUTSIDER = "srichandana@anurag.edu.in"
OFFER_WINDOW_S = 120


def run() -> int:
    college = h.college_id()
    riders = {h.user_id(e): e for e in h.RACERS}
    customer = h.user_id("vivek@anurag.edu.in")
    outsider_id = h.user_id(OUTSIDER)
    # The control only means something if the outsider would otherwise be
    # allowed to accept: online and not already carrying a task.
    use_outsider = h.psql(
        f"SELECT COALESCE(active_task_id,'NULL') FROM rider_state WHERE user_id={h.q(outsider_id)}") in ("NULL", "")
    online = h.RACERS + ([OUTSIDER] if use_outsider else [])
    tally = h.Tally("race-stress", len(online), ROUNDS)

    print(f"Racing {len(riders)} riders on one task, {ROUNDS} rounds.")
    print("Each round must yield exactly one winner, in HTTP and in the database.")
    print("Control: one rider the task was not offered to joins every burst and must be refused."
          if use_outsider else "Control skipped: the outsider account is carrying a task.")
    print()

    # A unique prefix per run, so no round ever has to delete a previous one.
    # broadcast_log is append-only (ADR-007) and the trigger refuses DELETE —
    # which also means a task that has been broadcast cannot be deleted, since the
    # cascade would have to remove its log rows. Correct behaviour, inconvenient
    # for a test, so the test simply never reuses an id.
    prefix = f"stress-{h.RUN}-"
    refused_as_outsider = 0
    rider_ids = ",".join(h.q(r) for r in riders)

    with h.Riders(online):
        for n in range(1, ROUNDS + 1):
            task = f"{prefix}{n}"

            # Reset: free every rider. Nothing to delete.
            h.psql(f"UPDATE rider_state SET active_task_id=NULL WHERE user_id IN ({rider_ids})")
            for r in riders:
                h.redis("SREM", f"riders:busy:{college}", r)
            h.psql(f"""INSERT INTO task (id, college_id, type, status, requester_id,
                    pickup_label, pickup_latitude, pickup_longitude,
                    drop_label, drop_latitude, drop_longitude,
                    distance_m, base_fee_minor, fee_minor, broadcast_round,
                    current_proximity_m, offer_expires_at, created_at, updated_at)
                    VALUES ({h.q(task)},{h.q(college)},'PARCEL_PICKUP','BROADCASTING',{h.q(customer)},
                    'Gate',17.3051,78.6194,'Library',17.3047,78.6192,500,2000,2000,1,1500,
                    now() + interval '{OFFER_WINDOW_S} seconds', now(), now())""")
            h.psql(f"""INSERT INTO broadcast_log (id, task_id, round, radius_m, fee_minor,
                    eligible_count, sent_at, outcome)
                    VALUES (gen_random_uuid()::text,{h.q(task)},1,1500,2000,5,now(),'PENDING')""")
            # M8: the five racers were "offered" this task; the outsider was not.
            h.redis("SADD", f"dispatch:offered:{task}", "-", *riders)
            h.redis("EXPIRE", f"dispatch:offered:{task}", str(OFFER_WINDOW_S + 120))

            # All of them leave the gate together.
            calls = [h.Call("accept", "POST", f"/rider/tasks/{task}/accept", e, route="accept")
                     for e in online]
            results = tally.fire(f"round {n}", calls)

            racer_results = [r for r in results if r.call.email != OUTSIDER]
            http_wins = [r for r in results if r.ok]
            winner = h.user_id(http_wins[0].call.email) if len(http_wins) == 1 else None
            codes = sorted({r.code or str(r.status) for r in racer_results if not r.ok})

            db_rider = h.psql(f"SELECT COALESCE(rider_id,'NULL') FROM task WHERE id={h.q(task)}")
            db_status = h.psql(f"SELECT status FROM task WHERE id={h.q(task)}")
            db_holders = int(h.psql(f"SELECT count(*) FROM rider_state WHERE active_task_id={h.q(task)}"))
            rooms = int(h.psql(f"SELECT count(*) FROM chat_room WHERE task_id={h.q(task)}"))
            tally.note_rows("rider_state holders", db_holders)
            tally.note_rows("chat rooms", rooms)

            ok = (
                len(http_wins) == 1
                and db_holders == 1
                and db_rider != "NULL"
                and db_rider == winner
                and db_rider in riders
                and db_status == "ASSIGNED"
                and rooms == 1
                and codes == ["ALREADY_TAKEN"]
            )
            outsider_ok = True
            if use_outsider:
                # They must never win. NOT_OFFERED_TO_YOU is the usual answer;
                # ALREADY_TAKEN is the honest one when a racer's assignment
                # committed before this request was even read, because accept
                # looks at the task's status before it looks at the offer list.
                theirs = [r for r in results if r.call.email == OUTSIDER][0]
                outsider_ok = theirs.code in ("NOT_OFFERED_TO_YOU", "ALREADY_TAKEN") and db_rider != outsider_id
                refused_as_outsider += theirs.code == "NOT_OFFERED_TO_YOU"
                if not outsider_ok:
                    tally.fail(f"round {n}", f"the rider who was not offered the task got "
                                             f"{theirs.status} {theirs.code} (must be refused, and never assigned)")
            if not ok:
                tally.fail(f"round {n}", f"http200={len(http_wins)} db_rider={db_rider} "
                                         f"status={db_status} holders={db_holders} rooms={rooms} others={codes}")
            tally.rounds_run += 1
            h.progress(ok and outsider_ok)

    # Cleanup. The append-only triggers have to be stepped around deliberately,
    # which is the right amount of friction for removing ledger-adjacent rows —
    # and only possible here because this is a scratch database.
    like = h.q(prefix + "%")
    h.psql(f"UPDATE rider_state SET active_task_id=NULL WHERE user_id IN ({rider_ids})")
    # If the control ever did win (that is the failure this harness reports),
    # do not leave that account holding a task that is about to be deleted.
    h.psql(f"UPDATE rider_state SET active_task_id=NULL WHERE active_task_id LIKE {like}")
    for r in list(riders) + [outsider_id]:
        h.redis("SREM", f"riders:busy:{college}", r)
    h.psql("ALTER TABLE broadcast_log DISABLE TRIGGER broadcast_log_is_insert_or_resolve_only")
    try:
        h.psql(f"DELETE FROM chat_member WHERE room_id IN (SELECT id FROM chat_room WHERE task_id LIKE {like})")
        h.psql(f"DELETE FROM chat_room WHERE task_id LIKE {like}")
        h.psql(f"DELETE FROM broadcast_log WHERE task_id LIKE {like}")
        h.psql(f"DELETE FROM task WHERE id LIKE {like}")
    finally:
        h.psql("ALTER TABLE broadcast_log ENABLE TRIGGER broadcast_log_is_insert_or_resolve_only")

    if use_outsider and refused_as_outsider == 0:
        tally.invalid.append("the not-offered control never once got NOT_OFFERED_TO_YOU: the offer list "
                             "this harness writes to Redis is not being read by the API")
    return tally.finish("exactly one rider assigned in every round, HTTP and database agreeing. "
                        "No double assignment, no lost assignment, one chat room each.")


h.main(run)
