#!/usr/bin/env python3
"""
Race the handover-code attempt cap (FR-DLV-14).

A six-digit code with a five-attempt cap is only a cap if the attempts are
counted. A read-then-write counter lets fifty wrong guesses sent together all
read 0 and all write 1: "five attempts" becomes "five batches of as many as
you like".

Each round carries one order to PICKED_UP and then fires wrong codes at it:

  burst 1: fewer than the cap, at once. The counter must advance by exactly
           the number of requests that were evaluated - not by one.
  burst 2: (after a reissue, which resets the counter) more than the cap, at
           once. The counter must stop at the cap, exactly cap-1 requests may
           be told "incorrect, n left", the task must be ESCALATED, and nothing
           may complete or be paid.

The cap is read from college_config.max_otp_attempts, not assumed.

    python3 apps/api/test/race-otp-cap.py [BASE]      (ROUNDS=10 by default)
"""
import os
import sys

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness_common as h  # noqa: E402

ROUNDS = h.env_int("ROUNDS", 10)
OVER = h.env_int("OVER", 3)       # how many requests beyond the cap in burst 2


def attempts(task: str) -> int:
    return int(h.psql(f"SELECT otp_attempts FROM task WHERE id={h.q(task)}"))


def wrong(code: str) -> str:
    return "000000" if code != "000000" else "111111"


def run() -> int:
    cap = int(h.psql(f"SELECT max_otp_attempts FROM college_config WHERE college_id={h.q(h.college_id())}"))
    under, over = max(2, cap - 2), cap + OVER
    tally = h.Tally("race-otp-cap", over, ROUNDS)
    total = h.quote_total(h.RACERS[0])
    print(f"OTP cap race: configured cap {cap}. Per round: {under} wrong codes at once, then "
          f"{over} wrong codes at once. {ROUNDS} rounds.")
    h.free_riders(h.RACERS)
    n = 0

    with h.Riders(h.RACERS):
        for batch in h.batches(ROUNDS, ["CASH"]):
            for fx in h.prepare_carried_orders(batch, total):
                n += 1
                task, rider = fx["task_id"], fx["rider"]
                problems = []

                # ---- burst 1: under the cap -------------------------------
                where = f"round {n} burst 1"
                a0 = attempts(task)
                results = tally.fire(where, [
                    h.Call("wrong code", "POST", f"/rider/tasks/{task}/handover", rider,
                           {"code": wrong(fx["code"])}, route="handover") for _ in range(under)])
                evaluated = [r for r in results if r.evaluated and r.status < 500]
                a1 = attempts(task)
                tally.note_rows(f"burst 1 ({under} sent) otp_attempts advanced by", a1 - a0)
                if a1 - a0 != len(evaluated):
                    problems.append(f"burst 1: {len(evaluated)} wrong codes were evaluated but otp_attempts "
                                    f"advanced by {a1 - a0}")
                if a1 > cap:
                    problems.append(f"burst 1: otp_attempts {a1} exceeds the cap {cap}")
                if any(r.ok for r in results):
                    problems.append("burst 1: a wrong code was accepted")
                remaining = sorted(r.body.get("details", {}).get("attemptsRemaining") for r in results
                                   if r.code == "OTP_INCORRECT")
                if remaining != list(range(cap - a0 - len(evaluated), cap - a0)):
                    problems.append(f"burst 1: callers were told attemptsRemaining={remaining}; "
                                    f"{len(evaluated)} distinct counts were expected")
                status = h.psql(f"SELECT status FROM task WHERE id={h.q(task)}")
                if status != "PICKED_UP":
                    problems.append(f"burst 1: task is {status} with attempts to spare (must stay PICKED_UP)")

                # ---- burst 2: over the cap, on a fresh code ---------------
                where = f"round {n} burst 2"
                code = h.reissue_code(fx["student"], task)
                if attempts(task) != 0:
                    problems.append("a reissued code did not reset otp_attempts to 0")
                results = tally.fire(where, [
                    h.Call("wrong code", "POST", f"/rider/tasks/{task}/handover", rider,
                           {"code": wrong(code)}, route="handover") for _ in range(over)])
                evaluated = [r for r in results if r.evaluated and r.status < 500]
                a2 = attempts(task)
                incorrect = sum(1 for r in results if r.code == "OTP_INCORRECT")
                status = h.psql(f"SELECT status FROM task WHERE id={h.q(task)}")
                fees = h.rows(f"task_id={h.q(task)} AND type='DELIVERY_FEE_EARNED'")
                tally.note_rows(f"burst 2 ({over} sent) otp_attempts", a2)
                tally.note_rows("burst 2 OTP_INCORRECT answers", incorrect)

                if a2 > cap:
                    problems.append(f"burst 2: otp_attempts {a2} exceeds the cap {cap}")
                if a2 != min(cap, len(evaluated)):
                    problems.append(f"burst 2: {len(evaluated)} wrong codes evaluated, otp_attempts is {a2}, "
                                    f"expected {min(cap, len(evaluated))}")
                if len(evaluated) >= cap and incorrect != cap - 1:
                    problems.append(f"burst 2: {incorrect} requests were told 'incorrect, try again' "
                                    f"(must be exactly {cap - 1}: the cap-th wrong code ends it)")
                if any(r.ok for r in results):
                    problems.append("burst 2: a wrong code was accepted")
                if len(evaluated) >= cap and status != "ESCALATED":
                    problems.append(f"burst 2: task is {status} after {cap} wrong codes (must be ESCALATED)")
                if fees:
                    problems.append(f"{fees} DELIVERY_FEE_EARNED row(s) for a delivery that never completed")
                unexplained = {r.code for r in results if r.status < 500} - {
                    "OTP_INCORRECT", "OTP_ATTEMPTS_EXHAUSTED", "NOT_AWAITING_HANDOVER"}
                if unexplained:
                    problems.append(f"burst 2: unexpected answers {sorted(unexplained)}")

                for p in problems:
                    tally.fail(f"round {n} task {task}", p)
                tally.rounds_run += 1
                h.progress(not problems)
                if status == "ESCALATED":
                    # Checked; now close it the way an administrator would, so
                    # the escalations list does not grow by ten a run. (Thirty
                    # resolves a minute are allowed.)
                    h.make_room("admin@anurag.edu.in", "resolve", 1)
                    h.http("POST", f"/admin/escalations/{task}/resolve", h.login("admin@anurag.edu.in"),
                           {"outcome": "NOT_DELIVERED", "note": f"race-otp-cap {h.RUN}: harness fixture, closed after the check"},
                           who="admin@anurag.edu.in", route="resolve")

    return tally.finish(f"wrong codes sent together were each counted, and the cap of {cap} was never "
                        "exceeded: no batch bought extra guesses.")


h.main(run)
