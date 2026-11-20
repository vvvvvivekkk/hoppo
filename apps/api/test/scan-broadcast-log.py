#!/usr/bin/env python3
"""
After a run: is the dispatcher's log in a state the dispatcher could have left?

broadcast_log has one row per round of each search ("cycle") for a task, and a
row is PENDING only while that round's offer is open. Three things can
therefore never be true, and this looks for each of them:

  1. a PENDING row on a task that has finished (COMPLETED or CANCELLED) - an
     offer still "open" on a delivery that is over;
  2. two rows for the same (task, cycle, round) - one round logged twice;
  3. a PENDING row from an earlier cycle than the task's current one - a
     finished search that was never closed when the next one began.

It counts rows written since `--since` (a UTC timestamp; run-all.sh passes the
moment the run began), so what one run did is judged on its own, and prints
the all-time counts beside them for context. The harness shortcut that puts a
task into UNFULFILLED expires only the current cycle's rows, exactly as the
product does, so anything found here was left by the product or by a harness
doing something the product cannot - either way it should be looked at.

    python3 -I apps/api/test/scan-broadcast-log.py [--since '2026-11-20 06:12:00'] [BASE]

Exit 0 when all three counts are zero for the period, 1 otherwise.
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

CHECKS = [
    ("PENDING rows on a finished task (COMPLETED or CANCELLED)",
     "FROM broadcast_log b JOIN task t ON t.id=b.task_id "
     "WHERE b.outcome='PENDING' AND t.status IN ('COMPLETED','CANCELLED')", "b.sent_at"),
    ("duplicate (task, cycle, round) rows",
     "FROM (SELECT task_id, cycle, round, min(sent_at) AS first_sent FROM broadcast_log "
     "GROUP BY 1,2,3 HAVING count(*) > 1) b WHERE true", "b.first_sent"),
    ("PENDING rows from a cycle older than the task's current one",
     "FROM broadcast_log b JOIN task t ON t.id=b.task_id "
     "WHERE b.outcome='PENDING' AND b.cycle < t.broadcast_cycle", "b.sent_at"),
]


def run() -> int:
    args = sys.argv[1:]
    since = args[args.index("--since") + 1] if "--since" in args else "1970-01-01 00:00:00"
    print(f"broadcast_log scan, rows written since {since} UTC (all-time count in brackets)")
    bad = 0
    for label, body, stamp in CHECKS:
        in_run = int(h.psql(f"SELECT count(*) {body} AND {stamp} >= {h.q(since)}"))
        ever = int(h.psql(f"SELECT count(*) {body}"))
        print(f"  {'ok  ' if in_run == 0 else 'FAIL'} {label}: {in_run}   [{ever} all-time]")
        if in_run:
            bad += 1
            sample = h.psql(f"SELECT b.task_id {body} AND {stamp} >= {h.q(since)} LIMIT 3")
            print(f"       e.g. task(s) {', '.join(sample.split())}")
    if bad:
        print(f"RESULT: FAIL - {bad} of 3 impossible states were found in the dispatcher's log. scan-broadcast-log")
        return 1
    print("RESULT: PASS - no finished task has an open offer, no round is logged twice, and no earlier search was left open.")
    return 0


h.main(run)
