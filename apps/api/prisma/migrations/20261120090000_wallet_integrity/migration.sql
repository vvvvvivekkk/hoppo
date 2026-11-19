-- Wallet ledger integrity rules that Prisma's schema language cannot express.
--
-- Like 20261119170100_integrity_constraints, everything here is a partial
-- index or a CHECK constraint. Nothing adds or alters a column, so the
-- datamodel is unchanged. A partial index is one that covers only the rows
-- matching its WHERE clause; a partial UNIQUE index therefore says "among
-- these rows, no two may share this key" and leaves every other row alone.
--
-- Why these belong in the database: the application now decides each refund
-- and each hold with a conditional UPDATE and a per-wallet lock, but that is
-- three services' worth of code agreeing to do the right thing. These rules
-- hold even when one of them forgets — a second refund becomes a failed
-- INSERT and a rolled-back transaction instead of money created from nothing.
--
-- The ledger is append-only (trigger wallet_entry_is_append_only), so this
-- migration only adds rules; it does not, and could not, repair existing rows.
-- The two unique indexes WILL FAIL to build if the table already holds the
-- duplicates they forbid. That is deliberate: such rows are evidence of the
-- double-refund bug and need a compensating ADJUSTMENT entry and a human
-- decision, not a silent workaround. Check first with:
--
--   SELECT order_id, type, count(*) FROM wallet_entry
--   WHERE type IN ('ORDER_HOLD', 'ORDER_RELEASE') AND order_id IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
--   SELECT task_id, count(*) FROM wallet_entry
--   WHERE type = 'DELIVERY_FEE_EARNED' AND task_id IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;

-- ===========================================================================
-- 1. One hold and one release per order (FR-PAY-06, FR-SHP-04)
-- ===========================================================================

-- An order's wallet amount is held once, at placement, and released at most
-- once: in full on cancellation, or the delivery fee alone when the student
-- collects in person (FR-DLV-07). Those two outcomes are mutually exclusive
-- because each ends the order, so "at most one ORDER_RELEASE per order" is
-- exact rather than approximate.
--
-- ORDER_CAPTURE is left out on purpose: it is a zero-amount marker and a
-- duplicate of it moves no money.
CREATE UNIQUE INDEX wallet_entry_one_hold_release_per_order
  ON "wallet_entry" (order_id, type)
  WHERE type IN ('ORDER_HOLD', 'ORDER_RELEASE');

-- ===========================================================================
-- 2. One delivery fee per task (FR-DLV-15)
-- ===========================================================================

-- A task is completed once, so its rider is paid once. A retried or doubled
-- completion request must not credit the fee a second time.
CREATE UNIQUE INDEX wallet_entry_one_delivery_fee_per_task
  ON "wallet_entry" (task_id, type)
  WHERE type = 'DELIVERY_FEE_EARNED';

-- ===========================================================================
-- 3. A wallet is never overdrawn (FR-PAY-07)
-- ===========================================================================

-- There is no credit facility: a hold or a withdrawal larger than the balance
-- must be refused, not recorded as a negative balance.
--
-- NOT VALID means "enforce on every row written from now on, but do not scan
-- the rows already there". It is used because the table is append-only: if a
-- past double-spend left a negative balance on some row, that row can never
-- be edited, so a fully validating constraint could never be added at all.
-- New entries are checked exactly as strictly either way. To see whether any
-- historical row breaks the rule:
--
--   SELECT id, user_id, balance_after_minor FROM wallet_entry
--   WHERE balance_after_minor < 0;
--
-- If that returns nothing, the constraint can be promoted later with
--   ALTER TABLE "wallet_entry" VALIDATE CONSTRAINT wallet_entry_balance_non_negative;
ALTER TABLE "wallet_entry"
  ADD CONSTRAINT wallet_entry_balance_non_negative
  CHECK (balance_after_minor >= 0) NOT VALID;

-- ===========================================================================
-- 4. An unambiguous "latest entry" (FR-PAY-02)
-- ===========================================================================

-- The balance of a wallet is the balance_after_minor of its latest entry, so
-- "latest" must have exactly one answer. created_at stores milliseconds, and
-- two entries for one user can share a millisecond — at which point ORDER BY
-- created_at DESC may return either, and the next entry is computed from the
-- wrong balance.
--
-- seq is a counter the database increments itself on every insert (BIGSERIAL
-- is shorthand for "a BIGINT column fed by a sequence"). Every writer holds
-- the per-user wallet lock while it inserts, so for any one user a higher seq
-- always means a later entry. It is the tie-break for reading the head of the
-- ledger: ORDER BY created_at DESC, seq DESC.
--
-- This is the one statement in this file that adds a column, so unlike the
-- rest it IS mirrored in schema.prisma (WalletEntry.seq). The two statements
-- are exactly what `prisma migrate diff` emits for that field, so the
-- datamodel and the database agree and no drift is reported.
--
-- Adding a column rewrites the table but is not an UPDATE in the trigger's
-- sense, so wallet_entry_is_append_only does not fire. Existing rows are
-- numbered in whatever order the table is stored in, which is why this
-- assumes the ledger is empty or freshly reset when it is applied.
ALTER TABLE "wallet_entry" ADD COLUMN "seq" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "wallet_entry_seq_key" ON "wallet_entry"("seq");
