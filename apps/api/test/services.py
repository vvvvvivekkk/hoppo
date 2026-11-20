#!/usr/bin/env python3
"""
When did each service this suite stands on last start - and has any of them
restarted since we last looked?

    python3 -I apps/api/test/services.py [API_BASE]            compare with the last run of the suite
    python3 -I apps/api/test/services.py --mark NAME [BASE]    remember the current state under NAME
    python3 -I apps/api/test/services.py --since NAME [BASE]   compare with what was remembered as NAME

A development container that restarts takes PostgreSQL, Redis and the API down
together, and Redis comes back empty. A harness that was mid-run reports that
as a failed assertion; this is what lets the log say "Redis restarted at
09:12, during race-payout" instead.

  postgres  pg_postmaster_start_time()
  redis     now minus INFO server uptime_in_seconds, and its run_id (a new id
            is a new process even if the clock looks the same)
  api       the `uptime` the health route reports, if it reports one; else the
            time it was first seen answering

Exit 0 if nothing restarted, 4 if something did (run-all.sh treats that as
information, not as a failure of its own), 3 if a service is down.
"""
import json
import os
import subprocess
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402


def stamp(epoch: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch))


def observe() -> dict:
    h.require_api()
    pg = float(h.psql("SELECT extract(epoch FROM pg_postmaster_start_time())"))
    info = dict(line.split(":", 1) for line in h.redis("INFO", "server").replace("\r", "").splitlines() if ":" in line)
    redis_start = time.time() - float(info.get("uptime_in_seconds", 0))
    status, health = h.http("GET", "/health")
    uptime = health.get("uptime") if isinstance(health, dict) else None
    out = {"postgres": {"started": pg, "id": str(int(pg))},
           "redis": {"started": redis_start, "id": info.get("run_id", "")},
           "redis_keys": h.redis("DBSIZE")}
    if isinstance(uptime, (int, float)):
        api_start = time.time() - float(uptime)
        out["api"] = {"started": api_start, "id": str(int(api_start // 5))}   # five-second buckets: uptime is rounded
    return out


def path(name: str) -> str:
    import hashlib
    tag = hashlib.sha256(h.BASE.encode()).hexdigest()[:12]
    return os.path.join(os.environ.get("TMPDIR", "/tmp"), f"hoppo-harness-services-{tag}-{name}.json")


def run() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("http")]
    mode, name = (args[0], args[1]) if len(args) >= 2 and args[0] in ("--mark", "--since") else ("--last", "last-run")
    now = observe()
    if mode == "--mark":
        with open(path(name), "w") as fh:
            json.dump(dict(now, at=time.time()), fh)
    try:
        with open(path(name)) as fh:
            before = json.load(fh)
    except (OSError, ValueError):
        before = None

    restarted = []
    for service in ("postgres", "redis", "api"):
        if service not in now:
            print(f"services: {service:<8} start time not reported by the service")
            continue
        line = f"services: {service:<8} up since {stamp(now[service]['started'])}"
        was = (before or {}).get(service)
        # Redis has a run id; the others are judged by their start time, with
        # slack for the API's uptime being reported in whole seconds.
        moved = bool(was) and (was["id"] != now[service]["id"] if service == "redis"
                               else abs(was["started"] - now[service]["started"]) > 10)
        if mode != "--mark" and moved:
            line += f"   <-- RESTARTED since {stamp(before['at'])} ({'the last run' if mode == '--last' else name})"
            restarted.append(service)
        print(line)
    if "redis" in restarted:
        print(f"services: redis    came back with {now['redis_keys']} key(s): rider positions, offer lists and any "
              "rate-limit state it held are gone")
    if mode == "--last":
        if before is None:
            print("services: no record of an earlier run to compare with")
        with open(path(name), "w") as fh:
            json.dump(dict(now, at=time.time()), fh)
    return 4 if restarted else 0


h.main(run)
