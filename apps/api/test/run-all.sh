#!/usr/bin/env bash
# Create the fixtures, then run both walks, the access checks and every race
# harness, in sequence, against one API and one web app. This is what gets re-run after every merge.
#
#   apps/api/test/run-all.sh [API_BASE] [WEB_URL]
#
#   API_BASE  default http://localhost:4000/api/v1   (or $HOPPO_API_BASE)
#   WEB_URL   default http://localhost:3000          (or $WEB_URL)
#
# Nothing below names a port. To check a second API instance, pass its base
# URL; the database and Redis are taken from DATABASE_URL / REDIS_URL, falling
# back to apps/api/.env, so a second instance must share them (or export its
# own). The browser walk drives WEB_URL, and that web app talks to whatever
# API it was built to talk to (NEXT_PUBLIC_API_URL) - pass the matching pair.
#
#   WALK_DIR  where pw/browser.mjs lives (default /home/claude/walk). The
#             browser walk is kept outside the repository because it needs
#             Playwright, which is deliberately not a repo dependency; the API
#             walk (walk-api.py) is in this directory.
#   SKIP_WALKS=1     harnesses only
#   SKIP_SLOW=1      leave out race-unfulfilled (about four minutes on its own)
#   SKIP_BROWSER=1   everything but the browser walk
#
# One line per check, PASS / FAIL / BLOCKED / SKIP, and an exit code that is
# zero only if every check that ran passed. Full output of each check is kept
# in $LOG_DIR (default: a fresh directory under /tmp).

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${1:-${HOPPO_API_BASE:-http://localhost:4000/api/v1}}"
WEB="${2:-${WEB_URL:-http://localhost:3000}}"
WALK_DIR="${WALK_DIR:-/home/claude/walk}"
LOG_DIR="${LOG_DIR:-$(mktemp -d /tmp/hoppo-run-all.XXXXXX)}"
mkdir -p "$LOG_DIR"
export HOPPO_API_BASE="$BASE" WEB_URL="$WEB" HOPPO_REPO="$(cd "$HERE/../../.." && pwd)"

echo "API  $BASE"
echo "WEB  $WEB"
echo "logs $LOG_DIR"
echo

summary=()
failed=0

# Which services restarted, and when. Printed against the last run of this
# script at the start, and against the start of this run after any check that
# does not pass and again at the end - so a container restart in the middle of
# the suite is in the log as a restart, next to the checks it broke.
services() { python3 -I "$HERE/services.py" "$@" "$BASE" 2>&1 | grep -a '^services:\|^RESULT:' ; }

record() {  # name, exit code, log file
  local name="$1" code="$2" log="$3" verdict detail
  case "$code" in
    0) verdict=PASS ;;
    3) verdict=BLOCKED; failed=1 ;;
    124) verdict=FAIL; failed=1; echo "(timed out)" >>"$log" ;;
    *) verdict=FAIL; failed=1 ;;
  esac
  detail="$(grep -aE '^(RESULT:|All [0-9]+ checks passed|[0-9]+ problem\(s\)|Browser walk clean|[0-9]+ of [0-9]+ steps ok)' "$log" | tail -1)"
  [ "$code" = 124 ] && detail="timed out"
  summary+=("$(printf '%-7s %-22s %s' "$verdict" "$name" "$detail")")
  printf '%-7s %-22s %s\n' "$verdict" "$name" "$detail"
  if [ "$verdict" != PASS ]; then
    services --since this-run | grep -a 'RESTARTED\|came back\|RESULT:' | sed 's/^/        /'
  fi
}

run() {  # name, timeout seconds, command...
  local name="$1" limit="$2"; shift 2
  local log="$LOG_DIR/$name.log"
  timeout "$limit" "$@" >"$log" 2>&1
  local code=$?
  # The dev API runs in watch mode and restarts when a source file changes.
  # A run that died on a refused connection gets one more go, after a pause.
  if [ "$code" -ne 0 ] && grep -qiE 'connection refused|NO_RESPONSE|ECONNREFUSED|ERR_CONNECTION_REFUSED|not answering|not reachable' "$log"; then
    echo "        $name lost the API mid-run; waiting 20s and running it once more"
    mv "$log" "$log.first-attempt"
    sleep 20
    timeout "$limit" "$@" >"$log" 2>&1
    code=$?
  fi
  record "$name" "$code" "$log"
}

services
services --mark this-run >/dev/null
echo

# Fixtures first. A reset database has none of the accounts the checks below
# sign in as, and a harness that cannot sign in has proved nothing - so if the
# fixtures cannot be put in place, stop here and say so.
timeout 600 python3 -I "$HERE/fixtures.py" "$BASE" >"$LOG_DIR/fixtures.log" 2>&1
fixtures_code=$?
if [ "$fixtures_code" -ne 0 ] && grep -qiE 'BLOCKED - api:|lost the API|not reachable at http|NO_RESPONSE|-> 0 ' "$LOG_DIR/fixtures.log"; then
  echo "        fixtures lost the API; waiting 20s and running them once more"
  sleep 20
  timeout 600 python3 -I "$HERE/fixtures.py" "$BASE" >"$LOG_DIR/fixtures.log" 2>&1
  fixtures_code=$?
fi
if [ "$fixtures_code" -ne 0 ]; then
  # One line saying which of database / redis / api / a fixture it was.
  reason="$(grep -aE '^RESULT:' "$LOG_DIR/fixtures.log" | tail -1)"
  [ -z "$reason" ] && reason="RESULT: BLOCKED - fixtures.py crashed: $(tail -1 "$LOG_DIR/fixtures.log")"
  printf '%-7s %-22s %s\n' BLOCKED fixtures "$reason"
  echo
  echo "Nothing else was run. See $LOG_DIR/fixtures.log"
  exit 3
fi
record fixtures 0 "$LOG_DIR/fixtures.log"

# Both walks go before the harnesses. They sign in through the UI and the
# login route allows ten a minute per address; and they use the one seeded
# rider, who should not be looking at offers left over from a race.
if [ "${SKIP_WALKS:-0}" != 1 ]; then
  run walk-api 300 python3 -I "$HERE/walk-api.py" "$BASE"
  if [ "${SKIP_BROWSER:-0}" != 1 ]; then
    if [ -f "$WALK_DIR/pw/browser.mjs" ] && [ -d "$WALK_DIR/pw/node_modules/playwright" ]; then
      run walk-browser 1100 bash -c "cd '$WALK_DIR/pw' && node browser.mjs '$WEB' '$BASE'"
    else
      summary+=("SKIP    walk-browser           $WALK_DIR/pw/browser.mjs or its Playwright install not found"); echo "${summary[-1]}"
    fi
  fi
fi

run e2e-shop-approval 300 python3 -I "$HERE/e2e-shop-approval.py" "$BASE"
run e2e-admin 400 python3 -I "$HERE/e2e-admin.py" "$BASE"
run e2e-admin-actions 500 python3 -I "$HERE/e2e-admin-actions.py" "$BASE"
run e2e-account 400 python3 -I "$HERE/e2e-account.py" "$BASE"

# race-unfulfilled goes last: it needs every rider offline for three and a
# half minutes while the dispatcher runs its rounds out. SKIP_SLOW=1 leaves it
# (and only it) out.
for harness in race-stress race-two-tasks race-refund race-wallet-spend race-payout race-otp-cap \
               race-abandon-pickup race-escalation-resolve race-shop-reinstate race-admin-decisions \
               race-sweep-cancel; do
  run "$harness" 900 python3 -I "$HERE/$harness.py" "$BASE"
done
if [ "${SKIP_SLOW:-0}" != 1 ]; then
  run race-unfulfilled 900 python3 -I "$HERE/race-unfulfilled.py" "$BASE"
else
  summary+=("SKIP    race-unfulfilled       SKIP_SLOW=1"); echo "${summary[-1]}"
fi

echo
restarts="$(services --since this-run | grep -a 'RESTARTED\|came back\|RESULT:')"
if [ -n "$restarts" ]; then
  echo "A service restarted DURING this run - results from around that time are not trustworthy:"
  echo "$restarts"
else
  echo "services: none restarted during this run"
fi
echo "================ summary ================"
printf '%s\n' "${summary[@]}"
echo "logs: $LOG_DIR"
if [ "$failed" -eq 0 ]; then echo "ALL PASS"; else echo "NOT ALL PASS"; fi
exit "$failed"
