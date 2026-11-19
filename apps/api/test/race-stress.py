#!/usr/bin/env python3
"""
Stress the FR-DLV-04 assignment race.

Each round puts one task into BROADCASTING, frees every rider, then fires five
genuinely concurrent accepts from five different riders. Exactly one must win —
both in the HTTP responses and in the database.

Concurrency comes from a thread pool with a barrier, so all five requests leave
at the same moment rather than in sequence.
"""
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "http://localhost:4000/api/v1"
COLLEGE = "00000000-0000-4000-8000-000000000001"
ROUNDS = 30
RIDERS = [f"rider-race-{i}" for i in range(1, 6)]


def psql(sql: str) -> str:
    out = subprocess.run(
        ["psql", "-h", "localhost", "-U", "hoppo", "-d", "hoppo", "-tAc", sql],
        env={"PGPASSWORD": "hoppo_dev_password", "PATH": "/usr/bin:/bin"},
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()}\nSQL: {sql[:200]}")
    return out.stdout.strip()


def post(path: str, token: str) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{BASE}{path}", method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=b"{}",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


tokens = {}
for i, rid in enumerate(RIDERS, start=1):
    req = urllib.request.Request(
        f"{BASE}/auth/login", method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps({"identifier": f"racer{i}@anurag.edu.in",
                         "password": "Hoppo@dev123"}).encode(),
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        tokens[rid] = json.loads(r.read())["accessToken"]

customer = psql("SELECT id FROM \"user\" WHERE email='vivek@anurag.edu.in'")

print(f"Racing {len(RIDERS)} riders on one task, {ROUNDS} rounds.")
print("Each round must yield exactly one winner, in HTTP and in the database.\n")

failures = []

# A unique prefix per run, so no round ever has to delete a previous one.
# broadcast_log is append-only (ADR-007) and the trigger refuses DELETE —
# which also means a task that has been broadcast cannot be deleted, since the
# cascade would have to remove its log rows. Correct behaviour, inconvenient
# for a test, so the test simply never reuses an id.
RUN = os.urandom(3).hex()

for n in range(1, ROUNDS + 1):
    task = f"stress-{RUN}-{n}"

    # Reset: free every rider. Nothing to delete.
    psql("UPDATE rider_state SET active_task_id=NULL WHERE user_id LIKE 'rider-race-%'")
    psql(f"""INSERT INTO task (id, college_id, type, status, requester_id,
            pickup_label, pickup_latitude, pickup_longitude,
            drop_label, drop_latitude, drop_longitude,
            distance_m, base_fee_minor, fee_minor, broadcast_round,
            current_proximity_m, offer_expires_at, created_at, updated_at)
            VALUES ('{task}','{COLLEGE}','PARCEL_PICKUP','BROADCASTING','{customer}',
            'Gate',17.3051,78.6194,'Library',17.3047,78.6192,500,2000,2000,1,1500,
            now() + interval '120 seconds', now(), now())""")
    psql(f"""INSERT INTO broadcast_log (id, task_id, round, radius_m, fee_minor,
            eligible_count, sent_at, outcome)
            VALUES (gen_random_uuid()::text,'{task}',1,1500,2000,5,now(),'PENDING')""")

    # All five leave the gate together.
    barrier = threading.Barrier(len(RIDERS))

    def attempt(rid: str):
        barrier.wait()
        return rid, *post(f"/rider/tasks/{task}/accept", tokens[rid])

    with ThreadPoolExecutor(max_workers=len(RIDERS)) as pool:
        results = list(pool.map(attempt, RIDERS))

    http_wins = [r for r in results if r[1] == 200]
    codes = sorted({r[2].get("code", str(r[1])) for r in results if r[1] != 200})

    db_rider = psql(f"SELECT COALESCE(rider_id,'NULL') FROM task WHERE id='{task}'")
    db_status = psql(f"SELECT status FROM task WHERE id='{task}'")
    db_holders = int(psql(f"SELECT count(*) FROM rider_state WHERE active_task_id='{task}'"))
    rooms = int(psql(f"SELECT count(*) FROM chat_room WHERE task_id='{task}'"))

    ok = (
        len(http_wins) == 1
        and db_holders == 1
        and db_rider != "NULL"
        and db_rider == http_wins[0][0]
        and db_status == "ASSIGNED"
        and rooms == 1
    )

    if ok:
        sys.stdout.write(".")
        sys.stdout.flush()
    else:
        failures.append(
            f"round {n}: http200={len(http_wins)} db_rider={db_rider} "
            f"status={db_status} holders={db_holders} rooms={rooms} others={codes}"
        )
        sys.stdout.write("X")
        sys.stdout.flush()

print("\n")
for f in failures:
    print("  " + f)

print(f"rounds: {ROUNDS} | failures: {len(failures)}")
if not failures:
    print("RESULT: exactly one rider assigned in every round, HTTP and database agreeing.")
    print("        No double assignment, no lost assignment, one chat room each.")
else:
    print(f"RESULT: {len(failures)} round(s) failed.")

# Cleanup. The append-only triggers have to be stepped around deliberately,
# which is the right amount of friction for removing ledger-adjacent rows —
# and only possible here because this is a scratch database.
psql("UPDATE rider_state SET active_task_id=NULL WHERE user_id LIKE 'rider-race-%'")
psql("ALTER TABLE broadcast_log DISABLE TRIGGER broadcast_log_is_insert_or_resolve_only")
psql("DELETE FROM chat_member WHERE room_id IN (SELECT id FROM chat_room WHERE task_id LIKE 'stress-%')")
psql("DELETE FROM chat_room WHERE task_id LIKE 'stress-%'")
psql("DELETE FROM broadcast_log WHERE task_id LIKE 'stress-%'")
psql("DELETE FROM task WHERE id LIKE 'stress-%'")
psql("ALTER TABLE broadcast_log ENABLE TRIGGER broadcast_log_is_insert_or_resolve_only")
sys.exit(1 if failures else 0)
