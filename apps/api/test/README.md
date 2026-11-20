# Integration and stress harnesses

These are not unit tests. They run against a live API with a real PostgreSQL
and Redis behind it, and they exist to check the things a unit test cannot:
database constraints actually firing, and concurrency actually behaving.

Run the API and its dependencies first (`pnpm db:up`, `pnpm db:migrate`,
`pnpm db:seed`, `pnpm dev:api`).

## `verify-constraints.sql`

Attempts to violate every check constraint and append-only trigger in the
schema, one at a time, and expects each to be rejected.

```bash
psql "$DATABASE_URL" -f apps/api/test/verify-constraints.sql
```

A constraint that silently accepts bad data is worse than no constraint,
because the schema then documents a guarantee it does not provide. This file
is how that is checked rather than assumed.

Covers: tenancy (a student with no college), money arithmetic (a total that
does not equal its parts), coordinate ranges, the 1–5 km radius bounds, rating
bounds, task shape by type, rider presence matching status, the four-character
ceiling on stored government ID fragments, and `UPDATE`/`DELETE` against the
audit log and the wallet ledger.

## `fixtures.py` - what the seed does not create

```bash
python3 -I apps/api/test/fixtures.py [API_BASE]
```

`pnpm db:seed` makes the college, its shops and five accounts. Everything
below also needs five rider accounts to race (`racer1..5@anurag.edu.in`, ids
`rider-race-1..5`), a suspended student (`victim@`), a student to suspend
(`dropme@`), an owner for the seeded cafe (`cafe@example.com`), a second
college with its administrator (`admin@rit.edu.in`), rider terms accepted for
`srichandana@`, and the cafe open at whatever hour the checks are run.
`fixtures.py` creates all of it, is safe to run repeatedly (every step is an
upsert or "only if not already so"), and ends by checking through the API
that each account can do what the tests will ask of it. All passwords are the
seed's `Hoppo@dev123`.

It goes through the real HTTP API wherever a route exists - rider terms as
each rider, the suspension as the college administrator, the cafe's opening
hours as its owner - and uses SQL only where none does: the accounts
themselves (student sign-up is three rate-limited calls and ends at an
unverified student whose verification needs an uploaded ID photo; there is no
route that gives an existing shop an owner), verified student profiles, the
`shop_staff` link, and the second college. The password hash is copied from a
seeded user rather than computed.

Exit 0 when everything is in place, 3 when something could not be created or
does not work. `run-all.sh` runs it first and stops with exit 3 if it fails:
a harness that cannot sign in has proved nothing.

## The race harnesses

Twelve harnesses, one shape. Each one builds a fixture through the real HTTP API,
lines N requests up behind a thread barrier so they leave at the same instant,
then counts rows in PostgreSQL and compares them with what the callers were
told. A sequential test would pass against a read-then-write implementation
and prove nothing; these exist because every bug they look for only happens
when two requests overlap.

```bash
apps/api/test/run-all.sh                       # everything, against the dev stack
apps/api/test/run-all.sh http://localhost:4001/api/v1 http://localhost:3001
python3 -I apps/api/test/race-refund.py        # one harness
N=10 ROUNDS=40 python3 -I apps/api/test/race-refund.py http://localhost:4001/api/v1
```

Nothing names a port. The API base is the first argument or `HOPPO_API_BASE`;
the database and Redis come from `DATABASE_URL` and `REDIS_URL`, falling back
to `apps/api/.env`. Needs `psql` and `redis-cli` on the PATH, and the accounts
`fixtures.py` creates (run it once after a database reset; `run-all.sh` does). Python standard library
only; shared plumbing is in `harness_common.py`.

**How to read the output.** One `.` or `X` per round, then a block: N, rounds
run, requests intended and actually sent, the widest gap between the first and
last request leaving the barrier, a histogram of response codes, the row
counts seen, and one `RESULT:` line. Exit code 0 is a pass, 1 a violation, 2 a
harness that did not really race anything, 3 an environment block (API down,
seed missing).

**A harness that sent nothing must not pass.** Every harness fails itself
(`RESULT: FAIL - the harness did not exercise the race it claims to`) if the
number of responses differs from the number of requests it meant to send, if
any request in a burst came back 401 or 429 or not at all, if fewer than two
requests in a round reached the handler, or if the requests left more than a
quarter of a second apart. The API rate-limits per user per route, so the
harnesses read the `X-RateLimit-*` headers and wait before a burst rather than
discover afterwards that the limiter ate it; you will see `[limit:handover
38s]` in the progress line when that happens.

**Two kinds of failure are reported separately.** `database invariants: FAIL`
means the rows are wrong - money was created, a task has two riders. That is
the serious one, and on the wallet ledger it is permanent, because the table
is append-only. `responses: FAIL` means the rows are right but a caller was
told something wrong, in one of two ways, and every harness checks both on
every request it fires:

- **a 5xx.** Losing a race is an expected outcome with a 409 to say so; a 500
  tells the loser the server broke and tells a retrying client to try again.
- **an answer that came from a database constraint.** Since migration
  `20261120090000_wallet_integrity` the ledger has unique indexes (one hold
  and one release per order, one delivery fee per task) and a non-negative
  balance check. They are the last line, not the guard: if a request is
  stopped by one of them it means the application's own conditional UPDATE or
  wallet lock let a duplicate through as far as the INSERT. The exception
  filter turns such errors into `409 ALREADY_EXISTS` (unique index),
  `400 CONSTRAINT_VIOLATION` (check constraint or append-only trigger) or
  `500 DATABASE_ERROR`; none of those is a legitimate answer to anything a
  harness sends, so each is reported as `stopped by a database constraint,
  not by the application's own guard`, and counted on the summary line.

Both exit non-zero.

**The ledger is checked as a whole as well.** Harnesses that move money finish
with two checks over every wallet they touched: the running balance must be a
chain (each entry's balance follows from the entry before it, read in the
order the application reads it), and no two order entries for one user may
share a `created_at`. Ties that involve a rider-side entry are printed as a
`NOTE` rather than failed.

**What they leave behind.** This is a development database and the harnesses
write to it: real orders (student note `race harness <run id>`), and
`ADJUSTMENT` rows in `wallet_entry` with a note beginning `race-` or `race
harness`, used to fund a wallet because Phase 1 has no top-up endpoint. The
ledger cannot be cleaned up afterwards, by design. Orders that
`race-otp-cap.py` escalates stay `PICKED_UP` with an `ESCALATED` task until an
administrator resolves them. If a harness reports a duplicate
`ORDER_RELEASE`, `ORDER_HOLD` or `DELIVERY_FEE_EARNED` row, that row will also
stop migration `20261120090000_wallet_integrity` from building its unique
indexes - which is the migration working as intended; read its header.

### `race-stress.py` - one task, five riders (FR-DLV-04)

The assignment race, which the SRS warns is where projects like this break
during a demo. Each round inserts one `BROADCASTING` task, frees every rider,
and fires five concurrent accepts from five different riders, plus a sixth
from a rider the task was *not* offered to. It proves exactly one rider is
assigned: one HTTP 200, four `ALREADY_TAKEN`, `task.rider_id` equal to the
rider who got the 200, one `rider_state` row holding the task, the task
`ASSIGNED`, one chat room. Because the tasks are inserted by SQL, the harness
writes the dispatcher's offered-rider set in Redis itself
(`dispatch:offered:<taskId>`, same sentinel and TTL as
`DispatchService.recordOfferedRiders`), so the accept runs through the real
"were you offered this" check instead of its fail-open path; the sixth rider
must be refused (`NOT_OFFERED_TO_YOU`, or `ALREADY_TAKEN` if a racer's
assignment had already committed) and never assigned. A failure looks like `round 7: http200=2
db_rider=... holders=2` (two winners), `http200=0 ... others=['WORK_MODE_OFF']`
(nobody could accept - a setup problem), or `the rider who was not offered the
task got 200`.

### `race-two-tasks.py` - one rider, two tasks (FR-WM-07)

The other direction. One rider is offered two tasks and accepts both at once,
with K copies of each accept. It proves the rider ends holding exactly one:
one 200, one task `ASSIGNED` to them, `rider_state.active_task_id` pointing at
that same task, and the other task still `BROADCASTING` with no rider so the
next rider can take it. The bug it looks for is a plain overwrite of the
rider's state row, which leaves the first task assigned to someone who no
longer knows they hold it. A failure looks like `2 tasks ASSIGNED to the rider
(must be exactly 1)` or `rider_state says the rider holds A; the task table
says [B]`.

### `race-refund.py` - one wallet order, refunded N times (FR-PAY-06, FR-SHP-04)

Places a `WALLET` order (one `ORDER_HOLD` debit), then fires N refunds at it,
in four variants taken in rotation: (A) N student cancels; (B) the student's
cancel against the shop's reject, two endpoints that release the same hold;
(C) FR-DLV-07, "no rider was found" answered with "cancel, full refund" N
times; (D) the same with half the answers saying "I will collect it myself",
a full refund racing a delivery-fee-only one. For C and D the order is placed
and accepted through the API and its task is then set to `UNFULFILLED` by SQL,
because getting there for real takes three expired sixty-second broadcast
rounds per order. It proves the money comes back exactly once: one
`ORDER_RELEASE` row for the order, for the amount that one outcome is owed,
the student's balance back where it was before the order (or short by the
food's price if they collected it), the ledger's credits and debits agreeing
with the balance, one 200, order and task both closed. A failure looks like
`5 ORDER_RELEASE rows for the order (must be exactly 1)` together with
`balance 3500 before the order, 17500 after the refund` - a student paid to
cancel. If the rows are right but the summary says `responses: FAIL`, the
losers of the race were given a 500 instead of a 409.

### `race-wallet-spend.py` - one order's worth of money, spent N times (FR-PAY-07)

Brings a student's wallet to exactly the price of one order and fires N
`WALLET` placements at once. It proves the balance buys one order: one 201,
the rest `INSUFFICIENT_WALLET_BALANCE`, one new order row (a refused placement
must roll back completely), one `ORDER_HOLD` row, a final balance of zero, and
no ledger row with a negative running balance. A failure looks like `3
placements answered 201 with money for one`, `3 ORDER_HOLD rows`, and `balance
is -7000` or - the quieter version of the same bug - a balance of 0 with three
holds against it, because each hold was computed from the same stale balance.

### `race-payout.py` - one delivery, completed N times (FR-DLV-13, FR-DLV-15)

Drives an order all the way to `PICKED_UP` through the real flow: placed,
accepted and readied by the shop, broadcast by the dispatcher, accepted and
picked up by a rider. The student's handover code is fetched the way their
screen fetches it (`POST /tasks/:id/handover-code/reissue`), and the rider
then submits the correct code N times at once - a double tap, or a retry after
a timeout. Odd rounds are `CASH` orders, even rounds `WALLET`. It proves the
rider is paid once: one 200, one `DELIVERY_FEE_EARNED` row for the task,
`rider_reliability.tasks_completed` up by exactly one, the rider's balance up
by the fee on a wallet order and unchanged on a cash one (ADR-006), one
`ORDER_CAPTURE` on a wallet order, task and order `COMPLETED`, the rider
freed. A failure looks like `2 DELIVERY_FEE_EARNED rows for the task` and
`tasksCompleted moved by 2`. If it cannot build its fixture it says so
(`the dispatcher never offered task ... within 75s`) rather than passing.

### `race-otp-cap.py` - the attempt cap on the handover code (FR-DLV-14)

Carries an order to `PICKED_UP` the same way, then sends wrong codes. Burst
one is fewer than the cap, all at once: `task.otp_attempts` must advance by
exactly the number of requests that were evaluated, and each caller must be
told a different "attempts remaining". Burst two, after a reissue resets the
counter, is more than the cap: the counter must stop at the cap, exactly
cap-minus-one callers may be told "incorrect", the task must be `ESCALATED`,
and nothing may be completed or paid. The cap is read from
`college_config.max_otp_attempts`. It proves that sending guesses together
does not buy extra guesses. A failure looks like `3 wrong codes were evaluated
but otp_attempts advanced by 1` (every request read the same count) or
`otp_attempts 8 exceeds the cap 5`.

### `race-abandon-pickup.py` - "I give up" against "I have collected it" (M4)

One rider, one `ASSIGNED` task with its order `READY`, and both
`POST /rider/tasks/:id/abandon` and `.../pickup` at the same instant. It
proves only one takes effect and that every row agrees with whichever it was:
abandon leaves the task `CREATED` or `BROADCASTING` with no rider and no code,
the order `READY`, the rider free and `tasks_abandoned` up by one; pickup
leaves task and order `PICKED_UP`, the rider holding it, a code issued and
`tasks_abandoned` untouched. Pickup hashes the code before it writes, so
abandon wins a dead heat; the harness holds abandon back by a growing head
start until each side has won, prints the split (`who won: abandon won 5,
pickup won 5`), and fails itself if one side never did. A second scenario
sends the same pickup several times and listens on the student's socket: one
200, exactly one `task:handover-code` event, and that code must complete the
delivery. A failure looks like `2 of the two requests answered 200`, `order
PICKED_UP but the task has no rider`, or `2 handover codes reached the
student's socket`. Abandons count towards the rider ban, so the harness raises
`college_config.abandonment_ban_threshold` for the run and restores it.

### `race-sweep-cancel.py` - the student's cancel against the accept-window sweep

A shop that never answers has the order cancelled for it by a cron
(`sweepUnacceptedOrders`, every thirty seconds), which also releases a wallet
hold - a second writer of `ORDER_RELEASE`, in a different module, firing at
about the moment a student gives up waiting. Each round places K wallet
orders, moves their `placed_at` back past the accept window with one SQL
UPDATE two seconds before the cron's next tick (the window itself,
`shop_accept_window_seconds`, is not changed), and spreads one student cancel
per order across the tick. It proves each order is refunded once whoever got
there first: one `ORDER_RELEASE`, `payment_status = REFUNDED`, order and task
`CANCELLED`, the student told 200 if and only if `cancelled_by` is `STUDENT`,
every wallet back where it started. The spread is steered until both writers
have won and the split is printed; a run where the sweep never won fails
itself. A failure looks like `2 ORDER_RELEASE row(s) totalling 7000 paise`, or
`payment_status is HELD after the refund [cancelled by SYSTEM]`. The harness
and the API must share a clock.

### `race-unfulfilled.py` - the three answers to "no rider was found" (FR-DLV-07)

The slow one, about four minutes, because its fixture is real: wallet orders
are placed, accepted and readied with no rider online, and the harness waits
for the dispatcher to exhaust its broadcast rounds. Each order is then
answered N times at once with two different choices, rotating which has a
short head start. It proves the question is settled once, whichever answer
wins: `CANCEL` releases the full total and marks the order `REFUNDED`;
`COLLECT_IN_PERSON` releases the delivery fee, writes one zero-amount
`ORDER_CAPTURE`, marks it `CAPTURED` and completes the order; `KEEP_WAITING`
writes nothing to the ledger, puts the task back on its way to riders, and
leaves every earlier `broadcast_log` row in place with none still `PENDING`.
Losers get `409 NOT_UNFULFILLED`. A failure looks like `CANCEL: 2
ORDER_RELEASE row(s) totalling 7000 paise`, `kept waiting but the task is
UNFULFILLED`, or a 5xx on `answer KEEP_WAITING` (it once issued a DELETE the
append-only trigger refuses). It fails itself if one of the three answers
never won. `SKIP_SLOW=1 run-all.sh` leaves it out.

### `race-escalation-resolve.py` - two administrators, one escalated delivery (FR-ADM-04)

A delivery whose code was entered wrongly too many times waits for an
administrator to say what happened: `DELIVERED` (the rider is paid, as if the
code had been right) or `NOT_DELIVERED` (task and order cancelled, the rider
paid nothing). Each round escalates a real order with the configured number
of wrong codes and fires N `POST /admin/escalations/:taskId/resolve` at once
from two administrator accounts, half saying each, with the head start
alternating; for a wallet order, where the server does not offer
`NOT_DELIVERED`, all N say `DELIVERED`. It proves there is one resolution:
one 200, the rest `409 ALREADY_RESOLVED`; task and order in the state that
one answer describes; one `DELIVERY_FEE_EARNED` row if delivered and none
otherwise, with the rider's completed count to match; exactly one
`TASK_RESOLVED` audit row carrying the winner's note; and the escalation
reading back resolved with `canResolveAs: []`. Another college's
administrator is refused before the race. A failure looks like `2 resolves
answered 200: ['DELIVERED', 'NOT_DELIVERED']`, `the rider was paid 2 times
for one delivery`, or `2 TASK_RESOLVED audit rows`. It fails itself if one of
the two outcomes never won.

### `race-shop-reinstate.py` - two administrators, one suspended shop

One shop is registered and approved for the run; each round suspends it and
fires N `POST /admin/shops/:listingId/reinstate` at once from two
administrators. It proves one decision is recorded once: one 200, the rest
`409 NOT_SUSPENDED`, exactly one `SHOP_REINSTATED` audit row written in the
round and naming the administrator who got the 200, the listing `ACTIVE`. A
failure looks like `6 reinstates answered 200` with `6 SHOP_REINSTATED audit
rows for one reinstatement` - the status was read and then written, and the
audit log, which cannot be edited, now says it happened six times. The shop
is left suspended.

### `race-admin-decisions.py` - approve against reject, on one pending application

Two administrators working the same queue can give different answers to the
same row at once. Each round takes one pending shop (registered through the
API) or one pending verification submission (inserted for a student made for
the round) and fires N approves and rejects together from two administrators,
alternating which has the head start. It proves the application is decided
once: one success, the rest `409 ALREADY_DECIDED`; the listing `ACTIVE` or
`REJECTED` as the winner chose (for a verification, the submission and the
student's profile agreeing); exactly one approve-or-reject audit row. A
failure looks like `5 decisions succeeded: ['approve', 'reject', 'reject',
'approve', 'reject']` with `5 approve/reject audit rows for one listing` - the
row ends as whoever wrote last and the audit log records decisions that did
not stand. Few shop rounds, because shop registration allows five a minute.

## `e2e-admin.py` - the administrator's side

Not a race: about eighty single requests, each with a stated expectation.
It starts from the SRS's own acceptance test (section 12.3, "...and the order
appears in the administrator's report"): it delivers an order through the
real flow, finds it by reference in `GET /admin/orders`, and checks that its
detail has the complete timeline in time order, that its money is integer
paise that add up (items + delivery + platform = total), and that every
figure in today's summary equals the same figure computed from the database.
Another college's administrator finds nothing and gets `403
CROSS_TENANT_ACCESS` on the detail; none of the responses contains a mobile
number or an email address, checked against the student's and rider's real
ones. It then proves a fee-band change is audited with before and after and
is charged on the very next quote (restored in a `finally`); that
deactivating a delivery point takes it out of the student's picker and
reactivating puts it back; that the audit log shows an administrator only
their own college's rows, whatever they ask for; and that a super
administrator can create a college and its administrator, who signs in to an
empty college and is locked out with `COLLEGE_INACTIVE` once the college is
deactivated. A failure is one `FAIL` line naming what was expected and what
came back. Each run leaves one completed order, one inactive "E2E Test
Point" (reused next time) and one deactivated "E2E College".

## `e2e-admin-actions.py` - the administrator's buttons, pressed for real

The consoles' own walk checks these actions against intercepted requests,
which proves the screen sends the right thing. This proves the API does the
right thing with it, on fixtures it creates and puts back: it registers a
student through the sign-up routes, suspends them and confirms their token
stops working, their open socket is dropped and their refresh token is dead,
then reinstates them and signs in again; registers and approves a shop,
suspends it (gone from the students' list, still reachable by its owner) and
reinstates it; saves a configuration value and reads it back from the row and
the audit log; reverses the delivery points and checks the students' picker
follows, then restores the order; and escalates a real delivery with wrong
codes and resolves it - one payout, the requester's socket told an
administrator resolved it, gone from the list, a second resolve refused. A
failure is one `FAIL` line naming what was expected and what came back.

## `e2e-account.py` - a person's own account

Registers a student, signs them in from a named device, gives them an avatar
reference and a device token, and deletes the account. It then checks the
database rather than the response: the name, number and email are gone from
the row; no session row still carries their IP address or user agent; device
tokens and the avatar reference are gone; a rename writes an audit row that says the name changed without
holding either name; no audit row written from the deletion onwards names
them; the response's `caveats` admit that past audit entries cannot be
altered; and every item the response lists as `erased`
really was - the list may not overstate. It proves deletion and export are for
students only (an administrator, a super administrator and a shop owner are
refused by role; only wrong passwords are ever sent, so an open door deletes
nothing), and that deactivating a college revokes its users' refresh tokens, drops
their open sockets and refuses new ones with `COLLEGE_INACTIVE`. A failure looks like `no session row still carries the
person's IP address or user agent [2 with an IP address, 2 with a user agent,
of 2]` or `super@hoppo.app is refused POST /account/delete by role [403
PASSWORD_INCORRECT]`. It cannot check that the avatar *object* left the
bucket: object storage is not configured in development.

## `e2e-shop-approval.py` - who may reach what, before and after approval

Not a race: thirty-odd single requests, each with a stated expectation,
against the live API and its socket. It registers a new shop, and proves the
unapproved owner can sign in, read `/shops/mine` and `/auth/me` and sign out,
and nothing else - `403 SHOP_NOT_APPROVED` on orders, rider, browse, uploads,
their own catalog and order queue - and that the `/rt` socket refuses them,
printing how (`connect`, then an `exception` event carrying the code, then
`disconnect`; or a handshake `connect_error`). It then proves another shop's
owner cannot see the pending listing, another college's administrator cannot
approve it or read this college's shop queue, the admin queue survives
`?limit=abc` and caps `?limit=100000`, and that after the college's own
administrator approves it the *same token* opens browse, the catalog and the
socket while student routes stay 403 on role. Last, it suspends a student and
proves their open socket is dropped and their refresh token and access token
stop working. A failure is one `FAIL` line naming the route and what came
back. Each run leaves one more approved shop behind.

## `walk-api.py` - the web app's calls, in the web app's order

```bash
python3 -I apps/api/test/walk-api.py [API_BASE]
```

Not a race and not a re-test of the API: it makes the calls `apps/web` makes,
in the order its screens make them, and checks that every field a screen reads
is actually in the response (about 180 checks). A screen can typecheck against
a hand-written response type and still read a field the server never sends.
It signs in as the student, browses, quotes, is refused a stale total
(`PRICE_CHANGED`, with both totals in `details`), places an order, has the
shop accept and ready it, takes it as the rider once the dispatcher offers it,
picks up, is refused a wrong handover code, completes with the right one, and
confirms the student's order detail never carries the rider's contact number.
The rider stands at a delivery point the API returned and goes online before
the shop readies the order, because an offer only goes to riders who were in
range and online when it was broadcast. A failure is a list of lines such as
`order detail: missing field task.status` or `accept: 409 NOT_OFFERED_TO_YOU`.
Standard library only; it needs the accounts `fixtures.py` creates.

The second walk drives the web app itself in a headless browser at a phone
viewport (sign-up errors, the verify gates, search, cart, checkout, a
two-person delivery with a real offer over the rider's socket and the handover
code over the student's, a ceiling on `GET /auth/me`, the screens' wording
for a changed price, a refund, an escalated delivery, an order collected in
person and a rider timed out for silence, the receipt, and the privacy
screens: a real registration that must accept the notice, a real data export
compared with the database, and a real account deletion). It needs Playwright, which is not a dependency
of this repository, so it lives outside it (`$WALK_DIR/pw/browser.mjs`);
`run-all.sh` runs it when it is there and prints `SKIP` when it is not.

### `run-all.sh` - everything, in order

Runs `fixtures.py`, both walks, the four end-to-end checks and the twelve harnesses in
sequence against one API base and one web origin, prints one `PASS` / `FAIL`
/ `BLOCKED` line each, and exits non-zero unless all of them passed (3 if the
fixtures could not be created, in which case nothing else is run). A check
that dies because the watch-mode API restarted under it is retried once after
twenty seconds. `SKIP_WALKS=1` runs the harnesses alone, `SKIP_BROWSER=1`
leaves out only the browser walk, and `SKIP_SLOW=1` leaves out
`race-unfulfilled.py`. A full run takes about twenty minutes. Full output
for each check is kept in the log directory it prints.

It also says when the ground moved. At the start it prints when PostgreSQL,
Redis and the API last started and whether any restarted since the previous
run (`services.py`: `pg_postmaster_start_time()`, Redis `uptime_in_seconds`
and `run_id`, the API's reported uptime); after any check that does not pass,
and again at the end, it says whether one restarted *during* this run. A
development container that restarts takes all three down and brings Redis
back empty, and without this that reads as a string of unrelated failures.

**One at a time.** The harnesses are serial by design and must not be run in
parallel with each other, with a second copy of this script, or with the
walks. They share the five racer accounts and their rate limits, and each one
that uses riders begins by taking every *other* rider offline
(`quiet_other_riders`, which changes shared rider state in PostgreSQL and
Redis) and ends by taking its own offline; two running together would switch
each other's riders off mid-race and report it as the dispatcher never
offering a task.

The last check, `scan-broadcast-log.py`, reads the dispatcher's log as the run
left it and fails on any of three states the dispatcher cannot produce: a
`PENDING` row on a finished task, two rows for one (task, cycle, round), or a
`PENDING` row from a cycle older than the task's current one. It counts rows
written since the run began and prints all-time counts beside them.

Run it on a quiet stack. The harnesses and walks use the seeded rider
accounts; anything else driving those accounts at the same time (a second
copy of this script, another tool pinging the same rider from somewhere else)
moves riders out of range or makes them busy, and the checks that need a real
offer will report that the dispatcher never offered the task.
