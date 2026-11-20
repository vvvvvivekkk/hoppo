#!/usr/bin/env python3
"""
The administrator's buttons, pressed for real.

The consoles' own walk checks these actions against intercepted requests: it
proves the screen sends the right thing. This proves the API does the right
thing with it - every mutating action an administrator has, against the live
API and database, on fixtures this script creates and puts back:

  1. Suspend a student (one registered here, through the sign-up routes):
     their access token stops working, their open socket is dropped, their
     refresh token is dead, the detail screen's data says who and why, and it
     is in the audit log. Reinstate: they can sign in again.
  2. Suspend a shop (one registered and approved here): it leaves the
     students' browse list while its owner can still reach it; reinstate puts
     it back; a second reinstate is refused. Left suspended at the end, so the
     browse list does not grow by a shop per run.
  3. Save a configuration value: stored, returned, audited with before and
     after, restored.
  4. Reorder the delivery points: the students' picker follows the new order;
     an incomplete list is refused; the original order is restored.
  5. Resolve a real escalation (an order carried to PICKED_UP, then the
     configured number of wrong codes): the task completes, the rider is paid
     once, the requester's socket is told an administrator resolved it, it
     leaves the list, and a second resolve is refused.

Not a race; one request at a time.

    python3 apps/api/test/e2e-admin-actions.py [BASE]
"""
import os
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

ADMIN = "admin@anurag.edu.in"
c = h.Checks("e2e-admin-actions")
check, call = c.check, c.call


def student_suspension(admin) -> None:
    print("1. Suspend and reinstate a student")
    s = h.register_student("suspendee")
    check("a student is registered through the sign-up routes", bool(s["id"]))
    sock = h.Socket(s["accessToken"]).connect()
    time.sleep(0.8)
    check("their /rt socket is connected", sock.connected and not sock.disconnected)
    since = h.db_now()
    reason = "E2E check: suspension must end live sessions"
    status, res = call("POST", f"/admin/verification/students/{s['id']}/suspend", admin, {"reason": reason})
    check("POST /admin/verification/students/:id/suspend succeeds and reports SUSPENDED",
          status in (200, 201) and res.get("status") == "SUSPENDED", f"{status} {res.get('code')} {res.get('status')}")
    check("...naming who did it, and that sessions were revoked",
          (res.get("suspendedBy") or {}).get("id") == h.user_id(ADMIN) and res.get("sessionsRevoked") not in (None, 0, False),
          {k: res.get(k) for k in ("suspendedBy", "sessionsRevoked")})
    check("the open socket is dropped within 5 seconds", sock.wait_for(lambda: sock.disconnected, 5.0))
    sock.close()
    status, res = call("GET", "/auth/me", s["accessToken"])
    check("their access token is refused", status in (401, 403), f"{status} {res.get('code')}")
    status, res = call("POST", "/auth/refresh", None, {"refreshToken": s["refreshToken"]})
    check("their refresh token is refused", status in (401, 403), f"{status} {res.get('code')}")
    status, res = h.raw_login(s["email"], s["password"])
    check("signing in is refused: 403 ACCOUNT_SUSPENDED", (status, res.get("code")) == (403, "ACCOUNT_SUSPENDED"),
          f"{status} {res.get('code')}")
    status, detail = call("GET", f"/admin/students/{s['id']}", admin)
    susp = detail.get("suspension") or {}
    check("GET /admin/students/:id shows the suspension, its reason and who",
          status == 200 and detail.get("student", {}).get("status") == "SUSPENDED" and susp.get("reason") == reason
          and (susp.get("suspendedBy") or {}).get("id") == h.user_id(ADMIN), susp)
    check("one STUDENT_SUSPENDED audit row since the action", h.audit_rows("STUDENT_SUSPENDED", s["id"], since) == 1,
          h.audit_rows("STUDENT_SUSPENDED", s["id"], since))
    status, res = call("POST", f"/admin/verification/students/{s['id']}/suspend",
                       h.login("admin@rit.edu.in"), {"reason": "cross-tenant attempt"})
    check("another college's admin cannot act on this student", status in (403, 404), f"{status} {res.get('code')}")

    since = h.db_now()
    status, res = call("POST", f"/admin/verification/students/{s['id']}/reinstate", admin, {})
    check("POST .../reinstate succeeds and reports ACTIVE", status in (200, 201) and res.get("status") == "ACTIVE",
          f"{status} {res.get('code')}")
    status, session = h.raw_login(s["email"], s["password"])
    check("the student can sign in again", status == 200 and "accessToken" in session, f"{status} {session.get('code')}")
    if status == 200:
        status, me = call("GET", "/auth/me", session["accessToken"])
        check("...and is ACTIVE", status == 200 and me.get("user", {}).get("status") == "ACTIVE", status)
        status, res = call("POST", "/auth/refresh", None, {"refreshToken": s["refreshToken"]})
        check("the refresh token from before the suspension stays dead", status in (401, 403), f"{status} {res.get('code')}")
    check("one STUDENT_REINSTATED audit row", h.audit_rows("STUDENT_REINSTATED", s["id"], since) == 1,
          h.audit_rows("STUDENT_REINSTATED", s["id"], since))
    # Tidy up: the account deletes itself, the proper way.
    if session.get("accessToken"):
        call("POST", "/account/delete", session["accessToken"], {"password": s["password"]})


def shop_suspension(admin) -> None:
    print("2. Suspend and reinstate a shop")
    shop = h.register_shop("suspendable")
    lid = shop["listing_id"]
    status, res = call("POST", f"/admin/shops/{lid}/approve", admin, {})
    check("a shop is registered and approved", status in (200, 201), f"{status} {res.get('code')}")
    owner_status, owner = h.raw_login(shop["email"], h.PASSWORD)
    student = h.login(h.RACERS[0])
    listed = lambda: any(s["listingId"] == lid for s in call("GET", "/browse/shops?limit=100", student)[1].get("items", []))
    check("students can see it in the browse list", listed())

    since = h.db_now()
    reason = "E2E check: a suspended shop leaves the browse list"
    status, res = call("POST", f"/admin/shops/{lid}/suspend", admin, {"reason": reason})
    check("POST /admin/shops/:listingId/suspend succeeds and reports SUSPENDED",
          status in (200, 201) and res.get("status") == "SUSPENDED" and res.get("reason") == reason,
          f"{status} {res.get('code')} {res.get('status')}")
    check("the listing row is SUSPENDED", h.psql(f"SELECT status FROM shop_listing WHERE id={h.q(lid)}") == "SUSPENDED")
    check("it is gone from the students' browse list", not listed())
    status, res = call("GET", f"/browse/shops/{lid}", student)
    check("...and its page is not served to a student", status in (403, 404), f"{status} {res.get('code')}")
    if owner_status == 200:
        status, res = call("GET", f"/shops/{lid}/orders", owner["accessToken"])
        check("its owner can still reach the order queue (in-flight orders must finish)", status == 200,
              f"{status} {res.get('code')}")
    status, detail = call("GET", f"/admin/shops/{lid}", admin)
    susp = detail.get("suspension") or {}
    check("GET /admin/shops/:listingId shows the suspension, its reason and who",
          status == 200 and susp.get("reason") == reason and (susp.get("suspendedBy") or {}).get("id") == h.user_id(ADMIN), susp)
    check("one SHOP_SUSPENDED audit row", h.audit_rows("SHOP_SUSPENDED", lid, since) == 1,
          h.audit_rows("SHOP_SUSPENDED", lid, since))

    since = h.db_now()
    status, res = call("POST", f"/admin/shops/{lid}/reinstate", h.login("admin@rit.edu.in"), {})
    check("another college's admin cannot reinstate it", status in (403, 404), f"{status} {res.get('code')}")
    status, res = call("POST", f"/admin/shops/{lid}/reinstate", admin, {})
    check("POST /admin/shops/:listingId/reinstate -> 200, ACTIVE", status == 200 and res.get("status") == "ACTIVE",
          f"{status} {res.get('code')}")
    check("it is back in the students' browse list", listed())
    status, res = call("POST", f"/admin/shops/{lid}/reinstate", admin, {})
    check("reinstating it again: 409 NOT_SUSPENDED", (status, res.get("code")) == (409, "NOT_SUSPENDED"),
          f"{status} {res.get('code')}")
    check("exactly one SHOP_REINSTATED audit row", h.audit_rows("SHOP_REINSTATED", lid, since) == 1,
          h.audit_rows("SHOP_REINSTATED", lid, since))
    call("POST", f"/admin/shops/{lid}/suspend", admin, {"reason": "E2E check finished; left suspended"})


def config_save(admin) -> None:
    print("3. Save a configuration value")
    college = h.college_id()
    status, cfg = call("GET", "/admin/college/config", admin)
    old = cfg["config"]["feeIncrementMinor"]
    new = old + 100 if old + 100 <= 10000 else old - 100
    since = h.db_now()
    try:
        status, res = call("PATCH", "/admin/college/config", admin, {"feeIncrementMinor": new})
        check("PATCH /admin/college/config {feeIncrementMinor} -> 200, changed = ['feeIncrementMinor']",
              status == 200 and res.get("changed") == ["feeIncrementMinor"], f"{status} {res.get('code')} {res.get('changed')}")
        check("the row in college_config has the new value",
              h.psql(f"SELECT fee_increment_minor FROM college_config WHERE college_id={h.q(college)}") == str(new))
        status, again = call("GET", "/admin/college/config", admin)
        check("GET returns it", again.get("config", {}).get("feeIncrementMinor") == new)
        detail = h.psql("SELECT detail::text FROM audit_log WHERE action='COLLEGE_CONFIG_CHANGED' "
                        f"AND created_at >= {h.q(since)} ORDER BY created_at DESC LIMIT 1")
        check("the audit row holds before and after", f'"feeIncrementMinor": {old}' in detail
              and f'"feeIncrementMinor": {new}' in detail, detail)
    finally:
        call("PATCH", "/admin/college/config", admin, {"feeIncrementMinor": old})
        check("(restore) the value is back",
              h.psql(f"SELECT fee_increment_minor FROM college_config WHERE college_id={h.q(college)}") == str(old))


def reorder_points(admin) -> None:
    print("4. Reorder the delivery points")
    student = h.login(h.RACERS[0])
    status, before = call("GET", "/admin/delivery-points", admin)
    original = [p["id"] for p in before["points"]]
    active = {p["id"] for p in before["points"] if p["isActive"]}
    if not check("there are at least two points to reorder", len(original) >= 2, len(original)):
        return
    flipped = list(reversed(original))
    since = h.db_now()
    try:
        status, res = call("PUT", "/admin/delivery-points/order", admin, {"pointIds": flipped})
        got = [p["id"] for p in res.get("points", [])]
        check("PUT /admin/delivery-points/order -> 200, in the order given", status == 200 and got == flipped,
              f"{status} {res.get('code')}")
        check("sortOrder is 1..n in that order", [p["sortOrder"] for p in res.get("points", [])] == list(range(1, len(flipped) + 1)),
              [p.get("sortOrder") for p in res.get("points", [])])
        status, picker = call("GET", "/browse/delivery-points", student)
        check("the students' picker follows the new order (active points only)",
              [p["id"] for p in picker.get("points", [])] == [i for i in flipped if i in active],
              [p["name"] for p in picker.get("points", [])])
        check("one DELIVERY_POINTS_REORDERED audit row",
              int(h.psql("SELECT count(*) FROM audit_log WHERE action='DELIVERY_POINTS_REORDERED' "
                         f"AND created_at >= {h.q(since)}")) == 1)
        status, res = call("PUT", "/admin/delivery-points/order", admin, {"pointIds": flipped[:-1]})
        check("a list missing a point is refused: 400 REORDER_MISMATCH", (status, res.get("code")) == (400, "REORDER_MISMATCH"),
              f"{status} {res.get('code')}")
        status, res = call("PUT", "/admin/delivery-points/order", h.login("admin@rit.edu.in"), {"pointIds": flipped})
        check("another college's admin cannot reorder them", status in (400, 403, 404), f"{status} {res.get('code')}")
    finally:
        call("PUT", "/admin/delivery-points/order", admin, {"pointIds": original})
        status, after = call("GET", "/admin/delivery-points", admin)
        check("(restore) the original order is back", [p["id"] for p in after.get("points", [])] == original)


def resolve_escalation(admin) -> None:
    print("5. Resolve a real escalation")
    student, rider = h.RACERS[2], h.RACERS[3]
    total = h.quote_total(student)
    cap = int(h.psql(f"SELECT max_otp_attempts FROM college_config WHERE college_id={h.q(h.college_id())}"))
    h.free_riders([rider])
    with h.Riders([rider]):
        fx = h.drive_to_picked_up(student, rider, "CASH", total)
        wrong = "000000" if fx["code"] != "000000" else "111111"
        for _ in range(cap):
            h.make_room(rider, "handover", 1)
            h.http("POST", f"/rider/tasks/{fx['task_id']}/handover", h.login(rider), {"code": wrong}, who=rider, route="handover")
    task, order = fx["task_id"], fx["order_id"]
    check(f"a delivery is escalated for real ({cap} wrong codes)",
          h.psql(f"SELECT status FROM task WHERE id={h.q(task)}") == "ESCALATED")
    mine = next((i for i in h.escalations(admin) if i.get("taskId") == task), None)
    check("it is in GET /admin/escalations, resolvable either way",
          bool(mine) and set(mine.get("canResolveAs", [])) == {"DELIVERED", "NOT_DELIVERED"}, mine and mine.get("canResolveAs"))
    status, res = call("POST", f"/admin/escalations/{task}/resolve", admin, {"outcome": "DELIVERED", "note": "short"})
    check("a note under ten characters is refused: 400", status == 400, f"{status} {res.get('code')}")
    listener = h.Socket(h.login(student)).connect()
    since = h.db_now()
    note = "E2E check: both parties confirm the food was handed over."
    status, res = call("POST", f"/admin/escalations/{task}/resolve", admin, {"outcome": "DELIVERED", "note": note})
    fee = int(h.psql(f"SELECT fee_minor FROM task WHERE id={h.q(task)}"))
    check("POST /admin/escalations/:taskId/resolve DELIVERED -> 200, COMPLETED, rider fee reported",
          status == 200 and res.get("status") == "COMPLETED" and res.get("riderFeeMinor") == fee,
          f"{status} {res.get('code')} {res.get('status')} {res.get('riderFeeMinor')}")
    check("task and order are COMPLETED",
          (h.psql(f"SELECT status FROM task WHERE id={h.q(task)}"), h.psql(f'SELECT status FROM "order" WHERE id={h.q(order)}'))
          == ("COMPLETED", "COMPLETED"))
    check("the rider was paid exactly once", h.rows(f"task_id={h.q(task)} AND type='DELIVERY_FEE_EARNED'") == 1)
    check("one TASK_RESOLVED audit row, by this admin, with the note",
          h.psql("SELECT actor_id || '|' || (detail::text LIKE '%' || " + h.q(note[:30]) + " || '%') FROM audit_log "
                 f"WHERE action='TASK_RESOLVED' AND target_id={h.q(task)} AND created_at >= {h.q(since)}")
          == f"{h.user_id(ADMIN)}|true")
    told = listener.wait_for(lambda: any(isinstance(p, dict) and p.get("taskId") == task and p.get("resolvedBy") == "ADMIN"
                                         for p in listener.named("task:status")), 5.0)
    check("the requester's socket is told an administrator resolved it", told, listener.named("task:status")[-2:])
    listener.close()
    check("it has left the escalations list", not any(i.get("taskId") == task for i in h.escalations(admin)))
    status, one = call("GET", f"/admin/escalations/{task}", admin)
    check("read back by id: COMPLETED, nothing left to choose, the note recorded",
          status == 200 and one.get("status") == "COMPLETED" and one.get("canResolveAs") == []
          and one.get("resolutionNote") == note, {k: one.get(k) for k in ("status", "canResolveAs", "resolutionNote")})
    status, res = call("POST", f"/admin/escalations/{task}/resolve", admin, {"outcome": "NOT_DELIVERED", "note": note})
    check("resolving it again: 409 ALREADY_RESOLVED", (status, res.get("code")) == (409, "ALREADY_RESOLVED"),
          f"{status} {res.get('code')}")
    check("...and nothing moved", h.rows(f"task_id={h.q(task)} AND type='DELIVERY_FEE_EARNED'") == 1
          and h.psql(f"SELECT status FROM task WHERE id={h.q(task)}") == "COMPLETED")


def run() -> int:
    admin = h.login(ADMIN)
    student_suspension(admin)
    shop_suspension(admin)
    config_save(admin)
    reorder_points(admin)
    resolve_escalation(admin)
    return c.finish(50, "each of the administrator's actions does what its button says, against the real API, "
                        "and everything it changed was put back.")


h.main(run)
