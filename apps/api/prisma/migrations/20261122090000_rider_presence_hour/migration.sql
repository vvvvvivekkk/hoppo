-- FR-ADM-05, "active riders by hour": somewhere to remember that a rider was
-- online in a given clock hour.
--
-- Until now nothing stored it. rider_state holds one row per rider with the
-- CURRENT work-mode flag and last ping, each overwritten; Redis holds live
-- positions that expire. An hour later there was no record the rider had been
-- online at all — and it cannot be rebuilt from tasks, because a rider who was
-- online for three hours and was offered nothing leaves no task behind.
--
-- One row per rider per hour, written once and never updated. Purely
-- additive: a new table and its foreign keys; no existing table changes.
-- Mirrored in schema.prisma as RiderPresenceHour — the statements below are
-- what `prisma migrate diff` emits for that model, plus one CHECK at the end.
--
-- No backfill: hours before this table existed are unknown, and the report
-- should show them as "no data" rather than as zero riders.

CREATE TABLE "rider_presence_hour" (
    "college_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "hour_start" TIMESTAMP(3) NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- The key is the whole design. "Rider X was online in hour H" can be
    -- inserted any number of times, by any number of API instances, and
    -- INSERT ... ON CONFLICT DO NOTHING leaves exactly one row. Nobody is
    -- counted twice, with no read-then-write and no lock.
    CONSTRAINT "rider_presence_hour_pkey" PRIMARY KEY ("user_id","hour_start")
);

-- The dashboard asks "for this college, between these hours, how many riders
-- in each hour": one range scan of this index.
CREATE INDEX "rider_presence_hour_college_id_hour_start_idx"
  ON "rider_presence_hour"("college_id", "hour_start");

ALTER TABLE "rider_presence_hour"
  ADD CONSTRAINT "rider_presence_hour_college_id_fkey"
  FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A record of when a person was working is personal data (FR-PRIV-05):
-- deleting the account deletes it.
ALTER TABLE "rider_presence_hour"
  ADD CONSTRAINT "rider_presence_hour_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw SQL only (Prisma has no CHECK): hour_start must be exactly on the hour.
-- The primary key only de-duplicates if every writer rounds the same way; a
-- writer that stored 10:00:00.250 would create a second row for the same hour
-- and the rider would be counted twice. This turns that bug into a failed
-- INSERT. The column is UTC with no zone, so date_trunc is exact.
ALTER TABLE "rider_presence_hour"
  ADD CONSTRAINT rider_presence_hour_on_the_hour
  CHECK (hour_start = date_trunc('hour', hour_start));
