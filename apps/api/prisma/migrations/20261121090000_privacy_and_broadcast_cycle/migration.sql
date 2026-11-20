-- Two additions, both purely additive: new columns, every one of them either
-- nullable or carrying a default. No existing column, index or constraint is
-- altered or dropped, so code written before this migration keeps working
-- against a database that has it.
--
-- Unlike the two integrity migrations, everything here IS mirrored in
-- schema.prisma (User.privacyNoticeVersion, User.privacyNoticeAcceptedAt,
-- Task.broadcastCycle, BroadcastLog.cycle). The three ALTER TABLE statements
-- are what `prisma migrate diff` emits for those fields.

-- ===========================================================================
-- 1. Privacy-notice acceptance on the account (FR-PRIV-01)
-- ===========================================================================

-- FR-PRIV-01 has the notice presented at registration; proving that needs,
-- per account, which version was accepted and when. Until now that lived only
-- as an audit_log row (action PRIVACY_NOTICE_ACCEPTED). The audit row stays —
-- it is the immutable record — but "which accounts have not accepted version
-- X" should not need a scan of JSON in an append-only table.
--
-- Both nullable with no default: an account that predates the notice has
-- genuinely accepted nothing, and NULL says so. TIMESTAMP(3), not
-- timestamptz, to match every other time column in this schema (all UTC,
-- millisecond precision); one column of a different type would make
-- comparisons between them subtly wrong.
ALTER TABLE "user"
  ADD COLUMN "privacy_notice_accepted_at" TIMESTAMP(3),
  ADD COLUMN "privacy_notice_version" TEXT;

-- Carry over what the audit log already knows: for each account, its most
-- recent acceptance. DISTINCT ON (target_id) ... ORDER BY created_at DESC
-- keeps one row per account, the latest. This UPDATE touches "user", which is
-- an ordinary table; audit_log is only read (it is append-only by trigger).
-- On a database with no such audit rows it changes nothing.
UPDATE "user" u
SET privacy_notice_version = a.detail->>'version',
    privacy_notice_accepted_at = a.created_at
FROM (
  SELECT DISTINCT ON (target_id) target_id, detail, created_at
  FROM "audit_log"
  WHERE action = 'PRIVACY_NOTICE_ACCEPTED' AND target_type = 'user'
  ORDER BY target_id, created_at DESC
) a
WHERE u.id = a.target_id
  AND a.detail->>'version' IS NOT NULL;

-- ===========================================================================
-- 2. A search counter for broadcast history (FR-DLV-09, FR-ADM-05)
-- ===========================================================================

-- A task goes back into the pool after an abandonment, a rider's suspension,
-- or the requester choosing "keep waiting", and its rounds restart at 1. The
-- second search's round 1 then collides with the first search's round-1 row
-- in broadcast_log (unique on task_id, round) and overwrites it, so the
-- record of the first search — who accepted, how long it took — is lost.
--
-- These two columns number the searches. Every existing task and row is
-- cycle 1, which is what the default gives them.
--
-- DELIBERATELY NOT DONE HERE: replacing the unique key (task_id, round) with
-- (task_id, cycle, round). That is the change that actually stops the
-- overwrite, but it is not additive — it renames the key the dispatcher's
-- upsert is written against, so it has to land in the same change set as the
-- dispatch code that increments the cycle. Until then these columns sit at 1
-- and nothing reads them.
ALTER TABLE "task" ADD COLUMN "broadcast_cycle" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "broadcast_log" ADD COLUMN "cycle" INTEGER NOT NULL DEFAULT 1;
