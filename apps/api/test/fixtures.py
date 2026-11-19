#!/usr/bin/env python3
"""
Create everything the harnesses and the two walks need that `pnpm db:seed`
does not.

The seed makes the college, its shops, and five accounts (super admin, college
admin, vivek, srichandana, fresher). The harnesses and walks also need:

  racer1..5@anurag.edu.in   verified students who can ride (ids rider-race-1..5)
  victim@anurag.edu.in      a verified student who is SUSPENDED
  dropme@anurag.edu.in      a verified student for the suspension check to suspend and reinstate
  cafe@example.com          the owner of the seeded Campus Corner Cafe
  admin@rit.edu.in          the administrator of a second college (cross-tenant checks)
  srichandana@              rider terms accepted, so the Earn screen opens on work mode
  Campus Corner Cafe        open all day (the seed's 08:00-21:00 would fail every night run)

Idempotent: run it as often as you like. Every statement is an upsert or a
"do it only if it is not already so", and it ends by checking, through the
API, that each account can actually do what the tests will ask of it.

Through the real HTTP API wherever a route exists:
  - rider terms            POST /verification/rider-terms/accept   (as each rider)
  - the suspension         POST /admin/verification/students/:id/suspend   (as the admin)
  - the cafe's hours       PUT  /shops/:listingId/catalog/hours            (as its owner)
By SQL where no route does the job:
  - the accounts themselves. Student sign-up exists, but it is three throttled
    calls per account (OTP request is 3 a minute per address) and ends at an
    UNVERIFIED student; verifying one needs an ID photo uploaded to object
    storage and an admin decision. Shop sign-up creates a *new* shop, and there
    is no route that attaches an owner to the seeded cafe. So: one INSERT per
    account, with the argon2 hash copied from a seeded user so the password is
    the same Hoppo@dev123, a VERIFIED student_profile, and a shop_staff row.
  - the second college and its config row (colleges are created by the seed).

    python3 -I apps/api/test/fixtures.py [API_BASE]

Exit 0 when everything is in place, 3 when something could not be created or
does not work (an environment block, in run-all.sh's terms).
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

COLLEGE = "00000000-0000-4000-8000-000000000001"
SECOND_COLLEGE = "00000000-0000-4000-8000-000000000002"
CAFE_SHOP = "shop-campus-corner-cafe"
ADMIN = "admin@anurag.edu.in"
SECOND_ADMIN = "admin@rit.edu.in"
VICTIM = "victim@anurag.edu.in"
WALK_RIDER = "srichandana@anurag.edu.in"
DONOR = "vivek@anurag.edu.in"          # whose password hash is copied

done = []


def say(what: str, how: str) -> None:
    done.append((what, how))
    print(f"  {how:<8} {what}")


def need(condition: bool, message: str) -> None:
    if not condition:
        raise h.Blocked(message)


def upsert_user(uid: str, email: str, mobile: str, name: str, role: str, college: str, pw_hash: str) -> None:
    """One account, keyed by email. Never touches status: suspension is the API's job."""
    existed = h.psql(f'SELECT id FROM "user" WHERE email={h.q(email)}')
    h.psql(f"""INSERT INTO "user" (id, college_id, role, status, name, mobile, email, password_hash,
                                   mobile_verified_at, email_verified_at, created_at, updated_at)
               VALUES ({h.q(uid)}, {h.q(college)}, '{role}', 'ACTIVE', {h.q(name)}, {h.q(mobile)}, {h.q(email)},
                       {h.q(pw_hash)}, now(), now(), now(), now())
               ON CONFLICT (email) DO UPDATE
               SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
                   college_id = EXCLUDED.college_id, failed_login_count = 0, locked_until = NULL,
                   updated_at = now()""")
    say(f"account {email} ({role})", "exists" if existed else "created")


def verified_profile(email: str, roll: str, admin_id: str) -> None:
    uid = h.user_id(email)
    h.psql(f"""INSERT INTO student_profile (user_id, roll_number, department, year_of_study,
                   verification_status, verified_at, verified_by_user_id, created_at, updated_at)
               VALUES ({h.q(uid)}, {h.q(roll)}, 'CSE', 3, 'VERIFIED', now(), {h.q(admin_id)}, now(), now())
               ON CONFLICT (user_id) DO UPDATE
               SET verification_status = 'VERIFIED',
                   verified_at = COALESCE(student_profile.verified_at, now()),
                   verified_by_user_id = COALESCE(student_profile.verified_by_user_id, {h.q(admin_id)}),
                   updated_at = now()""")


def accept_rider_terms(email: str) -> None:
    token = h.login(email)
    status, body = h.http("GET", "/rider/status", token)
    need(status == 200, f"{email}: GET /rider/status -> {status} {body.get('code')}")
    can = body.get("canEnable", {})
    if can.get("termsAccepted") and can.get("termsVersionCurrent"):
        say(f"rider terms for {email}", "exists")
    else:
        status, accepted = h.http("POST", "/verification/rider-terms/accept", token, {})
        need(status in (200, 201), f"{email}: accepting the rider terms -> {status} {accepted.get('code')}")
        say(f"rider terms for {email} (version {accepted.get('version')}, via the API)", "created")
        status, body = h.http("GET", "/rider/status", token)
        can = body.get("canEnable", {})
    need(all(can.get(k) for k in ("verified", "termsAccepted", "termsVersionCurrent", "notBarred")),
         f"{email} still cannot go online: {can}")


def run() -> int:
    print(f"Fixtures for {h.BASE}")
    need(h.psql(f"SELECT count(*) FROM college WHERE id={h.q(COLLEGE)}") == "1",
         "the seeded college is missing: run `pnpm db:seed` first")
    pw_hash = h.psql(f'SELECT password_hash FROM "user" WHERE email={h.q(DONOR)}')
    need(pw_hash.startswith("$argon2"), f"cannot copy a password hash from {DONOR}: run `pnpm db:seed` first")
    admin_id = h.user_id(ADMIN)

    # ---- accounts (SQL: see the docstring for why) -----------------------
    for i, email in enumerate(h.RACERS, start=1):
        upsert_user(f"rider-race-{i}", email, f"+91900000010{i}", f"Racer {i}", "STUDENT", COLLEGE, pw_hash)
        verified_profile(email, f"26EGRACE0{i}", admin_id)
    # The account e2e-shop-approval.py suspends (and reinstates) to watch its socket drop.
    upsert_user("dropme-student", "dropme@anurag.edu.in", "+919000000111", "Drop Me", "STUDENT", COLLEGE, pw_hash)
    verified_profile("dropme@anurag.edu.in", "26EGDROP01", admin_id)
    upsert_user("victim-student", VICTIM, "+919000000110", "Victim Student", "STUDENT", COLLEGE, pw_hash)
    verified_profile(VICTIM, "26EGVICT01", admin_id)

    upsert_user("cafe-owner", h.SHOP_OWNER, "+919000000120", "Cafe Owner", "SHOP_OWNER", COLLEGE, pw_hash)
    need(h.psql(f"SELECT count(*) FROM shop WHERE id={h.q(CAFE_SHOP)}") == "1",
         f"the seeded shop {CAFE_SHOP} is missing")
    linked = h.psql(f"SELECT count(*) FROM shop_staff WHERE shop_id={h.q(CAFE_SHOP)} "
                    f"AND user_id={h.q(h.user_id(h.SHOP_OWNER))}") == "1"
    h.psql(f"""INSERT INTO shop_staff (shop_id, user_id, is_owner, created_at)
               VALUES ({h.q(CAFE_SHOP)}, {h.q(h.user_id(h.SHOP_OWNER))}, true, now())
               ON CONFLICT (shop_id, user_id) DO UPDATE SET is_owner = true""")
    say(f"{h.SHOP_OWNER} owns {CAFE_SHOP}", "exists" if linked else "created")

    # ---- a second college, for the cross-tenant checks --------------------
    had_college = h.psql(f"SELECT count(*) FROM college WHERE id={h.q(SECOND_COLLEGE)}") == "1"
    h.psql(f"""INSERT INTO college (id, name, short_name, address, city, state, latitude, longitude,
                                    email_domain, status, created_at, updated_at)
               VALUES ({h.q(SECOND_COLLEGE)}, 'Riverside Institute of Technology', 'RIT', 'Riverside Road',
                       'Hyderabad', 'Telangana', 17.4400, 78.3500, 'rit.edu.in', 'ACTIVE', now(), now())
               ON CONFLICT (id) DO NOTHING""")
    h.psql(f"""INSERT INTO college_config (college_id, updated_at) VALUES ({h.q(SECOND_COLLEGE)}, now())
               ON CONFLICT (college_id) DO NOTHING""")
    say("second college (Riverside Institute of Technology) with its config", "exists" if had_college else "created")
    upsert_user("rit-admin", SECOND_ADMIN, "+919000000130", "RIT Admin", "ADMIN", SECOND_COLLEGE, pw_hash)

    # ---- the rest through the API -----------------------------------------
    for email in h.RACERS + [WALK_RIDER]:
        accept_rider_terms(email)

    victim_id = h.user_id(VICTIM)
    if h.psql(f'SELECT status FROM "user" WHERE id={h.q(victim_id)}') == "SUSPENDED":
        say(f"{VICTIM} is suspended", "exists")
    else:
        status, body = h.http("POST", f"/admin/verification/students/{victim_id}/suspend", h.login(ADMIN),
                              {"reason": "Fixture: the suspended account the walks sign in as"})
        need(status in (200, 201), f"suspending {VICTIM} through the admin API -> {status} {body.get('code')} "
                                   f"{body.get('message')}")
        say(f"{VICTIM} is suspended (via the admin API)", "created")
    need(h.psql(f'SELECT status FROM "user" WHERE id={h.q(victim_id)}') == "SUSPENDED",
         f"{VICTIM} is not SUSPENDED after the admin API said it was")

    # ---- the cafe must be open whenever the tests run ----------------------
    # The seed opens it 08:00-21:00 college time, and these checks get run at
    # all hours. Opening hours are the owner's to set, and there is a route.
    cafe = h.psql(f"SELECT id FROM shop_listing WHERE shop_id={h.q(CAFE_SHOP)} AND college_id={h.q(COLLEGE)}")
    status, detail = h.http("GET", f"/browse/shops/{cafe}", h.login(h.RACERS[0]))
    need(status == 200, f"GET /browse/shops/{cafe} -> {status} {detail.get('code')}")
    if detail.get("isOpen"):
        say("Campus Corner Cafe is open", "exists")
    else:
        need(detail.get("closedReason") == "OUTSIDE_HOURS",
             f"the cafe is closed for a reason opening hours cannot fix: {detail.get('closedReason')}")
        hours = [{"dayOfWeek": d, "openMinute": 0, "closeMinute": 1440} for d in range(7)]
        status, body = h.http("PUT", f"/shops/{cafe}/catalog/hours", h.login(h.SHOP_OWNER), {"hours": hours})
        need(status == 200, f"setting the cafe's opening hours -> {status} {body.get('code')} {body.get('message')}")
        say("Campus Corner Cafe opening hours set to all day, every day (via the API, as its owner)", "created")

    # ---- and now prove each one works, through the API ---------------------
    cat = h.catalog()      # raises Blocked if no shop is open or it has nothing to sell
    need(cat["listing_id"] == cafe, "the nearest open shop is not the seeded Campus Corner Cafe "
                                    "(is it outside its opening hours?)")
    status, body = h.http("GET", f"/shops/{cafe}/orders", h.login(h.SHOP_OWNER))
    need(status == 200, f"{h.SHOP_OWNER} cannot read the cafe's order queue: {status} {body.get('code')}")
    say(f"{h.SHOP_OWNER} can read the cafe's order queue", "checked")
    status, body = h.http("POST", "/auth/login", None, {"identifier": VICTIM, "password": h.PASSWORD},
                          who="ip", route="login")
    need(status in (401, 403), f"{VICTIM} can still sign in ({status}); the suspension is not enforced")
    say(f"{VICTIM} is refused at sign-in ({status} {body.get('code')})", "checked")
    status, body = h.http("GET", "/auth/me", h.login(SECOND_ADMIN))
    need(status == 200 and body.get("user", {}).get("college", {}).get("id", SECOND_COLLEGE) == SECOND_COLLEGE,
         f"{SECOND_ADMIN} cannot sign in to the second college: {status}")
    say(f"{SECOND_ADMIN} signs in to the second college", "checked")

    made = sum(1 for _, how in done if how == "created")
    print(f"RESULT: PASS - fixtures in place ({made} created this run, "
          f"{sum(1 for _, how in done if how == 'exists')} already there, "
          f"{sum(1 for _, how in done if how == 'checked')} checked through the API).")
    return 0


h.main(run)
