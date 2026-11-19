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

## `race-stress.py`

The FR-DLV-04 assignment race, which the SRS warns is where projects like this
break during a demo.

```bash
python3 apps/api/test/race-stress.py
```

Each round puts one task into `BROADCASTING`, frees every rider, then fires
five genuinely concurrent accepts from five different riders through the real
HTTP endpoint. Concurrency comes from a thread barrier, so all five requests
leave at the same instant rather than in sequence — a sequential test would
pass against a read-then-write implementation and prove nothing.

Each round asserts:

- exactly one HTTP 200, and four `ALREADY_TAKEN`
- `task.rider_id` matches the rider who got the 200
- exactly one `rider_state` row holds the task
- the task is `ASSIGNED`
- exactly one task chat room was created

Needs the five `rider-race-*` accounts from the seed to be verified with rider
terms accepted. Thirty rounds takes about a minute.
