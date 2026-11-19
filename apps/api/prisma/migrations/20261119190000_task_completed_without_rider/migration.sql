-- The Phase 1A constraint assumed that a COMPLETED task always has a rider.
-- FR-DLV-07 contradicts that: when no rider is found after every broadcast
-- round, the requester may collect the order in person, and the task then
-- completes having never been assigned to anybody.
--
-- The original constraint rejected that with
-- "task_rider_presence_matches_status", so the collect-in-person path failed
-- with a 500 — found by exercising FR-DLV-07 rather than by reading.
--
-- The fix keeps the invariant that matters instead of just loosening it. The
-- real rule is not "completed implies a rider" but "a task that was ever
-- ASSIGNED keeps its rider". A collected-in-person task has assigned_at NULL,
-- so it is distinguishable from a delivered task that has somehow lost its
-- rider_id — which is the bug the constraint exists to catch.
--
-- See docs/srs-resolutions.md R-19.

ALTER TABLE "task" DROP CONSTRAINT IF EXISTS task_rider_presence_matches_status;

ALTER TABLE "task"
  ADD CONSTRAINT task_rider_presence_matches_status
  CHECK (
    -- Not yet offered to anyone, or offered and not taken.
    (status IN ('CREATED', 'BROADCASTING', 'UNFULFILLED') AND rider_id IS NULL)

    -- Somebody is carrying it, or carried it. These cannot lose their rider.
    OR (status IN ('ASSIGNED', 'PICKED_UP', 'DELIVERED', 'ESCALATED') AND rider_id IS NOT NULL)

    -- FR-DLV-07: completed either by a rider, or by the requester collecting
    -- it themselves — in which case it was never assigned.
    OR (status = 'COMPLETED' AND (rider_id IS NOT NULL OR assigned_at IS NULL))

    -- Cancellation can happen at any point in the lifecycle.
    OR status = 'CANCELLED'
  );
