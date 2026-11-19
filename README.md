# Hoppo

A college-scoped delivery and student networking platform. Verified students
order from registered shops near their campus, other students deliver those
orders between classes, and the whole thing is walled off per college — a
student at one college never sees another college's shops, riders, chats or
posts.

Built from the SRS in [`docs/srs/`](docs/srs/). Requirement identifiers
(`FR-DLV-04`, `NFR-S-02`, `C-2`) appear throughout the code; they point back to
that document so any line can be traced to the thing it implements.

---

## Status

| Phase | Scope | State |
|---|---|---|
| 1A | Monorepo, data model, integrity constraints, shared business rules | **done** |
| 1B | Auth, tenancy enforcement, student verification | next |
| 1C | Shop registration with radius validation, catalog | |
| 1D | Ordering, dispatcher, first-accept assignment, OTP handover | |
| 1E | Shop dashboard, admin console | |
| 1F | Student mobile app | |

Phase 1 as a whole is the "complete, demonstrable system" of SRS §12.2.
Phases 2 and 3 (chat, community board, ratings, analytics) come after.

---

## What is in here

```
hoppo/
├── apps/
│   ├── api/          NestJS monolith — REST + WebSocket, Prisma, the dispatcher
│   ├── dashboard/     Next.js shop dashboard (counter tablet)
│   ├── admin/         Next.js admin console
│   └── mobile/        Expo React Native student app
├── packages/
│   └── shared/        Types and business rules used by the API and every client
├── infra/             docker-compose for local Postgres, Redis, object storage
└── docs/              Architecture, decisions, and the SRS itself
```

A **monorepo** means every app lives in one Git repository and they share code
through `packages/`. The benefit here is concrete: the fee calculation, the
task state machine, and the money handling are written once in
`packages/shared` and imported by the server *and* the phone app, so the two
can never disagree about what a delivery costs or which state a task is in.

---

## Running it locally

You need [Node.js 22+](https://nodejs.org), [pnpm](https://pnpm.io), and Docker.

```bash
# 1. install dependencies for every app at once
pnpm install

# 2. copy the environment template and fill in what you have
cp .env.example .env

# 3. start Postgres, Redis and the object store
pnpm db:up

# 4. create the database tables
pnpm db:migrate

# 5. load the demo data
pnpm db:seed

# 6. run the API
pnpm dev:api
```

`pnpm db:studio` opens a browser UI over the database if you want to look
around. `pnpm test` runs every test in the repo.

### Demo accounts

After seeding, the password for all of these is `Hoppo@dev123`:

| Email | Who |
|---|---|
| `super@hoppo.app` | Super administrator — creates colleges, belongs to none |
| `admin@anurag.edu.in` | College administrator — verifies students and shops |
| `vivek@anurag.edu.in` | Verified student, places the order |
| `srichandana@anurag.edu.in` | Verified student, rides the task |
| `fresher@anurag.edu.in` | Unverified student, shows the locked-out state |

The seed also creates three shops: two inside the 3 km radius (92 m and 751 m
from campus, both approved) and one 16.6 km away that is rejected — so the
radius rule is visible without having to set it up by hand.

---

## The parts that matter

Four things in this system are harder than they look. Each is documented where
it lives, and each has a decision record in [`docs/decisions.md`](docs/decisions.md).

### 1. Two riders tapping "Accept" at the same moment

If two riders accept one task 40 milliseconds apart and the code does
"check whether anyone has it, then write myself in", both checks pass before
either write lands and two riders drive to the same shop. This is called a
**race condition**: the outcome depends on which request happens to run first.

The fix is a single SQL statement that checks and writes at the same time:

```sql
UPDATE task
SET rider_id = $1, status = 'ASSIGNED', assigned_at = now()
WHERE id = $2 AND rider_id IS NULL;
```

The database reports how many rows it changed. One means you won the task.
Zero means somebody else got there first, and the API returns "already taken".
There is no gap for a second rider to slip through, because the database
guarantees that one statement is indivisible.

Nothing in this codebase may read-then-write a task assignment, and nothing
may use a Redis lock as the source of truth. See `ADR-001`.

### 2. Distance has to be measured on a curved earth

A shop may register only if it is inside the college's radius (3 km by
default). Measuring that with flat-map arithmetic on latitude and longitude is
wrong by enough to admit or reject a shop incorrectly at that threshold.

So the measurement is done by **PostGIS**, a PostgreSQL add-on that
understands geography, through one SQL function:

```sql
SELECT hoppo_geodesic_distance_m(17.3045, 78.6188, 17.3051, 78.6194);
-- 92 metres
```

"Geodesic" means measured over the curved surface of the earth. The function
is the single authority for constraint `C-2`; a sanity check that it is right
is that `hoppo_geodesic_distance_m(0, 0, 0, 1)` returns 111,319.5 m, the known
length of one degree of longitude at the equator.

`packages/shared/src/geo.ts` has a faster approximate version for *displaying*
"1.2 km away" in a list. It must never decide a registration. See `ADR-002`.

### 3. The dispatcher needs a clock, not a button

An order is broadcast to riders when its remaining preparation time drops
below a threshold, so the rider arrives as the food comes out rather than
standing at the counter for ten minutes (`FR-DLV-01`). Nobody taps a button
seven minutes into cooking — so something has to wake up on a timer and look.

Three separate timers exist for this reason: tasks becoming due to broadcast,
acceptance windows expiring, and work mode going idle after two hours. They
run as scheduled jobs in the API. The SRS implies this in its indexing notes
but never states it as a requirement; `docs/srs-resolutions.md` records the
gap. See `ADR-005`.

### 4. Money is never a decimal

Every amount is an integer number of paise. `₹120.50` is stored, passed and
compared as `12050`.

Computers cannot represent `0.1` exactly in binary, the same way you cannot
write `1/3` exactly in decimal. Add `0.1` to itself ten times in JavaScript and
you get `0.9999999999999999`. Do that to money and the books stop balancing.
Integers have no such problem. The conversion to rupees happens once, at the
edge, purely for display — `packages/shared/src/money.ts`.

---

## Where the SRS and this code disagree

The SRS contains a few internal contradictions and gaps. Rather than pick
silently, each one is written down with the reasoning in
**[`docs/srs-resolutions.md`](docs/srs-resolutions.md)**. The significant ones:

- `FR-SHOP-13` lets a shop serve several colleges with a separate catalog
  each, but the proposed `shop` table could only belong to one. Resolved with
  a `shop_listing` join table.
- `FR-SHP-06` and `FR-DLV-11` both claim to own the pickup transition.
  Resolved: the shop unlocks, only the rider writes.
- Appendix A gives `UNFULFILLED` no way out, but `FR-DLV-07` offers the
  requester three choices from there. All three are now legal transitions.
- `FR-COMM-04` counts upvotes with nothing recording who voted, so a student
  could upvote forever. Resolved with a `post_vote` table.
- `§12.3` expects Phase 1 to end with a wallet credit, but `§12.2` puts the
  wallet in Phase 2. The minimal ledger ships in Phase 1.
- Cash-on-delivery had no settlement path to the shop at all. Resolved and
  documented in `ADR-006`.

---

## Identity documents

The SRS asks for a government identity document and raises the Aadhaar
question itself in §11. This codebase takes the safer path §11 recommends, and
it is enforced by the database, not by convention:

- Identity is established by **college ID card + verified mobile number**,
  plus an institutional email where the college has a domain. That is
  sufficient to prove somebody belongs to the college, which is the actual
  requirement.
- Where a second document is wanted for riders handling cash, any of a driving
  licence, voter ID or passport is accepted, and **only the document type, the
  last four characters, and the verification decision are stored**. A check
  constraint caps that column at four characters, so a careless insert cannot
  turn it into a store of full ID numbers.
- Full numbers and document images are never persisted. Where a college
  mandates Aadhaar, `FR-ID-03` applies: masked image only, deleted within 24
  hours of the decision, with consent recorded — and a constraint refuses to
  store such an image without an expiry timestamp.

Storing a database of Aadhaar images would be a high-value target held without
a legal basis, and the Digital Personal Data Protection Act's duties apply
regardless. This is not legal advice; it is the conservative design.

---

## Conventions

- **Requirement traceability.** Code that implements a requirement names it in
  a comment. Appendix C of the SRS asks for this and it makes review far
  easier.
- **Rules live in the database when they must never be broken.** Check
  constraints, triggers and foreign keys, not just validation in TypeScript.
  Application code is one bug away from breaking an invariant; a constraint is
  not. `apps/api/prisma/migrations/*_integrity_constraints/` is worth reading.
- **Configuration, not constants.** Fees, radii, timeouts and thresholds live
  in the `college_config` table so a college can be retuned without a
  deployment (`NFR-M-01`).
- **snake_case in the database, camelCase in TypeScript.** Each side gets the
  convention it expects; Prisma's `@map` bridges them.

## Licence

Private. All rights reserved.
