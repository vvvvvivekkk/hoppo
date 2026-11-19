# SRS resolutions

The SRS contains internal contradictions, gaps, and one technical error. This
file records every one found, what was decided, and why — so that nothing was
resolved silently and a reviewer can check the reasoning.

Nothing here is a criticism of the document, which is unusually thorough.
These are the things that only surface when you try to build it.

**Legend:** 🔴 blocks implementation · 🟡 needs a decision · 🟢 minor

---

## 🔴 R-01 — `FR-SHOP-13` cannot be implemented against the §9.1 `shop` table

**The conflict.** `FR-SHOP-13` allows one shop to serve several colleges with a
separate catalog and order queue per college. The `shop` table in §9.1 has a
single `college_id` and a single `distance_from_college_m`, so it can belong to
exactly one.

**Resolution.** Added a `shop_listing` table keyed on `(shop_id, college_id)`.
Distance, approval status, opening hours, catalog and orders all belong to the
listing. See `ADR-008`.

**Affects** §9.1, §9.2, `FR-SHOP-05`, `FR-SHOP-10`..`FR-SHOP-13`, `FR-CAT-*`.

---

## 🔴 R-02 — §9.3's "geospatial index" would not perform a geospatial search

**The error.** §9.3 asks for "a geospatial index on
`rider_state(last_lat, last_lng)` to support proximity selection at
broadcast". A composite B-tree index on two numeric columns cannot answer
"riders within 500 m of this point". It can only answer "riders whose latitude
is between X and Y and longitude between P and Q" — a bounding box, not a
circle — and it degrades as the table grows.

**Resolution.** Proximity selection at broadcast does not use Postgres at all.
Online riders live in a Redis GEO set per college, refreshed on each ping, and
`GEOSEARCH` answers the query in sub-millisecond time. `rider_state` keeps the
last known position for audit and the admin console only.

The one place a true geodesic distance is needed — shop registration — uses a
PostGIS function. See `ADR-002`.

**Affects** §9.3, `FR-DLV-02`, `FR-WM-03`, `NFR-P-02`.

---

## 🔴 R-03 — No requirement creates the dispatcher

**The gap.** `FR-DLV-01` broadcasts when an order's remaining preparation time
falls below a lead threshold. `FR-DLV-06` re-broadcasts when the acceptance
window expires. `FR-WM-06` disables work mode after two hours idle. None of
these is triggered by a user action, and no requirement creates a scheduled
process to perform them. §9.3 mentions "the dispatcher poll" in passing, which
is the only acknowledgement in the document that one exists.

Without it, Phase 1 does not function: orders are created and never broadcast.

**Resolution.** Implemented as scheduled jobs in the API with partial indexes
to keep the scans cheap. See `ADR-005`.

**Proposed requirement to add to the SRS:**

> **FR-DLV-00.** The system shall run a scheduled dispatcher process that, at
> a configurable interval, (a) broadcasts tasks whose dispatch lead time has
> been reached, (b) re-broadcasts or retires tasks whose acceptance window has
> expired, and (c) disables work mode for riders exceeding the configured
> inactivity timeout. The process shall be safe to run concurrently on
> multiple application instances.

**Affects** `FR-DLV-01`, `FR-DLV-06`, `FR-WM-06`, `FR-SHP-02`, §9.3.

---

## 🔴 R-04 — Cash-on-delivery has no settlement path to the shop

**The gap.** `FR-PAY-01` makes cash the default. `FR-DLV-15` credits the
delivery fee to the rider's wallet. Nothing settles the item subtotal with the
shop. The rider physically holds the cash, the platform owes the shop money it
never received, and the rider holds both cash and a wallet claim.

**Resolution.** The rider pays the shop at pickup and keeps the fee as cash;
the wallet entry for a cash order is a statement line, not a withdrawable
claim. Online orders split at the payment gateway. See `ADR-006`.

This is the largest functional hole in the document and is worth raising
with the project guide — "where does the shop's money go?" is an obvious
examiner question.

**Affects** `FR-PAY-01`..`FR-PAY-06`, `FR-DLV-15`, `FR-SHP-06`.

---

## 🟡 R-05 — `FR-SHP-06` and `FR-DLV-11` both own the pickup transition

**The conflict.** The shop "shall confirm handover to the rider, moving the
order to `PICKED_UP`" and the rider "shall mark `PICKED_UP`". Two actors, one
transition, across two tables that both carry pickup state.

**Resolution.** The shop's confirmation unlocks the rider's button; only the
rider's tap writes `picked_up_at`, to both rows in one transaction. See
`ADR-003`.

---

## 🟡 R-06 — Appendix A gives `UNFULFILLED` no exit, but `FR-DLV-07` gives it three

**The conflict.** The state table has `BROADCASTING → UNFULFILLED` when all
rounds are exhausted and nothing after it. `FR-DLV-07` then offers the
requester a choice to continue waiting, to collect in person, or to cancel
with a full refund — three transitions out of a state the table treats as
terminal.

**Resolution.** All three are legal transitions in
`packages/shared/src/task-state.ts`:

| From | Event | To |
|---|---|---|
| `UNFULFILLED` | requester keeps waiting | `BROADCASTING` (rounds reset) |
| `UNFULFILLED` | collected in person | `COMPLETED` (no fee due) |
| `UNFULFILLED` | requester cancels | `CANCELLED` (full refund) |

Also added: `ASSIGNED → CANCELLED` by administrator, because a task can go
wrong after a rider has it and somebody must be able to close it.

---

## 🟡 R-07 — `FR-DLV-06` raises the fee after `FR-ORD-03` quoted a total

**The gap.** The student is shown and agrees to a total. The fee then rises on
re-broadcast. The document never says who pays the difference.

**Resolution.** The platform absorbs it. `base_fee_minor` is charged,
`fee_minor` is offered, the gap is recorded as a platform subsidy. See
`ADR-004`.

---

## 🟡 R-08 — `FR-DLV-08` abandonment leaves the round and fee undefined

**The gap.** An abandoned task "shall return to broadcast". At which round,
and at what fee? If it returns at round 3 of 3, the next expiry retires it
immediately even though it was never genuinely offered three times.

**Resolution.** Abandonment resets `broadcast_round` to 0 and the fee to
`base_fee_minor`, and the abandoning rider is excluded from the next
broadcast. The abandonment is still counted against that rider's reliability
metric (`FR-TRST-03`) and towards the automatic work-mode bar
(`FR-TRST-05`).

Rationale: a task returning to the pool is a fresh search, and punishing the
*task* for a rider's abandonment is the wrong party.

---

## 🟡 R-09 — §12.3 requires in Phase 1 what §12.2 schedules for Phase 2

**The conflict.** The Phase 1 acceptance test ends with the tester seeing
"the fee reflected in the rider's wallet". §12.2 puts "wallet ledger and
withdrawal requests" in Phase 2. Phase 1 cannot pass its own acceptance test.

**Resolution.** The minimal wallet ledger — the `wallet_entry` table and the
credit written on task completion — ships in Phase 1, because `NFR-R-03`
requires the ledger entry to be written in the same transaction as completion
anyway. Withdrawal requests, statements and filtering remain Phase 2.

---

## 🟡 R-10 — `FR-COMM-04` upvotes cannot be deduplicated

**The gap.** Posts carry an upvote count and nothing records who voted, so one
student could upvote the same post indefinitely.

**Resolution.** Added `post_vote (post_id, user_id)` with the pair as the
primary key, which makes a second vote from the same student a constraint
violation rather than a counter increment. `post.upvote_count` remains as a
denormalised counter, updated in the same transaction as the vote insert.

---

## 🟡 R-11 — `FR-TRST-06` anonymity is undermined by the data it also requires

**The conflict.** Ratings "shall not be visible to the rated party as
individually attributable; only aggregates shall be shown". But `FR-TRST-01`
allows a free-text comment, and §9.1's `rating` table carries `rater_id` and
`task_id`. A rider who completed four deliveries today and sees one 2-star
knows exactly who left it. A comment makes it certain.

**Resolution.** Storage keeps `rater_id` and `task_id` — they are needed for
dispute resolution and abuse detection, and removing them would be worse. The
rule is enforced at the API layer instead:

- A rated party sees aggregates only, never individual scores or comments.
- Aggregates are suppressed entirely below `MIN_RATINGS_BEFORE_DISPLAY`
  (currently 5), so a small number of ratings cannot be differenced to
  identify a rater.
- Comments are visible to administrators for dispute handling, never to the
  rated party.

**Affects** `FR-TRST-01`, `FR-TRST-02`, `FR-TRST-06`, §9.1.

---

## 🟡 R-12 — `FR-CHAT-03` per-message state cannot come from a read pointer

**The conflict.** The system "shall display per-message delivery state as
sent, delivered, and read". §9.1's `chat_member.last_read_message_id` is a
single read-up-to pointer, which answers "how many unread" but cannot express
"this specific message was delivered but not yet read" in a group room.

**Resolution.** Added `message_receipt (message_id, user_id)` carrying
`delivered_at` and `read_at`. The read pointer stays, because it answers the
unread-count question far more cheaply than scanning receipts. Phase 2
implements both.

---

## 🟢 R-13 — `user.college_id` cannot be mandatory

**The gap.** `FR-TEN-02` requires every student, shop, order, task, chat room
and post to belong to exactly one college. But `U5`, the super administrator,
creates college tenants and so belongs to none.

**Resolution.** `user.college_id` is nullable, with a check constraint —
`user_college_required_unless_super_admin` — requiring it for every role
except `SUPER_ADMIN`. The requirement holds for every entity it actually names;
super administrators are simply not among them.

---

## 🟢 R-14 — `FR-ORD-05` and Appendix A disagree at the margin

**The conflict.** The student may cancel at `SHOP_ACCEPTED`. Appendix A allows
`CANCELLED` only from `CREATED` and `BROADCASTING`. These happen not to
collide today, because broadcast begins during `PREPARING` and cancellation is
barred from `PREPARING` onwards — but the two documents describe different
rules and a timing change would break it.

**Resolution.** The order and task state machines are explicitly separate
(`ADR-003`). Student cancellation is defined on the *order* machine
(`isStudentCancellable`), and cancelling an order cancels its task through the
task machine's own legal transitions.

---

## 🟢 R-15 — Non-shop tasks have no cancellation rule at all

**The gap.** `FR-ORD-05` covers cancelling a shop order. `FR-ORD-07` and
`FR-ORD-08` create parcel pickups and peer errands with no stated
cancellation policy.

**Resolution.** The requester may cancel a `PARCEL_PICKUP` or `PEER_ERRAND`
free of charge while the task is `CREATED` or `BROADCASTING`, and not once a
rider has accepted — the same boundary as a shop order, drawn at the point
where somebody else has started doing work.

---

## 🟢 R-16 — `FR-DLV-12` assumes the requester is the recipient

**The gap.** The handover code is generated on pickup and "displayed to the
requester only". For a `PARCEL_PICKUP`, the person at the drop point may not
be the requester.

**Resolution.** For Phase 1 the requester is treated as the recipient and
relays the code, which is adequate for campus use. A `recipient_contact` field
on parcel tasks is noted as Phase 3 work when parcel pickup actually ships.

---

## 🟢 R-17 — §9.1's `task.otp_hash` is right, but §9.1's naming is inconsistent

**Observation, not a conflict.** The data model correctly names the column
`otp_hash`, matching `NFR-S-04`'s requirement that OTP values be stored
hashed. Worth noting only because several prose sections say "generate a
six-digit OTP and display it", which reads as though the value is stored.

**Resolution.** The plaintext code is shown to the requester once and never
persisted; only an Argon2id hash is stored, with an attempt counter and an
issue timestamp.

---

## Summary

| Id | Severity | Resolved in |
|---|---|---|
| R-01 shop multi-college | 🔴 | `shop_listing` table, `ADR-008` |
| R-02 geospatial index | 🔴 | Redis GEO + PostGIS function, `ADR-002` |
| R-03 missing dispatcher | 🔴 | Scheduled jobs, `ADR-005`, new `FR-DLV-00` |
| R-04 cash settlement | 🔴 | `ADR-006` |
| R-05 pickup ownership | 🟡 | `ADR-003` |
| R-06 `UNFULFILLED` exits | 🟡 | `task-state.ts` |
| R-07 fee increment | 🟡 | `ADR-004` |
| R-08 abandonment round | 🟡 | Reset to round 0 |
| R-09 phase conflict | 🟡 | Minimal ledger in Phase 1 |
| R-10 upvote dedupe | 🟡 | `post_vote` table |
| R-11 rating anonymity | 🟡 | API-layer suppression + floor |
| R-12 message receipts | 🟡 | `message_receipt` table |
| R-13 super admin tenancy | 🟢 | Nullable + check constraint |
| R-14 cancel boundary | 🟢 | Separate state machines |
| R-15 non-shop cancellation | 🟢 | Same boundary as shop orders |
| R-16 parcel recipient | 🟢 | Deferred to Phase 3 |
| R-17 OTP storage | 🟢 | Hashed, documented |
