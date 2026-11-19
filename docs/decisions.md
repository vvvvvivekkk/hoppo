# Decision records

Each entry records a decision that was not obvious, the alternatives that were
considered, and what it costs. The point of writing them down is that in six
months the reasoning is still available, and a reviewer can disagree with the
*decision* rather than guessing at the intent.

Format: context, decision, consequences. Short on purpose.

---

## ADR-001 — Task assignment is a single conditional UPDATE

**Status:** accepted · Phase 1A

### Context

`FR-DLV-04` requires that a task broadcast to many riders is assigned to
exactly one of them, on a first-accept basis. Riders accept within
milliseconds of each other on a popular task.

The naive implementation reads the task, checks whether `rider_id` is null,
and writes if it is. Two requests can both pass the check before either write
lands — a **race condition**. The result is two riders dispatched to one
pickup, which is the failure the SRS itself warns will embarrass the product
in front of real users.

### Alternatives considered

1. **Application-level check.** Read, check, write. Rejected: this *is* the
   bug. The window between read and write is exactly where the race lives, and
   it cannot be closed in application code.
2. **Redis lock.** Acquire a lock on the task id, then write. Rejected as a
   source of truth: Redis and Postgres can disagree (a lock expires mid-write,
   Redis restarts, the network partitions), and the invariant "one rider per
   task" must hold even when the cache is wrong. Useful as a cheap
   *optimisation* to avoid hammering the database, never as the guarantee.
3. **Serializable transaction isolation.** Correct, but turns every contended
   accept into a retry loop and costs throughput for a problem one statement
   solves.
4. **Conditional UPDATE.** Chosen.

### Decision

Assignment is one statement:

```sql
UPDATE task
SET rider_id = $1, status = 'ASSIGNED', assigned_at = now()
WHERE id = $2 AND rider_id IS NULL AND status = 'BROADCASTING';
```

The row count tells you the outcome. `1` means the caller won. `0` means
another rider won, or the task moved on, and the API returns a clear
"already taken" response.

This is reinforced structurally:

- `task.rider_id` is nullable, and a check constraint
  (`task_rider_presence_matches_status`) requires it to be null in
  `CREATED` / `BROADCASTING` / `UNFULFILLED` and non-null once `ASSIGNED`.
- `rider_state.active_task_id` is `UNIQUE`, so one rider cannot hold two
  tasks even if the application tries (`FR-WM-07`).

### Consequences

- No lock management, no retry loop, no lease expiry to reason about.
- The rule is enforceable in review: any code path that assigns a rider
  without a conditional `WHERE` is a bug, and that is easy to grep for.
- Losing riders get a response in one round trip rather than waiting on a
  lock.

---

## ADR-002 — PostGIS owns the geodesic distance; TypeScript owns the label

**Status:** accepted · Phase 1A

### Context

Constraint `C-2` requires geodesic distance between a shop and its college,
"not road distance". `FR-SHOP-06` rejects a registration when that distance
exceeds the radius, so the number is a gate, not a decoration.

The SRS's §9.3 also asks for "a geospatial index on
`rider_state(last_lat, last_lng)`". A plain composite index on two numeric
columns cannot answer "riders within 500 m of this point" — it can only answer
"riders whose latitude falls between X and Y", which describes a box, not a
circle, and degrades badly as the table grows.

### Decision

Two tools for two different jobs.

**The gate** is `hoppo_geodesic_distance_m(lat_a, lng_a, lat_b, lng_b)`, a SQL
function created in the integrity-constraints migration. It casts both points
to PostGIS `geography` and calls `ST_Distance`, which returns metres along the
spheroid. It is the single authority for `C-2`.

**The label** — "1.2 km away", list sorting, drawing a radius circle — uses
haversine in `packages/shared/src/geo.ts`. No round trip, accurate to a few
metres over campus distances, and documented as unfit for an admission
decision.

**Rider proximity** at broadcast does not touch Postgres at all. Online riders
live in a Redis GEO set per college, refreshed on each ping, and `GEOSEARCH`
answers the proximity query in sub-millisecond time. Postgres keeps the last
known position for audit and the admin console only. A rider pinging every
fifteen seconds would otherwise generate a write per rider per ping, which is
the wrong shape of load for a relational database.

### Consequences

- The §9.3 index as written is not implemented, because it would not work.
  `docs/srs-resolutions.md` records this.
- PostGIS becomes a hard dependency of the database. It is declared in
  `schema.prisma`'s `extensions`, so `prisma migrate` creates it rather than it
  being a manual setup step somebody forgets.
- Redis is load-bearing for dispatch *performance* but not for *correctness*:
  if it is wiped, riders re-report on their next ping and the worst outcome is
  one broadcast reaching fewer riders.
- A test worth keeping: one degree of longitude at the equator must come back
  as 111,319.5 m.

---

## ADR-003 — The shop unlocks pickup; only the rider writes it

**Status:** accepted · Phase 1A

### Context

`FR-SHP-06` says "the shop shall confirm handover to the rider, moving the
order to `PICKED_UP`". `FR-DLV-11` says "the rider shall mark `PICKED_UP`".

Two actors, two requirements, one transition — and two separate rows (`order`
and `task`) that both carry a pickup state. If both actors can write it, the
rows drift apart and reports disagree about when the handover happened.

### Decision

The shop's confirmation sets the order to `READY` and *unlocks* the rider's
pickup button. Only the rider's tap writes `picked_up_at`, and it writes both
rows inside one database transaction.

One actor, one write, two rows that cannot diverge.

### Consequences

- The shop dashboard's "confirm handover" control is a permission grant, not a
  state write. The UI has to say so clearly, or a shop owner will expect the
  order to move when they tap it.
- The rider's pickup endpoint must verify the order is `READY` before
  accepting — otherwise a rider could mark pickup before the food is packed.
- `order.status` and `task.status` remain separate state machines, which is
  correct: a parcel pickup has a task and no order at all.

---

## ADR-004 — The platform absorbs the re-broadcast fee increment

**Status:** accepted · Phase 1A

### Context

`FR-ORD-03` shows the student a total, including the delivery fee, before they
confirm. `FR-DLV-06` raises the fee on each re-broadcast round when no rider
accepts. The SRS never says who pays the difference.

### Alternatives considered

1. **Charge the student the increment.** Rejected. They agreed to a price; a
   silent increase because the platform struggled to find a rider is
   indefensible and would be the first thing a user complains about.
2. **Pay the rider the original fee and advertise a higher one.** Rejected:
   dishonest, and riders would notice immediately.
3. **Platform absorbs it.** Chosen.

### Decision

`task.base_fee_minor` is what the requester was quoted and will be charged.
`task.fee_minor` is what a rider is currently offered. They are equal on round
one and diverge as rounds increase. The difference is the platform's cost of
filling a hard task, surfaced as `platformSubsidyMinor` in the fee quote.

A check constraint (`task_fee_not_below_base`) enforces that the offer is never
*below* the quote.

### Consequences

- Hard-to-fill tasks have a real, measurable cost, which is a useful signal:
  if the subsidy is large and routine, the base fee bands are wrong.
- `FR-ADM-05`'s operational dashboard should report total subsidy, so this
  stays visible rather than quietly eating the margin.
- With a ₹25 fee and a 10% take on a ₹120 order — about ₹37 gross per delivery
  — two re-broadcast rounds at ₹5 each is a quarter of the gross. The
  increment and the number of rounds both need tuning against real data, not
  guessing.

---

## ADR-005 — Dispatch runs on scheduled jobs, not on request handlers

**Status:** accepted · Phase 1A

### Context

Three things in the SRS must happen at a time, with no user action to trigger
them:

- `FR-DLV-01` — broadcast once an order's remaining preparation time drops
  below the configured lead, so the rider arrives near the ready time.
- `FR-DLV-06` — re-broadcast when a 60-second acceptance window expires.
- `FR-WM-06` — disable work mode after two hours without a ping.

No requirement in the SRS creates the thing that does this. §9.3 mentions "the
dispatcher poll" in passing, which is the only hint it exists.

### Decision

The API runs scheduled jobs (`@nestjs/schedule`) that scan for due work using
the partial indexes added in the integrity migration:

- `task_dispatch_due_partial` — `WHERE status = 'CREATED' AND dispatch_due_at IS NOT NULL`
- `task_offer_expiry_partial` — `WHERE status = 'BROADCASTING' AND offer_expires_at IS NOT NULL`

A **partial index** covers only rows matching a condition, so these stay small
however large the task table grows — completed tasks are simply not in them.

Each tick takes a short Redis lock per task (`lock:dispatch:<taskId>`) so that
two API instances cannot process the same task twice. The lock is an
optimisation; correctness still rests on the conditional UPDATE of ADR-001 and
on the state machine refusing illegal transitions.

### Consequences

- Dispatch granularity is the tick interval. A few seconds is fine for a
  seven-minute lead time; the acceptance-window sweep needs to run more often
  than the window is long.
- The jobs must be idempotent and safe to run concurrently, because a deploy
  can briefly overlap two instances.
- A new requirement, `FR-DLV-00`, is proposed in `docs/srs-resolutions.md` so
  the dispatcher is traceable rather than implicit.

---

## ADR-006 — Cash-on-delivery settles rider-to-shop, with the wallet as a record

**Status:** accepted · Phase 1A

### Context

`FR-PAY-01` makes cash-on-delivery the default for the academic release.
`FR-DLV-15` credits the delivery fee to the rider's *wallet* on completion.
`FR-PAY-05` lets a student withdraw a wallet balance.

Those three do not close. With cash, the rider physically collects the full
total at the door. Of that, the shop is owed the item subtotal and the rider is
owed the fee. But the fee is credited as wallet balance — so the rider ends up
holding cash *and* a claim on the platform, and the shop is owed money the
platform never touched. There is no requirement anywhere settling with the
shop.

### Decision

For `paymentMethod = CASH`:

1. The rider pays the shop the item subtotal in cash at pickup.
2. The rider collects the full total from the student at the drop point.
3. The rider keeps the delivery fee as physical cash.
4. The wallet records the fee as a **statement line, not a claim** — a
   `DELIVERY_FEE_EARNED` ledger entry that is informational, so the rider's
   earnings history is complete and `FR-TRST-03` has data to work with.
5. Withdrawals are therefore only ever against balance accrued from *online*
   orders, never against cash already in the rider's pocket.

For `paymentMethod = ONLINE`, Razorpay Route splits at the gateway and settles
to the shop's own account. Taking customer money into a platform account and
paying shops later would make the platform a payment intermediary, which in
India is the territory of RBI payment-aggregator authorisation. Route avoids
that entirely.

### Consequences

- The rider needs float to pay the shop. For small campus orders this is
  realistic, but it is a real constraint on who can ride and it belongs in the
  rider onboarding screen (`S-24`).
- The ledger needs to distinguish settled-in-cash entries from
  withdrawable balance. `WalletEntryType` carries the distinction and the
  withdrawal endpoint must only count online-settled credits.
- A cleaner long-term answer is online-only payment, which removes the float
  requirement and the reconciliation entirely. Worth revisiting before any real
  launch.
- This is the single largest functional hole in the SRS as written, and it
  should be raised with the project guide — a viva question about where the
  shop's money goes is close to certain.

---

## ADR-007 — Append-only tables are enforced by trigger

**Status:** accepted · Phase 1A

### Context

`FR-ADM-06` requires an append-only audit log. `FR-SVER-09` requires an
immutable audit entry per verification decision. `FR-PAY-02` requires the
wallet ledger to record every movement as an immutable entry.

"Immutable" asserted in a comment is not immutability. A bug, a migration
script, or a careless `prisma studio` session can all rewrite history.

### Decision

A trigger function, `hoppo_forbid_mutation()`, raises an exception on `UPDATE`
or `DELETE` against `audit_log` and `wallet_entry`, and on `DELETE` against
`broadcast_log`. A correction to the ledger is a new, opposite entry — which is
how double-entry bookkeeping has worked for six hundred years, and why a
tampered ledger is detectable.

This forced two referential actions to change: `wallet_entry.user_id`,
`withdrawal_request.user_id` and `audit_log.actor_id` are `ON DELETE RESTRICT`
rather than cascading. A cascade would attempt a delete the trigger refuses,
failing the user deletion with a confusing error.

### Consequences

- Account deletion (`FR-PRIV-05`) is **anonymisation**, not a row delete. That
  is what `FR-PRIV-05` requires anyway, since transaction records are retained
  for settlement and dispute resolution.
- Any genuine need to amend an audit entry requires a migration, which is the
  correct amount of friction.
- Tested: `UPDATE audit_log`, `DELETE FROM audit_log` and
  `UPDATE wallet_entry` all raise `restrict_violation`.

---

## ADR-008 — Shop-to-college is a join table, not a column

**Status:** accepted · Phase 1A

### Context

`FR-SHOP-13`: "A single shop may attach to more than one college where it lies
within the radius of each, but shall maintain a separate catalog and order
queue per college."

The `shop` table in SRS §9.1 has one `college_id` and one
`distance_from_college_m`. It can belong to exactly one college, so the
requirement is unimplementable against that schema.

### Decision

A `shop_listing` table represents a shop's presence at one college. The
distance, the approval decision, the opening hours, the catalog categories,
the catalog items and the orders all hang off the *listing*, not the shop —
because every one of those is specific to the pairing.

The `shop` table keeps only what is true of the merchant everywhere: name,
owner, address, coordinates, FSSAI licence, Razorpay account.

### Consequences

- `shop_listing` has `UNIQUE (shop_id, college_id)`, so a shop cannot be listed
  twice at one college.
- Queries gain a join. The composite index
  `(college_id, status, distance_from_college_m)` keeps the student-facing
  "open shops near me, sorted by distance" query cheap.
- An administrator approving a shop approves it *for their college only*, which
  is the correct tenancy behaviour and falls out of the model for free.


---

## ADR-009 — The handover code is pushed and re-issued, never retrieved

**Status:** accepted · Phase 1D

### Context

`FR-DLV-12` generates a six-digit handover code on pickup and displays it "to
the requester only". `NFR-S-04` requires OTP values to be stored hashed.

Those two pull against each other. If only a hash is stored, the code cannot
be looked up later — so a requester who closes the app, switches phones, or
simply misses the notification has no way to get it back, and the delivery
cannot complete. The first implementation stored the hash, generated the code,
and then did nothing with it at all: the rider was told to ask for a code that
had never reached anybody. Found by walking the flow, not by a failing test.

### Alternatives considered

1. **Store the plaintext.** Simplest, and the exposure window is minutes. But
   it puts a live credential in a database row and contradicts `NFR-S-04` for
   no real gain.
2. **Store it encrypted and decrypt on read.** Satisfies the letter of the
   requirement while keeping retrieval. Rejected: the decryption key lives
   next to the data, so it is plaintext with extra steps.
3. **Push only.** Correct until the requester misses the push, and then the
   delivery is stuck with no way out.
4. **Push, plus re-issue on request.** Chosen.

### Decision

The code is generated at pickup, hashed with Argon2id, and pushed to the
requester's socket — addressed to `user:<requesterId>`, never to the college
room, because a code broadcast to the college would let any rider complete any
delivery, which is the one thing the code exists to prevent.

The plaintext is never persisted. Recovery is **re-issue**, not retrieval: the
requester asks for a new code, which replaces the old one and resets the
attempt counter. The attempt reset matters — the rider's failed attempts were
against a code the requester no longer has, and carrying them over would
escalate the task for no reason.

The rider cannot re-issue. Only the requester can, which is checked explicitly.

### Consequences

- A lost code costs one extra tap, not a stranded delivery.
- Re-issue is rate limited, because it is a credential-minting endpoint.
- The GET endpoint deliberately has no `code` field and says so, so a client
  author does not go looking for one.
- Push delivery needs the socket connected. The app should fall back to
  re-issue when it reconnects and finds a task in `PICKED_UP`.
