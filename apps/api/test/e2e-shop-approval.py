#!/usr/bin/env python3
"""
End-to-end access checks: what an account may reach before, and after, an
administrator has said yes to it. Not a race - one request at a time, each
with a stated expectation - but against the live API and its socket, because
guards, strategies and gateway middleware only compose for real there.

  1. A shop owner who has registered (POST /shops/register) but not been
     approved can sign in, see their own shop's status, read /auth/me and sign
     out - and nothing else: every other route answers 403 SHOP_NOT_APPROVED,
     and the /rt socket refuses them. How the socket refuses is reported as
     observed (handshake connect_error, or connect then an 'exception' event
     then disconnect); either is a refusal, joining is not.
  2. A pending shop is invisible to another shop's owner, and another
     college's administrator cannot approve it.
  3. Once the college's own administrator approves it, the *same token* opens
     browse and the catalog and the socket connects. Student-only routes stay
     shut, now because of the role.
  4. The admin shop queue survives a nonsense page size and caps a huge one.
  5. Student routes refuse a shop account (/verification/*).
  6. Suspending a student drops their open socket and revokes their refresh
     token.

Each run registers one new shop (a unique name, email and number), so the
admin queue gains one approved shop per run.

    python3 apps/api/test/e2e-shop-approval.py [BASE]
"""
import os
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

ADMIN = "admin@anurag.edu.in"
OTHER_ADMIN = "admin@rit.edu.in"
DROPME = "dropme@anurag.edu.in"

checks = 0
failures = []
five_xx = 0


def check(what: str, ok: bool, got: str = "") -> bool:
    global checks
    checks += 1
    print(f"  {'ok  ' if ok else 'FAIL'} {what}" + (f"   [{got}]" if got and not ok else ""))
    if not ok:
        failures.append(f"{what} - got {got}")
    return ok


def call(method, path, token, body=None):
    global five_xx
    status, res = h.http(method, path, token, body)
    if status == 0:
        raise h.Blocked(f"lost the API during {method} {path}: {res.get('message')}")
    if status >= 500:
        five_xx += 1
        failures.append(f"{method} {path} answered {status} {res.get('code')}")
    return status, res


def expect(method, path, token, status_wanted, code_wanted=None, body=None, label=None):
    status, res = call(method, path, token, body)
    ok = status == status_wanted and (code_wanted is None or res.get("code") == code_wanted)
    want = f"{status_wanted}" + (f" {code_wanted}" if code_wanted else "")
    check(f"{label or ''}{method} {path.split('?')[0] if len(path) > 70 else path} -> {want}", ok,
          f"{status} {res.get('code') or ''}".strip())
    return status, res


def socket_outcome(token):
    """How the /rt socket treats this token, as observed."""
    sock = h.Socket(token).connect()
    sock.wait_for(lambda: sock.disconnected or sock.connect_error is not None, 2.5)
    exceptions = sock.named("exception")
    if sock.connect_error is not None:
        how = f"handshake refused: connect_error {sock.connect_error}"
        code = (sock.connect_error.get("data") or {}).get("code") or sock.connect_error.get("message")
        joined = False
    elif sock.connected and sock.disconnected:
        how = f"connect, then {'exception ' + str(exceptions[0]) if exceptions else 'no exception event'}, then disconnect"
        code = exceptions[0].get("code") if exceptions and isinstance(exceptions[0], dict) else None
        joined = False
    elif sock.connected:
        how, code, joined = "connected and stayed connected", None, True
    else:
        how, code, joined = "no answer from the socket", None, False
    sock.close()
    return joined, code, how


def run() -> int:
    college = h.college_id()
    cat = h.catalog()
    cafe_listing = cat["listing_id"]
    admin, other_admin, cafe_owner = h.login(ADMIN), h.login(OTHER_ADMIN), h.login(h.SHOP_OWNER)

    # ---- 1. register, sign in, and find out how little that buys ----------
    print("1. An unapproved shop owner")
    number = "+9198" + str(int(h.RUN, 16) % 10 ** 8).zfill(8)
    email = f"pending-{h.RUN}@example.com"
    docs = [{"docType": d, "fileKey": f"shop-docs/e2e-{h.RUN}/{d.lower()}.pdf", "fileName": f"{d.lower()}.pdf",
             "mimeType": "application/pdf", "sizeBytes": 1000}
            for d in ("ESTABLISHMENT_LICENCE", "FRONTAGE_PHOTO", "OWNER_PHOTO_ID")]
    status, res = call("POST", "/shops/register", None, {
        "name": f"E2E Pending Stationers {h.RUN}", "category": "STATIONERY", "ownerName": "Pending Owner",
        "ownerMobile": number, "ownerEmail": email, "password": h.PASSWORD,
        "address": "Near the main gate, Venkatapur", "city": "Hyderabad", "state": "Telangana",
        "latitude": cat["shop_lat"] + 0.001, "longitude": cat["shop_lng"] + 0.001,
        "locationType": "OFF_CAMPUS", "collegeId": college, "documents": docs})
    if status == 429:
        raise h.Blocked("POST /shops/register is rate limited (5 a minute per address); run again in a minute")
    if not check("POST /shops/register -> 201", status == 201, f"{status} {res.get('code')} {res.get('message')}"):
        return finish()
    h.make_room("ip", "login", 1)
    status, session = call("POST", "/auth/login", None, {"identifier": email, "password": h.PASSWORD})
    if status == 429:
        time.sleep(61)
        status, session = call("POST", "/auth/login", None, {"identifier": email, "password": h.PASSWORD})
    if not check("the new owner can sign in", status == 200 and "accessToken" in session, f"{status} {session.get('code')}"):
        return finish()
    token = session["accessToken"]

    status, mine = expect("GET", "/shops/mine", token, 200)
    listing = h.psql("SELECT l.id FROM shop_listing l JOIN shop_staff s ON s.shop_id=l.shop_id "
                     f'JOIN "user" u ON u.id=s.user_id WHERE u.email={h.q(email)}')
    check("the new shop's listing is PENDING_VERIFICATION",
          h.psql(f"SELECT status FROM shop_listing WHERE id={h.q(listing)}") == "PENDING_VERIFICATION", listing)
    expect("GET", "/auth/me", token, 200)
    closed = [("GET", "/orders", None), ("GET", "/rider/status", None), ("GET", "/browse/shops", None),
              ("GET", "/browse/items?q=sam", None), ("GET", "/browse/delivery-points", None),
              ("POST", "/uploads/url", {"kind": "SHOP_DOCUMENT", "contentType": "application/pdf", "sizeBytes": 1000}),
              ("GET", f"/shops/{listing}/catalog", None), ("GET", f"/shops/{listing}/orders", None)]
    for method, path, body in closed:
        expect(method, path, token, 403, "SHOP_NOT_APPROVED", body)
    joined, code, how = socket_outcome(token)
    print(f"       socket /rt, as observed: {how}")
    check("the /rt socket refuses the unapproved owner", not joined, how)
    check("the socket refusal names SHOP_NOT_APPROVED", code == "SHOP_NOT_APPROVED", how)
    socket_refusal = how

    # ---- 2. nobody else can see or approve it ------------------------------
    print("2. A pending shop, seen from outside")
    expect("GET", f"/browse/shops/{listing}", cafe_owner, 404, "SHOP_NOT_AVAILABLE", label="another shop's owner: ")
    status, res = call("POST", f"/admin/shops/{listing}/approve", other_admin, {})
    check("another college's admin cannot approve it", status in (403, 404), f"{status} {res.get('code')}")
    check("...and it is still pending",
          h.psql(f"SELECT status FROM shop_listing WHERE id={h.q(listing)}") == "PENDING_VERIFICATION")
    status, res = call("GET", f"/shops/{cafe_listing}/orders", other_admin)
    check("another college's admin cannot read this college's shop queue", status in (403, 404),
          f"{status} {res.get('code')}")

    # ---- 4. the admin queue's page size ------------------------------------
    print("3. The admin shop queue")
    status, res = expect("GET", "/admin/shops/queue?limit=abc", admin, 200)
    check("...and the pending shop is in it", any(listing in str(i) for i in res.get("items", [])),
          f"{len(res.get('items', []))} items")
    status, res = expect("GET", "/admin/shops/queue?limit=100000", admin, 200)
    check("a huge limit returns at most 100 items", len(res.get("items", [])) <= 100, f"{len(res.get('items', []))}")

    # ---- 3. approval opens the same token ----------------------------------
    print("4. After the college's own admin approves it (same token, no new sign-in)")
    status, res = call("POST", f"/admin/shops/{listing}/approve", admin, {})
    check("POST /admin/shops/:listingId/approve -> 200", status in (200, 201), f"{status} {res.get('code')}")
    expect("GET", "/browse/shops", token, 200)
    expect("GET", f"/shops/{listing}/catalog", token, 200)
    joined, code, how = socket_outcome(token)
    check("the /rt socket now connects and stays connected", joined, how)
    for path in ("/orders", "/rider/status"):
        status, res = call("GET", path, token)
        check(f"GET {path} stays 403 (a shop is not a student), and no longer says SHOP_NOT_APPROVED",
              status == 403 and res.get("code") != "SHOP_NOT_APPROVED", f"{status} {res.get('code')}")

    # ---- 5. student routes and a shop account -------------------------------
    print("5. Student-only routes")
    status, res = call("GET", "/verification/me", cafe_owner)
    check("GET /verification/me refuses a shop owner", status == 403, f"{status} {res.get('code')}")
    expect("POST", "/auth/logout", token, 200, body={"refreshToken": session.get("refreshToken")})

    # ---- 6. suspension ------------------------------------------------------
    print("6. Suspending a student")
    uid = h.user_id(DROPME)
    if h.psql(f'SELECT status FROM "user" WHERE id={h.q(uid)}') != "ACTIVE":
        status, res = call("POST", f"/admin/verification/students/{uid}/reinstate", admin, {})
        check("(setup) reinstating the account left suspended by the last run", status in (200, 201),
              f"{status} {res.get('code')}")
    h.make_room("ip", "login", 1)
    status, student = call("POST", "/auth/login", None, {"identifier": DROPME, "password": h.PASSWORD})
    if status == 429:
        time.sleep(61)
        status, student = call("POST", "/auth/login", None, {"identifier": DROPME, "password": h.PASSWORD})
    if check("the student signs in", status == 200, f"{status} {student.get('code')}"):
        sock = h.Socket(student["accessToken"]).connect()
        time.sleep(1.0)
        check("their /rt socket is connected", sock.connected and not sock.disconnected)
        status, res = call("POST", f"/admin/verification/students/{uid}/suspend", admin,
                           {"reason": "E2E check: a suspension must end live sessions"})
        check("POST /admin/verification/students/:id/suspend -> 200", status in (200, 201), f"{status} {res.get('code')}")
        check("the open socket is dropped within 5 seconds", sock.wait_for(lambda: sock.disconnected, 5.0))
        sock.close()
        status, res = call("POST", "/auth/refresh", None, {"refreshToken": student.get("refreshToken")})
        check("their refresh token no longer works", status in (401, 403), f"{status} {res.get('code')}")
        status, res = call("GET", "/auth/me", student["accessToken"])
        check("their access token is refused", status in (401, 403), f"{status} {res.get('code')}")

    print(f"\nsocket refusal of an unapproved shop owner, as observed: {socket_refusal}")
    return finish()


def finish() -> int:
    print(f"checks: {checks} | failed: {len(failures)} | 5xx: {five_xx}")
    for f in failures:
        print("  FAIL  " + f)
    if failures:
        print(f"RESULT: FAIL - {len(failures)} of {checks} access checks failed. e2e-shop-approval")
        return 1
    if checks < 30:
        print("RESULT: FAIL - the script stopped early; too few checks ran to mean anything. e2e-shop-approval")
        return 2
    print(f"RESULT: PASS - all {checks} access checks held: an unapproved shop account reaches only its own "
          "status, approval opens the same token, and a suspension ends live sessions.")
    return 0


h.main(run)
