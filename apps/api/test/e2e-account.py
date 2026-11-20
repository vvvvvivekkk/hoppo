#!/usr/bin/env python3
"""
A person's own account: what deleting it really erases, who may delete, and
what a deactivated college's users can still do.

  1. Deletion leaves no residue. A student registered here signs in from a
     named device, is given an avatar and a device token, exports their data,
     and deletes their account. Afterwards, checked in the database rather
     than taken from the response: the name, mobile and email are gone from
     the user row; no session row still carries their IP address or user
     agent; the avatar reference and device tokens are gone; no audit row
     written at or after the deletion contains their name, number or email;
     and every item the response lists under `erased` really was erased - the
     list may not claim more than was done.
  2. Deletion is for students. An administrator, a super administrator and a
     shop owner are refused at the door (by role), not asked for a password.
     Only wrong passwords are ever sent, so nothing is at risk if the door is open.
  3. A deactivated college is closed to its users altogether: a refresh token
     issued before the deactivation must not buy a new session.

Each run leaves one deleted account and one deactivated "E2E Account College".

    python3 apps/api/test/e2e-account.py [BASE]
"""
import json
import os
import re
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

c = h.Checks("e2e-account")
check, call = c.check, c.call
AGENT = "HoppoE2E-Device/1.0 (account residue check)"


def login_as_device(email: str, password: str):
    """A sign-in with a user agent we can look for afterwards."""
    import urllib.request
    import urllib.error
    h.make_room("ip", "login", 1)
    req = urllib.request.Request(f"{h.BASE}/auth/login", method="POST",
                                 data=json.dumps({"identifier": email, "password": password}).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def deletion_residue() -> None:
    print("1. Deleting an account leaves nothing of the person behind")
    s = h.register_student("leaver")
    uid = s["id"]
    status, session = login_as_device(s["email"], s["password"])
    if not check("the student signs in from a named device", status == 200, f"{status} {session.get('code')}"):
        return
    token = session["accessToken"]
    avatar = f"avatars/{uid}/e2e-avatar.png"
    h.psql(f'UPDATE "user" SET avatar_url={h.q(avatar)} WHERE id={h.q(uid)}')
    h.psql("INSERT INTO device_token (id, user_id, platform, token, last_seen_at, created_at) "
           f"VALUES (gen_random_uuid()::text, {h.q(uid)}, 'ANDROID', {h.q('e2e-device-token-' + uid)}, now(), now())")
    sessions_before = h.psql(f"SELECT count(*) FILTER (WHERE user_agent IS NOT NULL) || '/' || count(*) "
                             f"FROM refresh_token WHERE user_id={h.q(uid)}")
    check("before deletion there are session rows carrying a user agent", not sessions_before.startswith("0/"), sessions_before)
    # A rename, before the deletion: the audit row must say *that* the name
    # changed, not what it was or became - an audit row can never be scrubbed,
    # so a name written into one outlives the account.
    renamed = f"E2E Renamed {uid[:6]}"
    rename_since = h.db_now()
    status, res = call("PATCH", "/account/profile", token, {"name": renamed})
    check("PATCH /account/profile {name} -> 200", status == 200, f"{status} {res.get('code')}")
    rows = h.psql("SELECT COALESCE(detail::text,'') FROM audit_log WHERE action='PROFILE_UPDATED' "
                  f"AND (actor_id={h.q(uid)} OR target_id={h.q(uid)}) AND created_at >= {h.q(rename_since)}")
    check("the rename wrote one PROFILE_UPDATED audit row", len(rows.splitlines()) == 1 and rows != "", rows[:200])
    check("...which records that the name changed, and neither the old name nor the new one",
          "name" in rows and s["name"] not in rows and renamed not in rows, rows[:300])
    s["old_name"], s["name"] = s["name"], renamed

    status, export = call("GET", "/account/export", token)
    check("GET /account/export -> 200, their own account", status == 200 and export.get("account", {}).get("email") == s["email"], status)

    status, res = call("POST", "/account/delete", token, {"password": "not-the-password"})
    check("a wrong password is refused: 403 PASSWORD_INCORRECT", (status, res.get("code")) == (403, "PASSWORD_INCORRECT"),
          f"{status} {res.get('code')}")
    since = h.db_now()
    status, res = call("POST", "/account/delete", token, {"password": s["password"]})
    if not check("POST /account/delete -> 200, DEACTIVATED", status == 200 and res.get("status") == "DEACTIVATED",
                 f"{status} {res.get('code')} {res.get('message')}"):
        return
    erased = res.get("erased", [])
    caveats = " ".join(res.get("caveats") or [])
    check("the response has `caveats`, and they say past audit entries cannot be altered",
          isinstance(res.get("caveats"), list) and "audit" in caveats.lower()
          and re.search(r"cannot be (altered|changed|edited|removed)|append-only|kept as (they were|written)", caveats, re.I) is not None,
          res.get("caveats"))
    files = res.get("storedFiles")
    check("the response reports stored files as expected vs removed, and does not claim more removed than expected",
          isinstance(files, dict) and isinstance(files.get("expected"), int) and isinstance(files.get("removed"), int)
          and 0 <= files["removed"] <= files["expected"], files)
    national = re.sub(r"\D", "", s["mobile"])[-10:]

    row = h.psql("SELECT status || '|' || name || '|' || mobile || '|' || email || '|' || COALESCE(avatar_url,'') "
                 f'FROM "user" WHERE id={h.q(uid)}')
    check("the user row is DEACTIVATED and no longer holds the name, mobile or email",
          row.startswith("DEACTIVATED|") and s["name"] not in row and national not in re.sub(r"\D", "", row)
          and s["email"] not in row, row)
    check("the avatar reference is gone from the user row", avatar not in row, row)
    residue = h.psql("SELECT count(*) FILTER (WHERE ip_address IS NOT NULL) || ' with an IP address, ' || "
                     "count(*) FILTER (WHERE user_agent IS NOT NULL) || ' with a user agent, of ' || count(*) "
                     f"FROM refresh_token WHERE user_id={h.q(uid)}")
    check("no session row still carries the person's IP address or user agent",
          residue.startswith("0 with an IP address, 0 with a user agent"), residue)
    check("no session of theirs is still usable",
          h.psql(f"SELECT count(*) FROM refresh_token WHERE user_id={h.q(uid)} AND revoked_at IS NULL AND expires_at > now()") == "0")
    check("their device tokens are gone", h.psql(f"SELECT count(*) FROM device_token WHERE user_id={h.q(uid)}") == "0")
    check("their student profile no longer holds the roll number or department",
          h.psql(f"SELECT count(*) FROM student_profile WHERE user_id={h.q(uid)} AND "
                 "(COALESCE(roll_number,'') <> '' OR COALESCE(department,'') <> '') "
                 "AND roll_number NOT LIKE 'deleted%' AND roll_number NOT LIKE 'DELETED%'") == "0",
          h.psql(f"SELECT roll_number || '/' || department FROM student_profile WHERE user_id={h.q(uid)}"))

    # Nothing written from the deletion onwards may name them.
    late = h.psql("SELECT action || ' ' || COALESCE(detail::text,'') || ' ' || COALESCE(user_agent,'') FROM audit_log "
                  f"WHERE (actor_id={h.q(uid)} OR target_id={h.q(uid)}) AND created_at >= {h.q(since)}")
    leaks = [what for what, needle in (("name", s["name"]), ("earlier name", s["old_name"]), ("email", s["email"]),
                                       ("mobile", s["mobile"]), ("mobile digits", national)) if needle in late]
    check("audit rows written at or after the deletion do not contain their name, number or email", not leaks,
          f"{leaks}: {late[:200]}")
    check("there is an ACCOUNT_DELETED audit row", "ACCOUNT_DELETED" in late, late[:120])
    status, log = call("GET", f"/admin/audit-log?targetId={uid}&limit=20", h.login("admin@anurag.edu.in"))
    shown = json.dumps(log)
    check("the audit log viewer does not show their name, number or email for any row about them",
          s["name"] not in shown and s["email"] not in shown and national not in re.sub(r"[\s\-]", "", shown),
          [k for k, v in (("name", s["name"]), ("email", s["email"]), ("mobile", national)) if v in re.sub(r"[\s\-]", "", shown)])

    # The response's own claims, each held against the database. The wording
    # of the list is the API's; a claim is matched by the thing it names.
    proof = {
        "name": s["name"] not in row,
        "mobile": national not in re.sub(r"\D", "", row),
        "email": s["email"] not in row,
        "photo": avatar not in row, "avatar": avatar not in row,
        "device": h.psql(f"SELECT count(*) FROM device_token WHERE user_id={h.q(uid)}") == "0",
        "session": residue.startswith("0 with an IP address, 0 with a user agent"),
        "sign-in": residue.startswith("0 with an IP address, 0 with a user agent"),
        "roll number": h.psql(f"SELECT count(*) FROM student_profile WHERE user_id={h.q(uid)} "
                              f"AND roll_number LIKE '26EG%'") == "0",
    }
    overstated = [item for item in erased for key, held in proof.items() if key in item.lower() and not held]
    check("everything the response lists under `erased` really was erased (the list does not overstate)",
          not overstated, f"claimed but still present: {sorted(set(overstated))}; erased = {erased}")
    named = " ".join(erased).lower()
    check("the `erased` list names the name, the mobile number and the email", all(k in named for k in ("name", "mobile", "email")), erased)

    status, res = call("GET", "/auth/me", token)
    check("the old access token answers 401", status == 401, f"{status} {res.get('code')}")
    status, res = call("POST", "/auth/refresh", None, {"refreshToken": session.get("refreshToken")})
    check("the old refresh token is refused", status in (401, 403), f"{status} {res.get('code')}")
    status, res = h.raw_login(s["email"], s["password"])
    check("signing in again is refused", status in (401, 403), f"{status} {res.get('code')}")


def students_only() -> None:
    print("2. Only a student can delete or export an account")
    for who in ("super@hoppo.app", "admin@anurag.edu.in", h.SHOP_OWNER):
        token = h.login(who)
        # Only ever a wrong password: if the route lets them in, the answer is
        # PASSWORD_INCORRECT and nothing is deleted.
        status, res = call("POST", "/account/delete", token, {"password": "deliberately-wrong-password"})
        check(f"{who} is refused POST /account/delete by role, before any password is looked at",
              status == 403 and res.get("code") != "PASSWORD_INCORRECT", f"{status} {res.get('code')}")
        status, res = call("GET", "/account/export", token)
        check(f"{who} is refused GET /account/export", status == 403, f"{status} {res.get('code')}")
        status, me = call("GET", "/auth/me", token)
        check(f"...and {who} is still ACTIVE", status == 200 and me.get("user", {}).get("status") == "ACTIVE", status)


def deactivated_college() -> None:
    print("3. A deactivated college is closed, refresh tokens included")
    boss = h.login("super@hoppo.app")
    tag = os.urandom(3).hex()
    email = f"e2e-acct-admin-{tag}@example.com"
    status, college = call("POST", "/platform/colleges", boss, {
        "name": f"E2E Account College {tag}", "address": "2 Test Road", "city": "Hyderabad", "state": "Telangana",
        "latitude": 17.6, "longitude": 78.5})
    if not check("a college is created", status == 201, f"{status} {college.get('code')}"):
        return
    cid = college["id"]
    status, res = call("POST", f"/platform/colleges/{cid}/admins", boss,
                       {"name": "E2E Account Admin", "mobile": "+9192" + str(int(tag, 16) % 10 ** 8).zfill(8),
                        "email": email, "password": h.PASSWORD})
    check("...with an administrator", status == 201, f"{status} {res.get('code')}")
    status, session = h.raw_login(email, h.PASSWORD)
    if not check("who signs in and holds a refresh token", status == 200 and session.get("refreshToken"), f"{status} {session.get('code')}"):
        return
    status, renewed = call("POST", "/auth/refresh", None, {"refreshToken": session["refreshToken"]})
    check("while the college is active, the refresh token renews the session", status in (200, 201) and renewed.get("refreshToken"),
          f"{status} {renewed.get('code')}")
    current = renewed.get("refreshToken") or session["refreshToken"]
    live = h.Socket(renewed.get("accessToken") or session["accessToken"]).connect()
    time.sleep(0.8)
    check("their /rt socket is connected while the college is active", live.connected and not live.disconnected)
    status, res = call("POST", f"/platform/colleges/{cid}/deactivate", boss, {"reason": "E2E check: refresh after deactivation"})
    check("the college is deactivated", status == 200 and res.get("status") == "INACTIVE", f"{status} {res.get('code')}")
    status, res = call("GET", "/auth/me", renewed.get("accessToken") or session["accessToken"])
    check("their access token answers 403 COLLEGE_INACTIVE", (status, res.get("code")) == (403, "COLLEGE_INACTIVE"),
          f"{status} {res.get('code')}")
    status, res = call("POST", "/auth/refresh", None, {"refreshToken": current})
    check("POST /auth/refresh is refused for a user of the deactivated college (no new token pair)",
          status in (401, 403) and "accessToken" not in res, f"{status} {res.get('code') or 'a new token pair was issued'}")
    uid = h.psql(f'SELECT id FROM "user" WHERE email={h.q(email)}')
    check("their refresh tokens are revoked in the database",
          h.psql(f"SELECT count(*) FROM refresh_token WHERE user_id={h.q(uid)} AND revoked_at IS NULL AND expires_at > now()") == "0",
          h.psql(f"SELECT count(*) FROM refresh_token WHERE user_id={h.q(uid)} AND revoked_at IS NULL AND expires_at > now()"))
    check("the socket that was open is dropped within 5 seconds", live.wait_for(lambda: live.disconnected, 5.0))
    live.close()
    again = h.Socket(renewed.get("accessToken") or session["accessToken"]).connect()
    again.wait_for(lambda: again.disconnected or again.connect_error is not None, 3.0)
    said = [p.get("code") for p in again.named("exception") if isinstance(p, dict)]
    code = said[0] if said else ((again.connect_error or {}).get("data") or {}).get("code") or (again.connect_error or {}).get("message")
    check("a new socket is refused, naming COLLEGE_INACTIVE",
          (again.disconnected or again.connect_error is not None) and code == "COLLEGE_INACTIVE",
          f"connected={again.connected} disconnected={again.disconnected} connect_error={again.connect_error} exception={said}")
    again.close()


def run() -> int:
    deletion_residue()
    students_only()
    deactivated_college()
    return c.finish(38, "a deleted account leaves no personal residue and says no more than it did, only students can "
                        "delete, and a deactivated college's sessions cannot be renewed.")


h.main(run)
