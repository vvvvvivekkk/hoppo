#!/usr/bin/env python3
"""
End-to-end checks of the administrator's side: the order report, college
configuration, delivery points, the audit log and the platform routes.

The SRS's own acceptance test (section 12.3) ends "...and the order appears in
the administrator's report". This script delivers an order through the real
flow and then looks for it there:

  1. The report. The delivered order is found by its reference in
     GET /admin/orders; its detail carries a complete timeline in time order;
     its money is integer paise that add up (items + delivery + platform =
     total); and today's summary counts it - every figure in the summary is
     compared with the same figure computed from the database. Another
     college's administrator finds nothing and is refused the detail. Nowhere
     in any of these responses is there a mobile number or an email address.
  2. Configuration. Changing the fee bands is audited with the values before
     and after, and the very next quote charges the new fee. Restored in a
     `finally`.
  3. Delivery points. A deactivated point leaves the student's picker and
     cannot be ordered to; reactivating puts it back.
  4. The audit log shows an administrator their own college's rows only.
  5. Platform. A super administrator creates a college and its administrator;
     that administrator signs in and sees an empty college; deactivating the
     college locks them out with COLLEGE_INACTIVE.

Not a race: one request at a time, each with a stated expectation. Each run
leaves one completed order, one inactive delivery point (reused by the next
run) and one deactivated "E2E College".

    python3 apps/api/test/e2e-admin.py [BASE]
"""
import json
import os
import re
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

ADMIN = "admin@anurag.edu.in"
OTHER_ADMIN = "admin@rit.edu.in"
SUPER = "super@hoppo.app"
STUDENT, RIDER = h.RACERS[1], h.RACERS[0]
POINT_NAME = "E2E Test Point"

checks = 0
failures = []
five_xx = 0


def check(what: str, ok: bool, got="") -> bool:
    global checks
    checks += 1
    print(f"  {'ok  ' if ok else 'FAIL'} {what}" + (f"   [{str(got)[:300]}]" if got != "" and not ok else ""))
    if not ok:
        failures.append(f"{what} - got {str(got)[:300]}")
    return bool(ok)


def call(method, path, token, body=None):
    global five_xx
    status, res = h.http(method, path, token, body)
    if status == 0:
        raise h.Blocked(f"api: lost the API during {method} {path}: {res.get('message')}")
    if status >= 500:
        five_xx += 1
        failures.append(f"{method} {path} answered {status} {res.get('code')}")
    return status, res


def no_contact_details(label: str, payload, people: list) -> None:
    """FR-PRIV-03: names and ids only. Checked against the real numbers and addresses."""
    raw = json.dumps(payload)
    digits = re.sub(r"[\s\-().]", "", raw)
    leaked = [p for p in people if p and (p in raw or (p.startswith("+") and p[-10:] in digits))]
    check(f"{label}: none of the student's or rider's own mobile numbers or emails", not leaked, leaked)
    check(f"{label}: no email address of any kind", not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", raw),
          re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", raw)[:3])
    check(f"{label}: no field named mobile, phone or email",
          not re.search(r'"[^"]*(mobile|phone|email)[^"]*"\s*:', raw, re.I),
          re.findall(r'"[^"]*(?:mobile|phone|email)[^"]*"\s*:', raw, re.I)[:3])


def db_summary(college: str) -> dict:
    """Today's figures (college timezone, by placed_at) straight from the tables."""
    tz = h.psql(f"SELECT timezone FROM college WHERE id={h.q(college)}")
    today = (f"(o.placed_at AT TIME ZONE 'UTC' AT TIME ZONE {h.q(tz)})::date = "
             f"(now() AT TIME ZONE {h.q(tz)})::date AND o.college_id={h.q(college)}")
    row = h.psql(f"""SELECT count(*),
        count(*) FILTER (WHERE status='COMPLETED'), count(*) FILTER (WHERE status='CANCELLED'),
        COALESCE(sum(items_subtotal_minor) FILTER (WHERE status='COMPLETED'),0),
        COALESCE(sum(delivery_fee_minor) FILTER (WHERE status='COMPLETED'),0),
        COALESCE(sum(platform_fee_minor) FILTER (WHERE status='COMPLETED'),0),
        COALESCE(sum(total_minor) FILTER (WHERE status='COMPLETED'),0),
        COALESCE(sum(commission_minor) FILTER (WHERE status='COMPLETED'),0)
        FROM "order" o WHERE {today}""").split("|")
    keys = ["placed", "completed", "cancelled", "items", "delivery", "platform", "total", "commission"]
    return dict(zip(keys, map(int, row)))


def api_summary(body: dict) -> dict:
    m = body["money"]
    return {"placed": body["ordersPlaced"], "completed": body["byStatus"]["COMPLETED"],
            "cancelled": body["byStatus"]["CANCELLED"], "items": m["grossItemsMinor"],
            "delivery": m["deliveryFeesMinor"], "platform": m["platformFeesMinor"],
            "total": m["totalMinor"], "commission": m["commissionMinor"]}


def report(admin, other_admin, college) -> None:
    print("1. The delivered order in the administrator's report (SRS 12.3)")
    total = h.quote_total(STUDENT)
    status, before = call("GET", "/admin/orders/summary", admin)
    h.free_riders([RIDER])
    with h.Riders([RIDER]):
        fx = h.drive_to_picked_up(STUDENT, RIDER, "CASH", total)
        status, res = call("POST", f"/rider/tasks/{fx['task_id']}/handover", h.login(RIDER), {"code": fx["code"]})
    if not check("an order is delivered through the real flow (place, accept, ready, offer, pickup, code)",
                 status == 200, f"{status} {res.get('code')}"):
        return
    order_id = fx["order_id"]
    ref, d_items, d_delivery, d_platform, d_total = h.psql(
        "SELECT reference || '|' || items_subtotal_minor || '|' || delivery_fee_minor || '|' || "
        f'platform_fee_minor || \'|\' || total_minor FROM "order" WHERE id={h.q(order_id)}').split("|")
    people = h.psql(f"SELECT mobile || '|' || email FROM \"user\" WHERE id IN "
                    f"({h.q(h.user_id(STUDENT))},{h.q(h.user_id(RIDER))})").replace("\n", "|").split("|")

    status, found = call("GET", f"/admin/orders?q={ref}", admin)
    rows = [o for o in found.get("items", []) if o.get("reference") == ref]
    if not check(f"GET /admin/orders?q={ref} finds exactly that order", status == 200 and len(rows) == 1,
                 f"{status}, {len(rows)} match(es)"):
        return
    row = rows[0]
    check("the row says COMPLETED, task COMPLETED", (row["status"], row.get("taskStatus")) == ("COMPLETED", "COMPLETED"),
          (row["status"], row.get("taskStatus")))
    money = [row.get(k) for k in ("itemsSubtotalMinor", "deliveryFeeMinor", "platformFeeMinor", "totalMinor")]
    check("its money is integer paise", all(isinstance(v, int) and not isinstance(v, bool) for v in money), money)
    check("items + delivery fee + platform fee = total", all(isinstance(v, int) for v in money)
          and money[0] + money[1] + money[2] == money[3], money)
    check("...and they are the figures in the order row", money == [int(d_items), int(d_delivery), int(d_platform), int(d_total)],
          (money, d_items, d_delivery, d_platform, d_total))
    check("student and rider are named, by id", row.get("student", {}).get("id") == h.user_id(STUDENT)
          and (row.get("rider") or {}).get("id") == h.user_id(RIDER), (row.get("student"), row.get("rider")))
    no_contact_details("order list", found, people)

    status, detail = call("GET", f"/admin/orders/{order_id}", admin)
    check("GET /admin/orders/:orderId -> 200", status == 200, status)
    events = [e.get("event") for e in detail.get("timeline", [])]
    check("the timeline is complete: PLACED, SHOP_ACCEPTED, READY, PICKED_UP, DELIVERED, COMPLETED",
          events == ["PLACED", "SHOP_ACCEPTED", "READY", "PICKED_UP", "DELIVERED", "COMPLETED"], events)
    times = [e.get("at") for e in detail.get("timeline", [])]
    check("...every step has a time, and they are in order", all(times) and times == sorted(times), times)
    lines = detail.get("items", [])
    check("the item lines add up to the items subtotal",
          bool(lines) and all(l["unitPriceMinor"] * l["quantity"] == l["lineTotalMinor"] for l in lines)
          and sum(l["lineTotalMinor"] for l in lines) == detail.get("itemsSubtotalMinor"), lines)
    fees = [w for w in detail.get("walletEntries", []) if w.get("type") == "DELIVERY_FEE_EARNED"]
    check("exactly one delivery-fee entry, for the rider, of the task's fee",
          len(fees) == 1 and fees[0].get("party") == "RIDER"
          and fees[0].get("amountMinor") == (detail.get("task") or {}).get("feeMinor"), fees)
    rounds = (detail.get("broadcast") or {}).get("rounds", [])
    check("the broadcast history ends in ACCEPTED", bool(rounds) and rounds[-1].get("outcome") == "ACCEPTED", rounds)
    no_contact_details("order detail", detail, people)

    # The summary against the database. Other things may place orders between
    # the two reads; if they disagree, read both once more before believing it.
    for attempt in range(3):
        status, summary = call("GET", "/admin/orders/summary", admin)
        truth = db_summary(college)
        if status != 200 or api_summary(summary) == truth:
            break
        time.sleep(1.0)
    check("GET /admin/orders/summary -> 200 (today, college timezone)", status == 200, status)
    got = api_summary(summary)
    check("every summary figure equals the same figure computed from the database", got == truth,
          {k: (got[k], truth[k]) for k in got if got[k] != truth[k]})
    m = summary["money"]
    check("summary money is integer paise and adds up (items + delivery + platform = total)",
          all(isinstance(m[k], int) for k in ("grossItemsMinor", "deliveryFeesMinor", "platformFeesMinor", "totalMinor"))
          and m["grossItemsMinor"] + m["deliveryFeesMinor"] + m["platformFeesMinor"] == m["totalMinor"], m)
    check("the status buckets add up to the orders placed", sum(summary["byStatus"].values()) == summary["ordersPlaced"],
          summary["byStatus"])
    check("cancellations: total = CANCELLED bucket = sum by who",
          summary["cancellations"]["total"] == summary["byStatus"]["CANCELLED"]
          == sum(summary["cancellations"]["byWho"].values()), summary["cancellations"])
    b = api_summary(before)
    check("the delivered order moved the summary: one more placed, one more completed, its paise in the totals",
          got["placed"] - b["placed"] >= 1 and got["completed"] - b["completed"] >= 1
          and got["total"] - b["total"] >= int(d_total) and got["items"] - b["items"] >= int(d_items),
          {k: got[k] - b[k] for k in got})
    shops = {s["listingId"]: s for s in summary.get("revenueByShop", [])}
    cafe = shops.get(h.catalog()["listing_id"])
    check("the shop's revenue line includes it", bool(cafe) and cafe["completedOrders"] >= 1
          and cafe["grossItemsMinor"] >= int(d_items), cafe)
    no_contact_details("summary", summary, people)

    status, theirs = call("GET", f"/admin/orders?q={ref}", other_admin)
    check("another college's admin searching for the reference finds nothing",
          status == 200 and theirs.get("items") == [], f"{status} {len(theirs.get('items', []))} item(s)")
    status, res = call("GET", f"/admin/orders/{order_id}", other_admin)
    check("...and is refused its detail: 403 CROSS_TENANT_ACCESS", (status, res.get("code")) == (403, "CROSS_TENANT_ACCESS"),
          f"{status} {res.get('code')}")
    status, theirs = call("GET", "/admin/orders/summary", other_admin)
    check("...and their own summary has none of this college's orders", status == 200 and theirs.get("ordersPlaced") == 0,
          f"{status} ordersPlaced={theirs.get('ordersPlaced')}")
    status, res = call("GET", "/admin/orders", h.login(STUDENT))
    check("a student is refused the report: 403", status == 403, status)


def configuration(admin) -> None:
    print("2. College configuration: audited, and in force on the next quote")
    c = h.catalog()
    body = {"listingId": c["listing_id"], "deliveryPointId": c["point_id"],
            "lines": [{"catalogItemId": c["item_id"], "quantity": 1}]}
    status, cfg = call("GET", "/admin/college/config", admin)
    if not check("GET /admin/college/config -> 200 with fee bands", status == 200 and cfg.get("feeBands"), status):
        return
    old = cfg["feeBands"]
    new = [dict(b, feeMinor=b["feeMinor"] + 100) for b in old]
    status, q0 = call("POST", "/orders/quote", h.login(STUDENT), body)
    fee0 = q0["totals"]["deliveryFeeMinor"]
    try:
        status, res = call("PATCH", "/admin/college/config", admin, {"feeBands": new})
        check("PATCH /admin/college/config {feeBands} -> 200, changed = ['feeBands']",
              status == 200 and res.get("changed") == ["feeBands"], f"{status} {res.get('code')} {res.get('changed')}")
        status, q1 = call("POST", "/orders/quote", h.login(STUDENT), body)
        check("the next quote charges the new delivery fee (old + 100 paise)",
              status == 200 and q1["totals"]["deliveryFeeMinor"] == fee0 + 100,
              (fee0, q1.get("totals", {}).get("deliveryFeeMinor")))
        check("...and its total moved by exactly that", q1["totals"]["totalMinor"] == q0["totals"]["totalMinor"] + 100,
              (q0["totals"]["totalMinor"], q1["totals"]["totalMinor"]))
        status, log = call("GET", "/admin/audit-log?action=COLLEGE_CONFIG_CHANGED&limit=1", admin)
        entry = (log.get("items") or [{}])[0]
        detail = entry.get("detail") or {}
        check("one COLLEGE_CONFIG_CHANGED audit row, by this admin",
              status == 200 and entry.get("action") == "COLLEGE_CONFIG_CHANGED"
              and (entry.get("actor") or {}).get("id") == h.user_id(ADMIN), entry)
        strip = lambda bands: [(b["minDistanceM"], b["maxDistanceM"], b["feeMinor"]) for b in bands or []]
        check("...holding the fee bands before and after",
              strip((detail.get("before") or {}).get("feeBands")) == strip(old)
              and strip((detail.get("after") or {}).get("feeBands")) == strip(new), detail)
        status, res = call("PATCH", "/admin/college/config", admin, {"feeBands": new})
        check("sending the same values again changes nothing: changed = []", status == 200 and res.get("changed") == [],
              f"{status} {res.get('changed')}")
        status, res = call("PATCH", "/admin/college/config", admin, {"maxOtpAttempts": 0})
        check("an out-of-bounds value is refused: 400", status == 400, f"{status} {res.get('code')}")
        status, res = call("PATCH", "/admin/college/config", h.login(SUPER), {"maxOtpAttempts": 5})
        check("a super admin (no college of their own) is refused: 403", status == 403, f"{status} {res.get('code')}")
    finally:
        status, res = call("PATCH", "/admin/college/config", admin, {"feeBands": old})
        status, q2 = call("POST", "/orders/quote", h.login(STUDENT), body)
        check("(restore) the fee bands are back and the quote with them",
              q2.get("totals", {}).get("deliveryFeeMinor") == fee0, (fee0, q2.get("totals", {}).get("deliveryFeeMinor")))


def delivery_points(admin, other_admin) -> None:
    print("3. Delivery points: deactivating one removes it from the student's picker")
    c = h.catalog()
    student = h.login(STUDENT)
    picker = lambda: [p["id"] for p in call("GET", "/browse/delivery-points", student)[1].get("points", [])]
    status, mine = call("GET", "/admin/delivery-points", admin)
    point = next((p for p in mine.get("points", []) if p["name"] == POINT_NAME), None)
    if point is None:
        status, point = call("POST", "/admin/delivery-points", admin,
                             {"name": POINT_NAME, "description": "Created by e2e-admin.py; normally inactive",
                              "latitude": c["shop_lat"] + 0.0005, "longitude": c["shop_lng"] + 0.0005})
        if not check("POST /admin/delivery-points -> 201", status == 201, f"{status} {point.get('code')}"):
            return
    elif not point["isActive"]:
        call("POST", f"/admin/delivery-points/{point['id']}/activate", admin, {})
    pid = point["id"]
    try:
        check("an active point is in the student's picker", pid in picker())
        body = {"listingId": c["listing_id"], "deliveryPointId": pid,
                "lines": [{"catalogItemId": c["item_id"], "quantity": 1}]}
        status, res = call("POST", "/orders/quote", student, body)
        check("...and can be quoted to", status == 200, f"{status} {res.get('code')}")
        status, res = call("POST", f"/admin/delivery-points/{pid}/deactivate", other_admin, {})
        check("another college's admin cannot deactivate it", status in (403, 404), f"{status} {res.get('code')}")
        status, res = call("POST", f"/admin/delivery-points/{pid}/deactivate", admin, {})
        check("POST .../deactivate -> 200, isActive false", status == 200 and res.get("isActive") is False,
              f"{status} {res.get('code')}")
        check("it is gone from the student's picker", pid not in picker())
        status, res = call("POST", "/orders/quote", student, body)
        check("...and an order to it is refused", status in (400, 404, 409), f"{status} {res.get('code')}")
        status, listed = call("GET", "/admin/delivery-points", admin)
        check("the admin still sees it, inactive", any(p["id"] == pid and not p["isActive"] for p in listed.get("points", [])))
        status, res = call("POST", f"/admin/delivery-points/{pid}/deactivate", admin, {})
        check("deactivating it twice: 409 ALREADY_INACTIVE", (status, res.get("code")) == (409, "ALREADY_INACTIVE"),
              f"{status} {res.get('code')}")
        status, res = call("POST", f"/admin/delivery-points/{pid}/activate", admin, {})
        check("POST .../activate -> 200", status == 200 and res.get("isActive") is True, f"{status} {res.get('code')}")
        check("it is back in the student's picker", pid in picker())
        status, log = call("GET", f"/admin/audit-log?targetId={pid}&limit=10", admin)
        actions = [i["action"] for i in log.get("items", [])]
        check("both changes are in the audit log", "DELIVERY_POINT_DEACTIVATED" in actions
              and "DELIVERY_POINT_ACTIVATED" in actions, actions)
    finally:
        # Left inactive, so the picker the walks and the students see is the seed's.
        call("POST", f"/admin/delivery-points/{pid}/deactivate", admin, {})
        check("(restore) the test point is inactive again", pid not in picker())


def audit_log(admin, other_admin, college) -> None:
    print("4. The audit log: own college only")
    other_college = h.psql(f'SELECT college_id FROM "user" WHERE email={h.q(OTHER_ADMIN)}')
    seen, cursor = [], None
    for _ in range(3):
        status, page = call("GET", "/admin/audit-log?limit=100" + (f"&cursor={cursor}" if cursor else ""), admin)
        seen += page.get("items", [])
        cursor = page.get("nextCursor")
        if not cursor:
            break
    check("the admin's log has rows, newest first", len(seen) > 0
          and [i["createdAt"] for i in seen] == sorted((i["createdAt"] for i in seen), reverse=True), len(seen))
    check(f"every one of {len(seen)} rows belongs to their college", all(i.get("collegeId") == college for i in seen),
          {i.get("collegeId") for i in seen})
    status, theirs = call("GET", "/admin/audit-log?limit=100", other_admin)
    check("another college's admin sees only their own college's rows",
          status == 200 and all(i.get("collegeId") == other_college for i in theirs.get("items", [])),
          {i.get("collegeId") for i in theirs.get("items", [])})
    status, sneaky = call("GET", f"/admin/audit-log?limit=100&collegeId={college}", other_admin)
    check("...even when they ask for this college by id",
          status in (200, 400, 403) and all(i.get("collegeId") == other_college for i in sneaky.get("items", [])),
          f"{status} {len(sneaky.get('items', []))} item(s)")
    if seen:
        status, by_target = call("GET", f"/admin/audit-log?targetId={seen[0]['targetId']}&limit=5", other_admin)
        check("...or for one of its rows by target id", by_target.get("items", []) == [], by_target.get("items"))
    status, res = call("GET", "/admin/audit-log", h.login(STUDENT))
    check("a student is refused the audit log: 403", status == 403, status)


def platform(admin) -> None:
    print("5. Platform: a new college, its administrator, and deactivation")
    boss = h.login(SUPER)
    status, res = call("GET", "/platform/colleges", admin)
    check("a college admin is refused the platform routes: 403", status == 403, status)
    number = "+9197" + str(int(h.RUN, 16) % 10 ** 8).zfill(8)
    email = f"e2e-admin-{h.RUN}@example.com"
    status, college = call("POST", "/platform/colleges", boss, {
        "name": f"E2E College {h.RUN}", "shortName": "E2E", "address": "1 Test Road", "city": "Hyderabad",
        "state": "Telangana", "latitude": 17.5, "longitude": 78.4})
    if not check("POST /platform/colleges -> 201, ACTIVE", status == 201 and college.get("status") == "ACTIVE",
                 f"{status} {college.get('code')} {college.get('message')}"):
        return
    cid = college["id"]
    status, made = call("POST", f"/platform/colleges/{cid}/admins", boss,
                        {"name": "E2E Admin", "mobile": number, "email": email, "password": h.PASSWORD})
    check("POST /platform/colleges/:id/admins -> 201", status == 201 and made.get("collegeId") == cid,
          f"{status} {made.get('code')} {made.get('message')}")
    h.make_room("ip", "login", 1)
    status, session = call("POST", "/auth/login", None, {"identifier": email, "password": h.PASSWORD})
    if status == 429:
        time.sleep(62)
        status, session = call("POST", "/auth/login", None, {"identifier": email, "password": h.PASSWORD})
    if not check("the new administrator signs in", status == 200 and "accessToken" in session, f"{status} {session.get('code')}"):
        return
    token = session["accessToken"]
    status, me = call("GET", "/auth/me", token)
    check("...and belongs to the new college", (me.get("user", {}).get("college") or {}).get("id") == cid,
          me.get("user", {}).get("college"))
    for path, key in (("/admin/orders", "items"), ("/admin/delivery-points", "points"), ("/admin/shops", "items"),
                      ("/admin/students", "items")):
        status, res = call("GET", path, token)
        check(f"their {path} is empty", status == 200 and res.get(key) == [], f"{status} {len(res.get(key) or [])} row(s)")
    status, res = call("GET", "/admin/orders/summary", token)
    check("their summary counts no orders", status == 200 and res.get("ordersPlaced") == 0, f"{status} {res.get('ordersPlaced')}")
    status, res = call("GET", "/admin/college/config", token)
    check("the college was created with a config and fee bands", status == 200 and len(res.get("feeBands", [])) >= 1, status)

    status, res = call("POST", f"/platform/colleges/{cid}/deactivate", boss, {"reason": "E2E check: deactivation locks the college out"})
    check("POST /platform/colleges/:id/deactivate -> 200, INACTIVE", status == 200 and res.get("status") == "INACTIVE",
          f"{status} {res.get('code')}")
    status, res = call("GET", "/admin/orders", token)
    check("the administrator's existing token now answers 403 COLLEGE_INACTIVE",
          (status, res.get("code")) == (403, "COLLEGE_INACTIVE"), f"{status} {res.get('code')}")
    h.make_room("ip", "login", 1)
    status, res = call("POST", "/auth/login", None, {"identifier": email, "password": h.PASSWORD})
    check("...and signing in again is refused with COLLEGE_INACTIVE", (status, res.get("code")) == (403, "COLLEGE_INACTIVE"),
          f"{status} {res.get('code')}")
    status, public = call("GET", "/auth/colleges", None)
    check("the college has left the public sign-up list", cid not in json.dumps(public), status)
    status, res = call("GET", "/admin/orders?limit=1", admin)
    check("other colleges are unaffected", status == 200, status)


def run() -> int:
    college = h.college_id()
    admin, other_admin = h.login(ADMIN), h.login(OTHER_ADMIN)
    report(admin, other_admin, college)
    configuration(admin)
    delivery_points(admin, other_admin)
    audit_log(admin, other_admin, college)
    platform(admin)

    print(f"\nchecks: {checks} | failed: {len(failures)} | 5xx: {five_xx}")
    for f in failures:
        print("  FAIL  " + f)
    if failures:
        print(f"RESULT: FAIL - {len(failures)} of {checks} administrator checks failed. e2e-admin")
        return 1
    if checks < 60:
        print("RESULT: FAIL - the script stopped early; too few checks ran to mean anything. e2e-admin")
        return 2
    print(f"RESULT: PASS - all {checks} administrator checks held: the delivered order is in the report with money "
          "that adds up, configuration changes are audited and take effect, and each college sees only itself.")
    return 0


h.main(run)
