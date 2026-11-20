"""
Shared plumbing for the race harnesses in this directory.

Everything a harness needs that is not the race itself: where the API, the
database and Redis are; a login that survives the login rate limit; a barrier
that releases N requests at once and records what actually went out; fixtures
built through the real HTTP API; and a verdict that refuses to say PASS when
the harness did not really race anything.

Python standard library only, plus the `psql` and `redis-cli` binaries, the
same way race-stress.py has always worked.

Nothing here hard-codes a port. The API base comes from argv[1] or
HOPPO_API_BASE, the database from DATABASE_URL, Redis from REDIS_URL; the last
two fall back to apps/api/.env so a bare `python3 race-x.py` still works on a
laptop.
"""
import base64
import collections
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = "Hoppo@dev123"
RACERS = [f"racer{i}@anurag.edu.in" for i in range(1, 6)]
SHOP_OWNER = "cafe@example.com"
# Student accounts whose password is the seed's (the seed's own, and the ones fixtures.py makes).
SEED_PASSWORD_ACCOUNTS = set(RACERS) | {"vivek@anurag.edu.in", "srichandana@anurag.edu.in",
                                        "fresher@anurag.edu.in", "dropme@anurag.edu.in"}
RUN = os.urandom(3).hex()


def _dotenv() -> dict:
    out = {}
    try:
        with open(os.path.join(HERE, "..", ".env")) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


_ENV = _dotenv()


def _arg_base():
    for a in sys.argv[1:]:
        if a.startswith("http://") or a.startswith("https://"):
            return a
    return None


BASE = (_arg_base() or os.environ.get("HOPPO_API_BASE") or "http://localhost:4000/api/v1").rstrip("/")
DATABASE_URL = (os.environ.get("DATABASE_URL") or _ENV.get("DATABASE_URL") or "").split("?")[0]
REDIS_URL = os.environ.get("REDIS_URL") or _ENV.get("REDIS_URL") or "redis://localhost:6379"


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


class Blocked(Exception):
    """The environment, not the product, stopped the harness."""


# --------------------------------------------------------------------------
# Database and Redis
# --------------------------------------------------------------------------

def psql(sql: str) -> str:
    if not DATABASE_URL:
        raise Blocked("no DATABASE_URL in the environment or apps/api/.env")
    out = subprocess.run(
        ["psql", DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-qtAc", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stderr.strip()}\nSQL: {sql[:300]}")
    return out.stdout.strip()


def q(value: str) -> str:
    """A SQL string literal. Ids here come from the API or this file, but quote anyway."""
    return "'" + str(value).replace("'", "''") + "'"


def redis(*args: str) -> str:
    out = subprocess.run(["redis-cli", "-u", REDIS_URL, "--no-auth-warning", *args],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"redis-cli failed: {out.stderr.strip()}")
    return out.stdout.strip()


# --------------------------------------------------------------------------
# HTTP, with the server's own rate-limit headers remembered per user and route
# --------------------------------------------------------------------------

_limits = {}          # (who, route) -> (remaining, reset_at_monotonic)
_limits_lock = threading.Lock()


def http(method: str, path: str, token: str = None, body=None, who: str = None, route: str = None):
    """One request. Returns (status, json_body). status 0 means it never reached the API."""
    req = urllib.request.Request(
        f"{BASE}{path}", method=method,
        data=json.dumps(body if body is not None else {}).encode() if method != "GET" else None,
    )
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    headers = {}
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            status, raw, headers = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        status, raw, headers = e.code, e.read(), e.headers
    except Exception as e:  # connection refused, reset, timeout
        return 0, {"code": "NO_RESPONSE", "message": str(e)}
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {}
    if who and route:
        try:
            remaining = int(headers.get("X-RateLimit-Remaining"))
            reset = int(headers.get("X-RateLimit-Reset") or headers.get("Retry-After") or 60)
            with _limits_lock:
                _limits[(who, route)] = (remaining, time.monotonic() + reset)
        except (TypeError, ValueError):
            if status == 429:
                with _limits_lock:
                    _limits[(who, route)] = (0, time.monotonic() + 60)
    return status, payload


# The API's own limits, per signed-in user per route (see the @Throttle
# decorators; anything unlisted gets the global 120 a minute).
ROUTE_LIMITS = {"place": 20, "handover": 20, "reissue": 5, "ping": 60, "login": 10, "resolve": 30}
DEFAULT_LIMIT = 120
WINDOW_S = 62.0
_sent_lock = threading.Lock()


def _sent_path() -> str:
    tag = hashlib.sha256(BASE.encode()).hexdigest()[:12]
    return os.path.join(os.environ.get("TMPDIR", "/tmp"), f"hoppo-harness-sent-{tag}.json")


def make_room(who: str, route: str, needed: int) -> None:
    """
    Wait until `who` may send `needed` more requests on `route`, then book them.

    The API rate-limits per signed-in user per route. A burst that is mostly
    429s has not raced anything, so a harness asks before it fires rather than
    discovering afterwards that the limiter ate the round.

    Two sources of truth, both used. The harness keeps its own record of what
    it sent in the last minute - on disk, because run-all.sh runs six of these
    back to back and the fifth must know what the fourth spent - and never
    lets any sixty-second stretch exceed the route's limit. And when the
    server's X-RateLimit headers say there is less room than that (something
    else is using the same account), the headers win.
    """
    limit = ROUTE_LIMITS.get(route, DEFAULT_LIMIT)
    if needed > limit:
        raise Blocked(f"a burst of {needed} on '{route}' can never fit the limit of {limit} a minute; lower N")
    key = f"{who}|{route}"
    while True:
        with _sent_lock:
            try:
                with open(_sent_path()) as fh:
                    book = json.load(fh)
            except (OSError, ValueError):
                book = {}
            now = time.time()
            book = {k: [t for t in v if now - t < WINDOW_S] for k, v in book.items()}
            book = {k: v for k, v in book.items() if v}
            recent = book.get(key, [])
            wait = 0.0
            if len(recent) + needed > limit:
                # Wait until enough of the oldest sends have left the window.
                wait = recent[len(recent) + needed - limit - 1] + WINDOW_S - now
            known = _limits.get((who, route))
            if known and known[0] < needed and known[1] > time.monotonic():
                wait = max(wait, known[1] - time.monotonic() + 1.0)
                _limits.pop((who, route), None)
            if wait <= 0:
                book[key] = recent + [now] * needed
                fd = os.open(_sent_path(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as fh:
                    json.dump(book, fh)
                return
        sys.stdout.write(f"[limit:{route} {wait:.0f}s]")
        sys.stdout.flush()
        time.sleep(wait + 0.5)


def require_api() -> None:
    """
    Is everything these checks stand on actually up? PostgreSQL, Redis and the
    API, asked in that order and each by name, so that "the container
    restarted and took the database with it" reads as exactly that rather
    than as forty failed assertions.
    """
    if not DATABASE_URL:
        raise Blocked("database: no DATABASE_URL in the environment or apps/api/.env")
    try:
        out = subprocess.run(["psql", DATABASE_URL, "-qtAc", "SELECT 1"], capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        raise Blocked("database: the psql client is not installed")
    except subprocess.TimeoutExpired:
        raise Blocked("database: PostgreSQL did not answer within 15 seconds")
    if out.returncode != 0 or out.stdout.strip() != "1":
        reason = (out.stderr.strip().splitlines() or ["no answer"])[-1]
        raise Blocked(f"database: PostgreSQL is not up or not reachable ({reason})")
    try:
        pong = subprocess.run(["redis-cli", "-u", REDIS_URL, "--no-auth-warning", "PING"],
                              capture_output=True, text=True, timeout=10)
    except FileNotFoundError:
        raise Blocked("redis: the redis-cli client is not installed")
    except subprocess.TimeoutExpired:
        raise Blocked("redis: Redis did not answer within 10 seconds")
    if pong.stdout.strip() != "PONG":
        reason = ((pong.stderr or pong.stdout).strip().splitlines() or ["no answer"])[-1]
        raise Blocked(f"redis: Redis is not up or not reachable at {REDIS_URL} ({reason})")
    status, body = http("GET", "/health")
    if status != 200:
        why = body.get("message") if status == 0 else f"GET /health -> {status}"
        raise Blocked(f"api: the API is not answering at {BASE} ({why}); if it runs in watch mode, "
                      "check its log for a compile error")


# --------------------------------------------------------------------------
# Login. /auth/login allows ten a minute per IP, and run-all.sh runs six
# harnesses back to back, so tokens are cached on disk for their lifetime.
# --------------------------------------------------------------------------

_tokens = {}
_user_ids = {}


def _cache_path() -> str:
    tag = hashlib.sha256(BASE.encode()).hexdigest()[:12]
    return os.path.join(os.environ.get("TMPDIR", "/tmp"), f"hoppo-harness-tokens-{tag}.json")


def _exp(token: str) -> float:
    try:
        part = token.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["exp"])
    except Exception:
        return 0.0


def login(email: str, min_life_s: int = 420) -> str:
    cached = _tokens.get(email)
    if cached and _exp(cached) - time.time() > min_life_s:
        return cached
    disk = {}
    try:
        with open(_cache_path()) as fh:
            disk = json.load(fh)
    except (OSError, ValueError):
        pass
    token = disk.get(email)
    if token and _exp(token) - time.time() > min_life_s:
        # A cached token is only as good as the server that issued it.
        status, _ = http("GET", "/auth/me", token)
        if status == 200:
            _tokens[email] = token
            return token
    for attempt in range(2):
        status, body = http("POST", "/auth/login", None, {"identifier": email, "password": PASSWORD},
                            who="ip", route="login")
        if status in (200, 201) and body.get("accessToken"):
            token = body["accessToken"]
            _tokens[email] = token
            disk[email] = token
            fd = os.open(_cache_path(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump(disk, fh)
            return token
        if status == 429 and attempt == 0:
            time.sleep(61)
            continue
        if status == 0:
            raise Blocked(f"API not reachable at {BASE}: {body.get('message')}")
        raise Blocked(f"cannot sign in as {email}: {status} {body.get('code')}")
    raise Blocked(f"cannot sign in as {email}")


def user_id(email: str) -> str:
    if email not in _user_ids:
        uid = psql(f'SELECT id FROM "user" WHERE email={q(email)}')
        if not uid:
            raise Blocked(f"seed account {email} is missing from the database")
        _user_ids[email] = uid
    return _user_ids[email]


# --------------------------------------------------------------------------
# The race itself
# --------------------------------------------------------------------------

class Call:
    def __init__(self, label, method, path, email, body=None, route=None, delay_ms=0):
        self.label, self.method, self.path = label, method, path
        self.email, self.body, self.route = email, body, route or path
        # A deliberate stagger after the barrier, for races where one side is
        # naturally slower and would otherwise never get to win.
        self.delay_ms = delay_ms


# Codes the API's exception filter gives a request that was stopped by the
# database rather than by the application: P2002 (a unique index) becomes
# 409 ALREADY_EXISTS, a CHECK constraint or append-only trigger becomes
# 400 CONSTRAINT_VIOLATION, anything else unmapped is 500 DATABASE_ERROR.
# In a race harness none of these is a legitimate answer. The ledger is still
# right when one appears - that is what the index is for - but it means the
# application-level guard let a duplicate through as far as the INSERT.
DB_CAUGHT = {"ALREADY_EXISTS", "CONSTRAINT_VIOLATION", "DATABASE_ERROR", "DEPENDENT_RECORDS_EXIST"}


class Result:
    def __init__(self, call, status, body, released_at):
        self.call, self.status, self.body, self.released_at = call, status, body, released_at
        self.code = body.get("code") if isinstance(body, dict) else None

    @property
    def ok(self):
        return self.status in (200, 201)

    @property
    def evaluated(self):
        """Did the product's own handler answer, as opposed to the network, auth or the limiter?"""
        return self.status not in (0, 401, 429)

    @property
    def key(self):
        return f"{self.status}" + (f" {self.code}" if self.code and not self.ok else "")


class Tally:
    """What the harness actually did, kept so the verdict can be checked against it."""

    def __init__(self, name: str, n: int, rounds: int):
        self.name, self.n, self.rounds = name, n, rounds
        self.intended = 0
        self.sent = 0
        self.histogram = collections.Counter()
        self.rounds_run = 0
        self.failures = []          # an invariant in the database was broken
        self.bad_responses = []     # the data is right but a caller was told something wrong
        self.invalid = []
        self.rows = collections.Counter()
        self.max_spread_ms = 0.0
        self.db_caught = 0
        self.notes = []
        self.started = time.time()
        self.started_db = None

    def fail(self, where: str, what: str):
        self.failures.append(f"{where}: {what}")

    def note_rows(self, label: str, count: int):
        self.rows[f"{label}={count}"] += 1

    def fire(self, where: str, calls: list) -> list:
        """Release every call at the same instant. Returns one Result per call."""
        # Sign in and check the limiter *before* the barrier, so the burst is
        # nothing but the requests under test.
        tokens = {c.email: login(c.email) for c in calls}
        per_bucket = collections.Counter((c.email, c.route) for c in calls)
        for (who, route), needed in per_bucket.items():
            make_room(who, route, needed)

        barrier = threading.Barrier(len(calls))
        self.intended += len(calls)

        def go(call):
            barrier.wait(timeout=30)
            released = time.monotonic()
            if call.delay_ms:
                time.sleep(call.delay_ms / 1000.0)
            status, body = http(call.method, call.path, tokens[call.email], call.body,
                                who=call.email, route=call.route)
            return Result(call, status, body, released)

        with ThreadPoolExecutor(max_workers=len(calls)) as pool:
            results = list(pool.map(go, calls))

        self.sent += sum(1 for r in results if r.status != 0)
        for r in results:
            self.histogram[r.key] += 1
        spread = (max(r.released_at for r in results) - min(r.released_at for r in results)) * 1000
        self.max_spread_ms = max(self.max_spread_ms, spread)

        # The self-check, per round: a round only counts if it really was a race.
        evaluated = [r for r in results if r.evaluated]
        if len(evaluated) < 2:
            self.invalid.append(f"{where}: only {len(evaluated)} of {len(calls)} requests reached "
                                f"the handler ({dict(collections.Counter(r.key for r in results))})")
        if any(r.status in (0, 401, 429) for r in results):
            self.invalid.append(f"{where}: some requests were not evaluated "
                                f"({dict(collections.Counter(r.key for r in results if not r.evaluated))})")
        if spread > 250:
            self.invalid.append(f"{where}: requests left {spread:.0f} ms apart, not together")
        crashed = collections.Counter(r.call.label for r in results if r.status >= 500)
        for label, count in crashed.items():
            # Losing a race is an expected outcome and has a 409 to say so. A
            # 500 tells the loser the server broke, and tells a retrying
            # client to try again.
            self.bad_responses.append(f"{where}: {count} x HTTP 5xx on '{label}' (a lost race must be a clean 4xx)")
        caught = collections.Counter((r.call.label, r.key) for r in results if r.code in DB_CAUGHT)
        for (label, key), count in caught.items():
            self.bad_responses.append(
                f"{where}: {count} x '{key}' on '{label}' - stopped by a database constraint, not by the "
                "application's own guard (the data is safe, the guard is not)")
            self.db_caught += count
        return results

    def finish(self, proves: str) -> int:
        print("\n")
        for f in self.failures:
            print("  FAIL  " + f)
        for f in self.invalid:
            print("  INVALID  " + f)
        print(f"harness: {self.name}")
        print(f"N per burst: {self.n} | rounds run: {self.rounds_run} of {self.rounds} | "
              f"requests intended: {self.intended} | actually sent: {self.sent} | "
              f"widest release spread: {self.max_spread_ms:.1f} ms | {time.time() - self.started:.0f}s")
        print("response codes: " + ", ".join(f"{k} x{v}" for k, v in sorted(self.histogram.items())))
        print("database rows observed (per round): " + ", ".join(f"{k} in {v} round(s)" for k, v in sorted(self.rows.items())))

        # The harness-level self-check. Passing with nothing fired is the
        # failure this file exists to prevent.
        if self.rounds_run < self.rounds:
            self.invalid.append(f"only {self.rounds_run} of {self.rounds} rounds ran")
        if self.intended == 0 or self.sent != self.intended:
            self.invalid.append(f"intended {self.intended} concurrent requests, {self.sent} got a response")
        if self.intended < 2 * max(self.rounds, 1):
            self.invalid.append("fewer than two requests per round: nothing was raced")
        useless = sum(v for k, v in self.histogram.items() if k.split()[0] in ("0", "401", "429"))
        if self.intended and useless:
            self.invalid.append(f"{useless} request(s) were refused before the handler (401/429/no response)")

        shown = self.bad_responses[:6]
        for f in shown:
            print("  BAD RESPONSE  " + f)
        if len(self.bad_responses) > len(shown):
            print(f"  BAD RESPONSE  ... and {len(self.bad_responses) - len(shown)} more round(s) like these")
        for n in self.notes:
            print("  NOTE  " + n)
        five_xx = sum(v for k, v in self.histogram.items() if k[:1] == "5")
        print(f"database invariants: {'FAIL' if self.failures else 'held'} | "
              f"responses: {'FAIL' if self.bad_responses else 'clean'} | 5xx: {five_xx} | "
              f"stopped by a database constraint: {self.db_caught}")
        if self.failures:
            print(f"RESULT: FAIL - {len(self.failures)} invariant violation(s). {self.name}")
            return 1
        if self.bad_responses and not self.invalid:
            print(f"RESULT: FAIL - the database invariants held in every round, but "
                  f"{len(self.bad_responses)} burst(s) answered a request with a 5xx or a "
                  f"database-constraint error. {self.name}")
            return 1
        if self.invalid:
            for f in self.invalid[-4:]:
                print("  INVALID  " + f)
            print(f"RESULT: FAIL - the harness did not exercise the race it claims to. {self.name}")
            return 2
        print(f"RESULT: PASS - {proves}")
        return 0


# --------------------------------------------------------------------------
# Fixtures, all through the real API
# --------------------------------------------------------------------------

_catalog = {}


def catalog() -> dict:
    """The open shop, its cheapest available item, a drop point, and where the shop is."""
    if _catalog:
        return _catalog
    token = login(RACERS[0])
    status, shops = http("GET", "/browse/shops?sort=distance", token)
    open_shops = [s for s in shops.get("items", []) if s.get("isOpen")]
    if status != 200 or not open_shops:
        raise Blocked(f"no open shop to order from (GET /browse/shops -> {status}); "
                      "the seeded cafe must be open for these harnesses")
    listing_id = open_shops[0]["listingId"]
    _, detail = http("GET", f"/browse/shops/{listing_id}", token)
    items = [i for c in detail.get("categories", []) for i in c["items"] if i.get("isAvailable")]
    if not items:
        raise Blocked("the open shop has no available items")
    item = min(items, key=lambda i: i["priceMinor"])
    _, points = http("GET", "/browse/delivery-points", token)
    if not points.get("points"):
        raise Blocked("no delivery points seeded")
    lat, lng = psql(
        "SELECT s.latitude || ',' || s.longitude FROM shop_listing l JOIN shop s ON s.id=l.shop_id "
        f"WHERE l.id={q(listing_id)}").split(",")
    _catalog.update(listing_id=listing_id, item_id=item["id"], point_id=points["points"][0]["id"],
                    shop_lat=float(lat), shop_lng=float(lng))
    return _catalog


def order_body(method: str, total: int, quantity: int = 1) -> dict:
    c = catalog()
    return {"listingId": c["listing_id"], "lines": [{"catalogItemId": c["item_id"], "quantity": quantity}],
            "deliveryPointId": c["point_id"], "paymentMethod": method, "expectedTotalMinor": total,
            "studentNote": f"race harness {RUN}"}


def quote_total(email: str, quantity: int = 1) -> int:
    c = catalog()
    status, body = http("POST", "/orders/quote", login(email),
                        {"listingId": c["listing_id"], "deliveryPointId": c["point_id"],
                         "lines": [{"catalogItemId": c["item_id"], "quantity": quantity}]})
    if status != 200:
        raise Blocked(f"quote failed: {status} {body.get('code')} {body.get('message')}")
    return body["totals"]["totalMinor"]


def place_order(email: str, method: str, total: int):
    for attempt in range(2):
        make_room(email, "place", 1)
        status, body = http("POST", "/orders", login(email), order_body(method, total), who=email, route="place")
        if status != 429:
            break
        # Something else spent this account's allowance. This is fixture
        # building, not the race, so wait the window out once.
        sys.stdout.write("[limit:place 62s]")
        sys.stdout.flush()
        time.sleep(WINDOW_S)
    if status != 201:
        raise RuntimeError(f"placing a {method} order as {email} failed: {status} {body.get('code')} {body.get('message')}")
    return body["orderId"], body["taskId"]


# --- wallet ---------------------------------------------------------------

def _wallet_head_order() -> str:
    # src/wallet/wallet-ledger.ts WALLET_HEAD_ORDER: newest first, ties broken
    # by the seq column migration 20261120090000 adds (by id before it).
    has_seq = psql("SELECT count(*) FROM information_schema.columns "
                   "WHERE table_name='wallet_entry' AND column_name='seq'") == "1"
    return "created_at DESC, seq DESC" if has_seq else "created_at DESC, id DESC"


class _Lazy:
    def __init__(self, fn):
        self.fn, self.value = fn, None

    def __format__(self, spec):
        if self.value is None:
            self.value = self.fn()
        return self.value

    def __str__(self):
        return format(self)


WALLET_HEAD_ORDER = _Lazy(_wallet_head_order)

def balance(uid: str) -> int:
    """The balance exactly as the application reads it: the latest entry's running total."""
    out = psql(f"SELECT balance_after_minor FROM wallet_entry WHERE user_id={q(uid)} "
               f"ORDER BY {WALLET_HEAD_ORDER} LIMIT 1")
    return int(out) if out else 0


def ledger_sum(uid: str) -> int:
    """The balance as arithmetic: credits minus debits over the whole ledger."""
    return int(psql(
        "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END),0) "
        f"FROM wallet_entry WHERE user_id={q(uid)}"))


def adjust_wallet(uid: str, delta: int, why: str) -> None:
    """
    Fund (or drain) a wallet with one well-formed ADJUSTMENT row.

    Phase 1 has no top-up endpoint, so this is the one fixture that cannot go
    through HTTP. It takes the same advisory lock the application takes, reads
    the latest balance under it, and appends - the ledger is append-only by
    trigger, so there is no other way to write it.
    """
    if delta == 0:
        return
    direction, amount = ("CREDIT", delta) if delta > 0 else ("DEBIT", -delta)
    psql(f"""BEGIN;
        SELECT pg_advisory_xact_lock(hashtext('wallet:' || {q(uid)}));
        INSERT INTO wallet_entry (id, user_id, direction, amount_minor, type, note, balance_after_minor, created_at)
        SELECT gen_random_uuid()::text, {q(uid)}, '{direction}', {amount}, 'ADJUSTMENT', {q(why)},
               COALESCE((SELECT balance_after_minor FROM wallet_entry WHERE user_id={q(uid)}
                         ORDER BY {WALLET_HEAD_ORDER} LIMIT 1), 0) + ({delta}),
               (now() AT TIME ZONE 'utc');
        COMMIT;""")
    # The application orders by a millisecond timestamp; make sure whatever it
    # writes next sorts after this row.
    time.sleep(0.005)


def set_balance(uid: str, target: int, why: str) -> int:
    """Bring a wallet to exactly `target`. Returns what it was before."""
    before = balance(uid)
    adjust_wallet(uid, target - before, why)
    return before


def db_now() -> str:
    return psql("SELECT (now() AT TIME ZONE 'utc')::text")


def check_ledger(tally, emails, since: str) -> None:
    """
    Two whole-run checks on every wallet a harness touched, over the entries
    written since it started.

    1. The running balance is a chain. Read in the order the application reads
       it, each entry's balance must be the previous one plus or minus its own
       amount. (A delivery fee or errand reimbursement may also leave the
       balance alone: on a cash order it is a statement line, ADR-006.) A break
       means some entry was computed from the wrong "latest" row.
    2. No two entries for one user share a created_at. src/orders stamps each
       entry strictly after the wallet's head so the order is never ambiguous;
       a tie between two order entries is that guarantee failing. Ties that
       involve rider-side entries are reported as a note, not a failure.
    """
    ids = ",".join(q(user_id(e)) for e in emails)
    broken = psql(f"""
        WITH ordered AS (
          SELECT w.*, lag(balance_after_minor) OVER (PARTITION BY user_id ORDER BY {WALLET_HEAD_ORDER:s}) AS nxt,
                 lead(balance_after_minor) OVER (PARTITION BY user_id ORDER BY {WALLET_HEAD_ORDER:s}) AS prev
          FROM wallet_entry w WHERE user_id IN ({ids}))
        SELECT user_id || ' ' || type || ' ' || amount_minor || ' prev=' || prev || ' after=' || balance_after_minor
        FROM ordered
        WHERE created_at >= {q(since)} AND prev IS NOT NULL
          AND balance_after_minor <> prev + (CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END)
          AND NOT (type IN ('DELIVERY_FEE_EARNED','ERRAND_REIMBURSEMENT') AND balance_after_minor = prev)
        LIMIT 5""")
    for line in broken.splitlines():
        tally.fail("ledger chain", f"an entry's running balance does not follow from the entry before it: {line}")
    ties = psql(f"""
        SELECT user_id || ' ' || created_at || ' ' || string_agg(type::text, '+' ORDER BY type::text)
        FROM wallet_entry WHERE user_id IN ({ids}) AND created_at >= {q(since)}
        GROUP BY user_id, created_at HAVING count(*) > 1 LIMIT 20""")
    for line in ties.splitlines():
        types = set(line.rsplit(" ", 1)[1].split("+"))
        if types <= {"ORDER_HOLD", "ORDER_RELEASE", "ORDER_CAPTURE"}:
            tally.fail("ledger order", f"two order entries for one user share a created_at: {line}")
        else:
            tally.notes.append(f"entries for one user share a created_at (rider-side writer involved): {line}")
    tally.note_rows("ledger: same-millisecond ties", len(ties.splitlines()))
    tally.note_rows("ledger: broken balance chain", len(broken.splitlines()))


def rows(sql_where: str) -> int:
    return int(psql(f"SELECT count(*) FROM wallet_entry WHERE {sql_where}"))


# --- riders ---------------------------------------------------------------

def quiet_other_riders(keep=()) -> list:
    """
    Take every rider who is not one of this harness's own offline.

    A broadcast goes to whoever is online and in range. A rider account left
    online by something else - the browser walk's rider, a person trying the
    app - is offered the harness's tasks, can accept one, and the harness's own
    rider is then told ALREADY_TAKEN. So before any harness puts its riders
    online, everyone else goes offline:

      - through the API (POST /rider/work-mode {enabled:false}, as that rider)
        for accounts that use the seed password;
      - directly, for any other account (the harness cannot sign in as it, and
        never guesses a password), and for a seed account whose API call did
        not answer 200:
            UPDATE rider_state SET work_mode_on=false WHERE user_id=<id>
        and, in Redis, exactly what RedisService.removeRider does:
            ZREM riders:geo:<college> <id>
            HDEL riders:ping:<college> <id>
            SREM riders:busy:<college> <id>

    Every rider it touches gets a `[riders]` line saying which way, so a run's
    log shows who was online when it started. Riders carrying a task keep it:
    going offline only stops new offers.

    This changes shared state - which riders are online - and so do the
    harnesses that follow it. They are written to run one at a time.
    """
    keep_ids = {user_id(e) for e in keep}
    done = []
    online = psql('SELECT u.id || \'|\' || u.email || \'|\' || COALESCE(u.college_id, \'\') FROM rider_state r '
                  'JOIN "user" u ON u.id=r.user_id WHERE r.work_mode_on')
    for line in online.splitlines():
        uid, email, college = line.split("|")
        if uid in keep_ids:
            continue
        why = "cannot sign in as this account"
        if email in SEED_PASSWORD_ACCOUNTS:      # never guess at anybody else's password
            try:
                off, body = http("POST", "/rider/work-mode", login(email), {"enabled": False})
            except Blocked as e:
                off, body = 0, {"code": str(e)}
            if off == 200:
                done.append(f"{email}: offline through the API")
                continue
            why = f"the API answered {off} {body.get('code') or ''}".strip()
        psql(f"UPDATE rider_state SET work_mode_on=false WHERE user_id={q(uid)}")
        if college:
            redis("ZREM", f"riders:geo:{college}", uid)
            redis("HDEL", f"riders:ping:{college}", uid)
            redis("SREM", f"riders:busy:{college}", uid)
        done.append(f"{email}: FORCED offline by SQL and Redis ({why})")
    for d in done:
        print(f"  [riders] {d}")
    return done


class Riders:
    """Keeps a set of riders online, free and in range for as long as a harness runs."""

    def __init__(self, emails):
        self.emails = list(emails)
        self._stop = threading.Event()
        self._thread = None
        c = catalog()
        self.lat, self.lng = c["shop_lat"] + 0.0002, c["shop_lng"] + 0.0002

    def __enter__(self):
        quiet_other_riders(keep=self.emails)
        for e in self.emails:
            status, body = http("POST", "/rider/work-mode", login(e),
                                {"enabled": True, "latitude": self.lat, "longitude": self.lng})
            if status != 200:
                raise Blocked(f"{e} cannot go online: {status} {body.get('code')} {body.get('message')}")
        self._thread = threading.Thread(target=self._keepalive, daemon=True)
        self._thread.start()
        return self

    def _keepalive(self):
        # FR-WM-03: a rider who stops pinging stops being offered tasks after
        # three intervals. A real device pings every fifteen seconds.
        while not self._stop.wait(10):
            for e in self.emails:
                http("POST", "/rider/ping", login(e), {"latitude": self.lat, "longitude": self.lng})

    def __exit__(self, *exc):
        self._stop.set()
        for e in self.emails:
            http("POST", "/rider/work-mode", login(e), {"enabled": False})
        return False


def free_riders(emails) -> None:
    """Release harness riders from whatever a previous, interrupted run left them holding."""
    ids = ",".join(q(user_id(e)) for e in emails)
    psql(f"UPDATE rider_state SET active_task_id=NULL WHERE user_id IN ({ids})")
    for e in emails:
        redis("SREM", f"riders:busy:{college_id()}", user_id(e))


def college_id() -> str:
    return psql(f'SELECT college_id FROM "user" WHERE email={q(RACERS[0])}')


def drive_to_assigned(student: str, rider: str, method: str, total: int) -> dict:
    """
    One order, placed by `student`, accepted and readied by the shop, offered
    by the real dispatcher and accepted by `rider`. The task is ASSIGNED and
    the order READY: the moment a rider is standing at the counter.
    """
    order_id, task_id = place_order(student, method, total)
    owner = login(SHOP_OWNER)
    listing = catalog()["listing_id"]
    status, body = http("POST", f"/shops/{listing}/orders/{order_id}/accept", owner, {"prepMinutes": 1})
    if status != 200:
        raise RuntimeError(f"shop accept failed: {status} {body.get('code')} {body.get('message')}")
    status, body = http("POST", f"/shops/{listing}/orders/{order_id}/ready", owner, {})
    if status != 200:
        raise RuntimeError(f"shop ready failed: {status} {body.get('code')} {body.get('message')}")

    token = login(rider)
    deadline = time.time() + 75
    last = None
    while time.time() < deadline:
        make_room(rider, "accept", 1)
        status, body = http("POST", f"/rider/tasks/{task_id}/accept", token, {}, who=rider, route="accept")
        last = (status, body.get("code"))
        if status == 200:
            break
        if body.get("code") in ("NOT_YET_OFFERED", "NOT_OFFERED_TO_YOU"):
            time.sleep(1.5)   # the dispatcher ticks every five seconds
            continue
        if body.get("code") == "ALREADY_TAKEN" and psql(
                f"SELECT status FROM task WHERE id={q(task_id)} AND rider_id IS NULL") in ("CREATED", "BROADCASTING"):
            # Older builds answered ALREADY_TAKEN for a task nobody had been
            # offered yet. The database says nobody has it, so keep trying
            # until the deadline; the 75 seconds still bound it.
            time.sleep(1.5)
            continue
        raise RuntimeError(f"{rider} could not accept task {task_id}: {status} {body.get('code')} {body.get('message')}")
    else:
        raise RuntimeError(f"the dispatcher never offered task {task_id} to {rider} within 75s (last answer {last})")
    return {"order_id": order_id, "task_id": task_id, "student": student, "rider": rider, "method": method}


def drive_to_picked_up(student: str, rider: str, method: str, total: int) -> dict:
    """
    As drive_to_assigned, then the rider confirms pickup. Returns the ids and
    a live handover code obtained the way the student's screen obtains it.
    """
    fixture = drive_to_assigned(student, rider, method, total)
    status, body = http("POST", f"/rider/tasks/{fixture['task_id']}/pickup", login(rider), {})
    if status != 200:
        raise RuntimeError(f"pickup failed: {status} {body.get('code')} {body.get('message')}")
    fixture["code"] = reissue_code(student, fixture["task_id"])
    return fixture


def close_open_order(student: str, order_id: str, task_id: str) -> bool:
    """
    Close an order a harness has finished with but left on offer.

    A task that went back to the pool (an abandon that won, a "keep waiting")
    would otherwise be re-broadcast for the next three minutes to whichever
    rider comes online - including the rider in the browser walk, who would
    then be looking at somebody else's delivery. There is no student-side
    cancel for an order that is already READY except the FR-DLV-07 answer, so
    the task is put into UNFULFILLED by SQL (the same shortcut race-refund.py
    uses) and then cancelled through the API, which refunds any wallet hold
    the proper way.
    """
    for _ in range(2):
        # CREATED or BROADCASTING: the task went back to the pool and the
        # dispatcher may or may not have re-broadcast it yet. UNFULFILLED: the
        # second time round this loop, after a cancel that did not take.
        if not retire_unfulfilled(task_id, ("CREATED", "BROADCASTING", "UNFULFILLED")):
            return False
        status, _ = http("POST", f"/orders/{order_id}/unfulfilled", login(student), {"choice": "CANCEL"})
        if status == 200:
            return True
        time.sleep(1.0)
    return False


def retire_unfulfilled(task_id: str, allowed_from=("BROADCASTING",)) -> bool:
    """
    Put an unassigned task into UNFULFILLED the way the product does.

    DispatchService.retireUnfulfilled moves the task (BROADCASTING, no rider)
    to UNFULFILLED with no offer deadline and then, in the same transaction,
    resolves as EXPIRED the PENDING broadcast_log rows of the task's *current
    search* - `cycle = task.broadcast_cycle` - and no others. This does the
    same, task first, in one statement: the task UPDATE decides, and the log
    UPDATE works from the row it returned, so there is no moment at which the
    log has been touched for a task that then turns out not to qualify.

    Only the current cycle, deliberately. A PENDING row from an earlier search
    is something the product should never leave behind; if it has, this
    shortcut must not tidy it away - scan-broadcast-log.py looks for exactly
    that after a run.

    `allowed_from` is the status the caller knows the task to be in. The
    product only ever retires from BROADCASTING; the harness also uses this on
    a task still CREATED (never broadcast, so it has no rows to expire).
    """
    statuses = ",".join(q(s) for s in allowed_from)
    moved = psql(f"""WITH moved AS (
            UPDATE task SET status='UNFULFILLED', offer_expires_at=NULL, updated_at=now()
            WHERE id={q(task_id)} AND rider_id IS NULL AND status IN ({statuses})
            RETURNING id, broadcast_cycle),
        expired AS (
            UPDATE broadcast_log b SET outcome='EXPIRED', resolved_at=now()
            FROM moved m
            WHERE b.task_id=m.id AND b.cycle=m.broadcast_cycle AND b.outcome='PENDING'
            RETURNING 1)
        SELECT (SELECT count(*) FROM moved)""")
    return moved == "1"


def reissue_code(student: str, task_id: str) -> str:
    make_room(student, "reissue", 1)
    status, body = http("POST", f"/tasks/{task_id}/handover-code/reissue", login(student), {},
                        who=student, route="reissue")
    if status != 200 or not body.get("code"):
        raise RuntimeError(f"handover code reissue failed: {status} {body.get('code')} {body.get('message')}")
    return body["code"]


class Socket:
    """
    Just enough Socket.IO to listen on the API's /rt namespace: Engine.IO v4
    over HTTP long-polling, standard library only.

    connect() returns once the server has answered the namespace connect, one
    way or the other. Afterwards:
      .connected      True if the namespace accepted us (a "connect")
      .connect_error  the payload of a handshake refusal, or None
      .events         [(name, payload), ...] in arrival order
      .disconnected   True once the server has closed the namespace or session
    """

    def __init__(self, token: str, namespace: str = "/rt"):
        self.token, self.ns = token, namespace
        self.origin = BASE.split("/api/")[0]
        self.sid = None
        self.connected = False
        self.connect_error = None
        self.disconnected = False
        self.events = []
        self._answered = threading.Event()
        self._stop = False
        self._thread = None

    def _url(self) -> str:
        url = f"{self.origin}/socket.io/?EIO=4&transport=polling&t={os.urandom(4).hex()}"
        return url + (f"&sid={self.sid}" if self.sid else "")

    def _get(self, timeout=35) -> str:
        with urllib.request.urlopen(urllib.request.Request(self._url()), timeout=timeout) as r:
            return r.read().decode()

    def _post(self, payload: str) -> None:
        req = urllib.request.Request(self._url(), data=payload.encode(), method="POST",
                                     headers={"Content-Type": "text/plain;charset=UTF-8"})
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()

    def connect(self, wait_s: float = 8.0) -> "Socket":
        opened = self._get(timeout=15)
        if not opened.startswith("0"):
            raise RuntimeError(f"unexpected Engine.IO open packet: {opened[:80]}")
        self.sid = json.loads(opened[1:])["sid"]
        self._post(f"40{self.ns}," + json.dumps({"token": self.token}))
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()
        self._answered.wait(wait_s)
        return self

    def _pump(self) -> None:
        prefix = self.ns + ","
        while not self._stop:
            try:
                body = self._get()
            except Exception:
                self.disconnected = True
                self._answered.set()
                return
            for packet in body.split("\x1e"):
                if packet == "2":            # engine.io ping
                    try:
                        self._post("3")
                    except Exception:
                        pass
                elif packet == "1":          # engine.io close
                    self.disconnected = True
                    self._answered.set()
                    return
                elif packet.startswith("4"):
                    kind, rest = packet[1:2], packet[2:]
                    if rest.startswith(prefix):
                        rest = rest[len(prefix):]
                    elif rest.startswith(self.ns):
                        rest = rest[len(self.ns):]
                    if kind == "0":
                        self.connected = True
                        self._answered.set()
                    elif kind == "4":
                        try:
                            self.connect_error = json.loads(rest)
                        except ValueError:
                            self.connect_error = {"message": rest}
                        self._answered.set()
                    elif kind == "1":
                        self.disconnected = True
                        self._answered.set()
                    elif kind == "2":
                        try:
                            data = json.loads(rest[rest.index("["):])
                            self.events.append((data[0], data[1] if len(data) > 1 else None))
                        except ValueError:
                            pass

    def named(self, name: str) -> list:
        return [payload for n, payload in list(self.events) if n == name]

    def wait_for(self, predicate, timeout_s: float) -> bool:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(0.1)
        return predicate()

    def close(self) -> None:
        self._stop = True
        try:
            self._post("41" + self.ns + ",")
            self._post("1")
        except Exception:
            pass


def progress(ok: bool) -> None:
    sys.stdout.write("." if ok else "X")
    sys.stdout.flush()


def main(run) -> None:
    """Run a harness body, turning an environment block into its own exit code."""
    try:
        require_api()
        code = run()
    except Blocked as e:
        print(f"\nRESULT: BLOCKED - {e}")
        code = 3
    sys.exit(code)


def prepare_assigned_orders(pairs, total: int) -> list:
    """As prepare_carried_orders, but stops at ASSIGNED with the order READY."""
    return prepare_carried_orders(pairs, total, drive=drive_to_assigned)


def prepare_carried_orders(pairs, total: int, drive=None) -> list:
    """
    Drive several orders to PICKED_UP side by side.

    `pairs` is a list of (student, rider, payment method). The dispatcher only
    ticks every five seconds, so preparing a batch together is what keeps a
    multi-round harness to a minute rather than five. Each rider only ever
    accepts the task meant for them. A WALLET student is funded first.
    """
    for student, _rider, method in pairs:
        if method == "WALLET":
            uid = user_id(student)
            short = total - balance(uid)
            if short > 0:
                adjust_wallet(uid, short, f"race harness {RUN} fixture: funds one wallet order")
    with ThreadPoolExecutor(max_workers=len(pairs)) as pool:
        futures = [pool.submit(drive or drive_to_picked_up, s, r, m, total) for s, r, m in pairs]
        out = []
        for (s, r, m), f in zip(pairs, futures):
            fixture = f.result()
            fixture["method"] = m
            out.append(fixture)
        return out


def batches(rounds: int, methods) -> list:
    """Rounds grouped five at a time: racer i delivers what racer i+1 ordered."""
    plan, n = [], 0
    while n < rounds:
        batch = []
        for i in range(len(RACERS)):
            if n >= rounds:
                break
            batch.append((RACERS[(i + 1) % len(RACERS)], RACERS[i], methods[n % len(methods)]))
            n += 1
        plan.append(batch)
    return plan


# --------------------------------------------------------------------------
# For the end-to-end scripts that are not races: one request at a time, each
# with a stated expectation.
# --------------------------------------------------------------------------

class Checks:
    def __init__(self, name: str):
        self.name, self.count, self.failures, self.five_xx = name, 0, [], 0

    def check(self, what: str, ok, got="") -> bool:
        self.count += 1
        shown = str(got)[:300]
        print(f"  {'ok  ' if ok else 'FAIL'} {what}" + (f"   [{shown}]" if got != "" and not ok else ""))
        if not ok:
            self.failures.append(f"{what} - got {shown}" if got != "" else what)
        return bool(ok)

    def call(self, method, path, token, body=None):
        status, res = http(method, path, token, body)
        if status == 0:
            raise Blocked(f"api: lost the API during {method} {path}: {res.get('message')}")
        if status >= 500:
            self.five_xx += 1
            self.failures.append(f"{method} {path} answered {status} {res.get('code')}")
        return status, res

    def finish(self, minimum: int, proves: str) -> int:
        print(f"\nchecks: {self.count} | failed: {len(self.failures)} | 5xx: {self.five_xx}")
        for f in self.failures:
            print("  FAIL  " + f)
        if self.failures:
            print(f"RESULT: FAIL - {len(self.failures)} of {self.count} checks failed. {self.name}")
            return 1
        if self.count < minimum:
            print(f"RESULT: FAIL - the script stopped early; too few checks ran to mean anything. {self.name}")
            return 2
        print(f"RESULT: PASS - all {self.count} checks held: {proves}")
        return 0


def audit_rows(action: str, target_id: str, since: str) -> int:
    """Audit rows for one action on one target written since a database timestamp."""
    return int(psql(f"SELECT count(*) FROM audit_log WHERE action={q(action)} AND target_id={q(target_id)} "
                    f"AND created_at >= {q(since)}"))


def raw_login(identifier: str, password: str):
    """A sign-in that is not cached: for accounts a script made itself, or expects to be refused."""
    make_room("ip", "login", 1)
    status, body = http("POST", "/auth/login", None, {"identifier": identifier, "password": password},
                        who="ip", route="login")
    if status == 429:
        time.sleep(WINDOW_S)
        status, body = http("POST", "/auth/login", None, {"identifier": identifier, "password": password},
                            who="ip", route="login")
    return status, body


def register_student(label: str) -> dict:
    """
    A new student, registered the way the app does it: mobile OTP requested
    and verified (the development build returns the code), then
    POST /auth/register accepting the current privacy notice. Unverified, as
    every new student is. The OTP route allows three a minute per address, so
    a script should make one of these, not a dozen.
    """
    tag = os.urandom(4).hex()
    mobile = "+9194" + str(int(tag, 16) % 10 ** 8).zfill(8)
    email = f"{label}-{tag}@anurag.edu.in"
    password = "E2e-register-2026"
    for attempt in range(2):
        status, otp = http("POST", "/auth/mobile/request-otp", None, {"mobile": mobile})
        if status != 429:
            break
        time.sleep(WINDOW_S)
    if status not in (200, 201) or not otp.get("devCode"):
        raise Blocked(f"cannot request a sign-up code: {status} {otp.get('code')} "
                      "(the development build must return devCode)")
    status, res = http("POST", "/auth/mobile/verify-otp", None, {"challengeId": otp["challengeId"], "code": otp["devCode"]})
    if status not in (200, 201):
        raise Blocked(f"cannot verify the sign-up code: {status} {res.get('code')}")
    _, notice = http("GET", "/legal/privacy-notice")
    status, tokens = http("POST", "/auth/register", None, {
        "name": f"E2E {label.title()} {tag}", "mobile": mobile, "email": email, "password": password,
        "collegeId": college_id(), "mobileOtpChallengeId": otp["challengeId"],
        "privacyNoticeVersion": notice.get("version")})
    if status not in (200, 201) or "accessToken" not in tokens:
        raise Blocked(f"cannot register a student: {status} {tokens.get('code')} {tokens.get('message')}")
    uid = psql(f'SELECT id FROM "user" WHERE email={q(email)}')
    return {"id": uid, "email": email, "mobile": mobile, "password": password, "name": f"E2E {label.title()} {tag}",
            "accessToken": tokens["accessToken"], "refreshToken": tokens.get("refreshToken")}


def register_shop(label: str) -> dict:
    """A new shop registered through POST /shops/register (five a minute per address). PENDING until approved."""
    tag = os.urandom(4).hex()
    c = catalog()
    email = f"{label}-{tag}@example.com"
    docs = [{"docType": d, "fileKey": f"shop-docs/e2e-{tag}/{d.lower()}.pdf", "fileName": f"{d.lower()}.pdf",
             "mimeType": "application/pdf", "sizeBytes": 1000}
            for d in ("ESTABLISHMENT_LICENCE", "FRONTAGE_PHOTO", "OWNER_PHOTO_ID")]
    _, notice = http("GET", "/legal/privacy-notice")
    body = {"name": f"E2E {label.title()} {tag}", "category": "STATIONERY", "ownerName": "E2E Shop Owner",
            "ownerMobile": "+9193" + str(int(tag, 16) % 10 ** 8).zfill(8), "ownerEmail": email, "password": PASSWORD,
            "address": "Near the main gate, Venkatapur", "city": "Hyderabad", "state": "Telangana",
            "latitude": c["shop_lat"] + 0.001, "longitude": c["shop_lng"] + 0.001,
            "locationType": "OFF_CAMPUS", "collegeId": college_id(), "documents": docs,
            "privacyNoticeVersion": notice.get("version")}
    for attempt in range(2):
        status, res = http("POST", "/shops/register", None, body)
        if status != 429:
            break
        time.sleep(WINDOW_S)
    if status != 201:
        raise Blocked(f"cannot register a shop: {status} {res.get('code')} {res.get('message')}")
    listing = psql("SELECT l.id FROM shop_listing l JOIN shop_staff s ON s.shop_id=l.shop_id "
                   f'JOIN "user" u ON u.id=s.user_id WHERE u.email={q(email)}')
    return {"listing_id": listing, "email": email, "name": body["name"],
            "owner_id": psql(f'SELECT id FROM "user" WHERE email={q(email)}')}


def escalations(admin_token: str) -> list:
    """Every escalated task the administrator can see: the list is paged, oldest first."""
    items, cursor = [], None
    for _ in range(50):
        status, page = http("GET", "/admin/escalations?limit=100" + (f"&cursor={cursor}" if cursor else ""), admin_token)
        if status != 200:
            raise RuntimeError(f"GET /admin/escalations -> {status} {page.get('code')}")
        items += page.get("items", [])
        cursor = page.get("nextCursor")
        if not cursor:
            break
    return items
