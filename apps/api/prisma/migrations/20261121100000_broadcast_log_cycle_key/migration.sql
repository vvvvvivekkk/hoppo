-- broadcast_log: one row per round of each SEARCH, not per round of each task.
--
-- A task goes back into the pool after an abandonment, a rider's suspension,
-- or the requester choosing "keep waiting", and its rounds restart at 1. With
-- the key on (task_id, round), the new search's round 1 collided with the
-- finished search's round-1 row. It could not be inserted (unique) and the
-- old row could not be deleted (append-only trigger), so the dispatcher
-- re-opened the old row: outcome EXPIRED back to PENDING, sent_at replaced.
-- The record of the first search was overwritten, and FR-DLV-09 / FR-ADM-05
-- ("how long to find a rider", "how often do we fail") described only a
-- task's latest search.
--
-- Migration 20261121090000 added the search counter: task.broadcast_cycle and
-- broadcast_log.cycle, both defaulting to 1. This migration puts `cycle` into
-- the key, which is the change that actually lets a second search write its
-- own rows.
--
-- Existing data: every row has cycle = 1, and (task_id, round) was already
-- unique, so (task_id, 1, round) is unique too. The new index cannot fail on
-- rows that satisfied the old one. Nothing is updated or deleted.
--
-- The new index is created before the old one is dropped, so there is no
-- moment at which the table has neither. The two statements are otherwise
-- exactly what `prisma migrate diff` emits for the datamodel change
-- (@@unique([taskId, round]) -> @@unique([taskId, cycle, round])), index
-- names included, so the datamodel and the database agree.
--
-- For application code: the Prisma compound key is now `taskId_cycle_round`
-- (it was `taskId_round`). A write that leaves `cycle` out gets 1.
CREATE UNIQUE INDEX "broadcast_log_task_id_cycle_round_key"
  ON "broadcast_log"("task_id", "cycle", "round");

DROP INDEX "broadcast_log_task_id_round_key";
