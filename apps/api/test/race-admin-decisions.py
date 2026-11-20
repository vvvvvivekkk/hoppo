#!/usr/bin/env python3
"""
Race the two answers an administrator can give to a pending application.

A shop awaiting verification can be approved or rejected; so can a student's
identity submission. Two administrators working the same queue can give
different answers to the same row at the same moment. If each reads PENDING
and then writes, both succeed: the row ends as whichever wrote last, and the
audit log - which cannot be edited - records a decision that did not stand.

  Scenario 1  one pending shop, N requests at once from two administrators,
              half POST /admin/shops/:listingId/approve, half .../reject.
  Scenario 2  one pending verification submission, the same with
              POST /admin/verification/:id/approve and .../reject.

Every round must leave exactly one success, the rest 409; the row in the
state the winner chose (and, for a verification, the student's profile
agreeing with it); and exactly one approve-or-reject audit row for it. The
head start alternates so that each answer gets to win, and the split is
printed.

Shops are registered through POST /shops/register, which allows five a minute
per address - hence few shop rounds. Verification submissions are inserted by
SQL for a student made for the round (the submit route needs an uploaded ID
photo and allows three submissions a week); those students are removed again.

    python3 apps/api/test/race-admin-decisions.py [BASE]   (N=6 SHOP_ROUNDS=3 ROUNDS=12 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

N = h.env_int("N", 6)
SHOP_ROUNDS = h.env_int("SHOP_ROUNDS", 3)
ROUNDS = h.env_int("ROUNDS", 12)
HEAD_START_MS = h.env_int("HEAD_START_MS", 10)
ADMINS = ["admin@anurag.edu.in", "admin2@anurag.edu.in"]
REJECT = {"reason": "DOCUMENT_INCOMPLETE", "note": "race harness"}


def decisions(target_ids, since: str) -> int:
    ids = ",".join(h.q(t) for t in target_ids)
    return int(h.psql("SELECT count(*) FROM audit_log WHERE target_id IN (" + ids + ") "
                      "AND (action LIKE '%APPROV%' OR action LIKE '%REJECT%' OR action LIKE '%VERIFIED%') "
                      f"AND created_at >= {h.q(since)}"))


def burst(tally, where, base_path, first):
    calls = []
    for i in range(N):
        answer = "approve" if i % 2 == 0 else "reject"
        calls.append(h.Call(answer, "POST", f"{base_path}/{answer}", ADMINS[(i // 2) % 2],
                            REJECT if answer == "reject" else {}, route="decide",
                            delay_ms=0 if answer == first else HEAD_START_MS))
    return tally.fire(where, calls)


def run() -> int:
    tally = h.Tally("race-admin-decisions", N, SHOP_ROUNDS + ROUNDS)
    college = h.college_id()
    print(f"Admin-decision race: {N} approve/reject requests at once from two administrators; "
          f"{SHOP_ROUNDS} pending shops, then {ROUNDS} pending verification submissions.")
    won = {"shop approve": 0, "shop reject": 0, "verification approve": 0, "verification reject": 0}
    made_users = []

    for n in range(1, SHOP_ROUNDS + 1):
        shop = h.register_shop("decidable")
        lid = shop["listing_id"]
        first = "approve" if n % 2 else "reject"
        where = f"round {n} (shop, {first} with a {HEAD_START_MS} ms head start)"
        since = h.db_now()
        results = burst(tally, where, f"/admin/shops/{lid}", first)
        wins = [r for r in results if r.ok]
        status = h.psql(f"SELECT status FROM shop_listing WHERE id={h.q(lid)}")
        audits = decisions([lid], since)
        tally.note_rows("shop: decision audit rows", audits)
        problems = []
        if len(wins) != 1:
            problems.append(f"{len(wins)} decisions succeeded (must be exactly 1): {[r.call.label for r in wins]}")
        else:
            won[f"shop {wins[0].call.label}"] += 1
            expected = "ACTIVE" if wins[0].call.label == "approve" else "REJECTED"
            if status != expected:
                problems.append(f"{wins[0].call.label} got the success but the listing is {status}")
        if audits != 1:
            problems.append(f"{audits} approve/reject audit rows for one listing (must be exactly 1)")
        if any(r.status != 409 for r in results if not r.ok and r.status < 500):
            problems.append(f"losers were answered {sorted({r.key for r in results if not r.ok})} (expected 409)")
        for p in problems:
            tally.fail(f"{where} listing {lid}", p)
        tally.rounds_run += 1
        h.progress(not problems)
        if status == "ACTIVE":   # do not leave another shop in the students' list
            h.http("POST", f"/admin/shops/{lid}/suspend", h.login(ADMINS[0]), {"reason": f"race harness {h.RUN} finished"})

    pw_hash = h.psql("SELECT password_hash FROM \"user\" WHERE email='vivek@anurag.edu.in'")
    for n in range(1, ROUNDS + 1):
        uid = f"race-verif-{h.RUN}-{n}"
        sub = f"race-sub-{h.RUN}-{n}"
        made_users.append(uid)
        h.psql(f"""INSERT INTO "user" (id, college_id, role, status, name, mobile, email, password_hash, mobile_verified_at, created_at, updated_at)
                   VALUES ({h.q(uid)}, {h.q(college)}, 'STUDENT', 'ACTIVE', 'Race Verifiee {n}', {h.q('+9191' + h.RUN[:4].upper().translate(str.maketrans('ABCDEF', '123456')) + str(n).zfill(4))},
                           {h.q(uid + '@anurag.edu.in')}, {h.q(pw_hash)}, now(), now(), now())""")
        h.psql(f"""INSERT INTO student_profile (user_id, roll_number, department, year_of_study, verification_status, created_at, updated_at)
                   VALUES ({h.q(uid)}, {h.q('26EGRV' + str(n).zfill(4))}, 'CSE', 2, 'PENDING', now(), now())""")
        h.psql(f"""INSERT INTO verification_submission (id, user_id, college_id, roll_number, department, year_of_study, id_card_url, status, submitted_at)
                   VALUES ({h.q(sub)}, {h.q(uid)}, {h.q(college)}, {h.q('26EGRV' + str(n).zfill(4))}, 'CSE', 2,
                           {h.q('id-cards/' + uid + '/card.jpg')}, 'PENDING', now())""")
        first = "approve" if n % 2 else "reject"
        where = f"round {SHOP_ROUNDS + n} (verification, {first} with a {HEAD_START_MS} ms head start)"
        since = h.db_now()
        results = burst(tally, where, f"/admin/verification/{sub}", first)
        wins = [r for r in results if r.ok]
        sub_status = h.psql(f"SELECT status FROM verification_submission WHERE id={h.q(sub)}")
        profile = h.psql(f"SELECT verification_status FROM student_profile WHERE user_id={h.q(uid)}")
        audits = decisions([sub, uid], since)
        tally.note_rows("verification: decision audit rows", audits)
        problems = []
        if len(wins) != 1:
            problems.append(f"{len(wins)} decisions succeeded (must be exactly 1): {[r.call.label for r in wins]}")
        else:
            won[f"verification {wins[0].call.label}"] += 1
            expected = ("APPROVED", "VERIFIED") if wins[0].call.label == "approve" else ("REJECTED", "REJECTED")
            if sub_status not in (expected[0], expected[1]) or profile != expected[1]:
                problems.append(f"{wins[0].call.label} got the success but the submission is {sub_status} "
                                f"and the student's profile {profile}")
        if audits != 1:
            problems.append(f"{audits} approve/reject audit rows for one submission (must be exactly 1)")
        if any(r.status != 409 for r in results if not r.ok and r.status < 500):
            problems.append(f"losers were answered {sorted({r.key for r in results if not r.ok})} (expected 409)")
        for p in problems:
            tally.fail(f"{where} submission {sub}", p)
        tally.rounds_run += 1
        h.progress(not problems)

    # The students made for the verification rounds never signed in and own
    # nothing but their profile and submission; the audit rows about them stay.
    ids = ",".join(h.q(u) for u in made_users)
    if ids:
        h.psql(f"DELETE FROM verification_submission WHERE user_id IN ({ids})")
        h.psql(f"DELETE FROM student_profile WHERE user_id IN ({ids})")
        h.psql(f'DELETE FROM "user" WHERE id IN ({ids})')

    split = ", ".join(f"{k} won {v}" for k, v in won.items())
    print(f"\nwho won: {split}")
    if ROUNDS >= 4 and (won["verification approve"] == 0 or won["verification reject"] == 0):
        tally.invalid.append(f"one answer never won a verification round ({split})")
    return tally.finish(f"a pending shop or verification decided {N} times at once by two administrators was "
                        f"decided once ({split}): one success, one audit row, the row as the winner left it.")


h.main(run)
