#!/usr/bin/env python3
"""
Race two administrators reinstating the same suspended shop.

Reinstating is "set the listing ACTIVE and write an audit row". If the status
is read first and written afterwards, two administrators pressing the button
together both find it SUSPENDED and both reinstate it: two 200s and two
SHOP_REINSTATED rows for one decision, in an audit log that cannot be edited.

One shop is registered and approved for the run. Each round suspends it and
fires N reinstates at once from two administrators of the college. Every
round must leave exactly one 200, the rest 409 NOT_SUSPENDED, exactly one
SHOP_REINSTATED audit row written in the round, and the listing ACTIVE. The
shop is left suspended at the end so the students' list does not grow.

    python3 apps/api/test/race-shop-reinstate.py [BASE]      (N=6 ROUNDS=15 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

N = h.env_int("N", 6)
ROUNDS = h.env_int("ROUNDS", 15)
ADMINS = ["admin@anurag.edu.in", "admin2@anurag.edu.in"]


def run() -> int:
    tally = h.Tally("race-shop-reinstate", N, ROUNDS)
    print(f"Shop-reinstate race: {N} reinstates at once from two administrators on one suspended shop, {ROUNDS} rounds.")
    shop = h.register_shop("reinstatable")
    lid = shop["listing_id"]
    admin = h.login(ADMINS[0])
    status, res = h.http("POST", f"/admin/shops/{lid}/approve", admin, {})
    if status not in (200, 201):
        raise RuntimeError(f"approving the fixture shop failed: {status} {res.get('code')}")

    for n in range(1, ROUNDS + 1):
        where = f"round {n}"
        status, res = h.http("POST", f"/admin/shops/{lid}/suspend", admin, {"reason": f"race harness {h.RUN} round {n}"})
        if status not in (200, 201) or h.psql(f"SELECT status FROM shop_listing WHERE id={h.q(lid)}") != "SUSPENDED":
            raise RuntimeError(f"suspending the fixture shop failed: {status} {res.get('code')}")
        since = h.db_now()
        results = tally.fire(where, [h.Call("reinstate", "POST", f"/admin/shops/{lid}/reinstate", ADMINS[i % 2], {},
                                            route="reinstate") for i in range(N)])
        wins = [r for r in results if r.ok]
        audits = h.audit_rows("SHOP_REINSTATED", lid, since)
        listing = h.psql(f"SELECT status FROM shop_listing WHERE id={h.q(lid)}")
        tally.note_rows("SHOP_REINSTATED audit rows", audits)
        problems = []
        if len(wins) != 1:
            problems.append(f"{len(wins)} reinstates answered 200 (must be exactly 1)")
        if audits != 1:
            problems.append(f"{audits} SHOP_REINSTATED audit rows for one reinstatement (must be exactly 1)")
        if listing != "ACTIVE":
            problems.append(f"the listing is {listing} (must be ACTIVE)")
        refused = {r.code for r in results if not r.ok and r.status < 500} - h.DB_CAUGHT
        if refused - {"NOT_SUSPENDED"}:
            problems.append(f"losers were refused with {sorted(refused)} (expected NOT_SUSPENDED)")
        if len(wins) == 1 and audits == 1:
            actor = h.psql(f"SELECT actor_id FROM audit_log WHERE action='SHOP_REINSTATED' AND target_id={h.q(lid)} "
                           f"AND created_at >= {h.q(since)}")
            if actor != h.user_id(wins[0].call.email):
                problems.append(f"the audit row names {actor}, but {wins[0].call.email} got the 200")
        for p in problems:
            tally.fail(f"{where} listing {lid}", p)
        tally.rounds_run += 1
        h.progress(not problems)

    h.http("POST", f"/admin/shops/{lid}/suspend", admin, {"reason": f"race harness {h.RUN} finished; left suspended"})
    return tally.finish("a shop reinstated by two administrators at once was reinstated once: one 200, one audit row.")


h.main(run)
