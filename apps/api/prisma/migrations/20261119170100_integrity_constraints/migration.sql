-- Integrity rules that Prisma's schema language cannot express.
--
-- Everything here is a CHECK constraint, a trigger, or a function. None of it
-- adds or alters a column, so `prisma migrate dev` sees no drift against the
-- datamodel and this migration survives future schema changes untouched.
--
-- The principle: a rule that must never be violated belongs in the database.
-- Application code is one bug away from breaking an invariant; a constraint is
-- not. Every rule below is one the SRS states as "shall".

-- ===========================================================================
-- 1. Tenancy (C-1, FR-TEN-02)
-- ===========================================================================

-- Every user except a super administrator belongs to exactly one college.
-- U5 in the SRS creates tenants, so it sits outside all of them.
ALTER TABLE "user"
  ADD CONSTRAINT user_college_required_unless_super_admin
  CHECK (role = 'SUPER_ADMIN' OR college_id IS NOT NULL);

-- ===========================================================================
-- 2. Money (FR-PAY-07)
-- ===========================================================================

-- Amounts are integer minor units and are never negative. Direction is
-- carried by the `direction` column, not by the sign of the amount — a
-- signed-amount ledger invites double-negative bugs.
ALTER TABLE "wallet_entry"
  ADD CONSTRAINT wallet_entry_amount_non_negative CHECK (amount_minor >= 0);

ALTER TABLE "withdrawal_request"
  ADD CONSTRAINT withdrawal_amount_positive CHECK (amount_minor > 0);

ALTER TABLE "catalog_item"
  ADD CONSTRAINT catalog_item_price_non_negative CHECK (price_minor >= 0);

ALTER TABLE "fee_band"
  ADD CONSTRAINT fee_band_fee_non_negative CHECK (fee_minor >= 0);

ALTER TABLE "fee_band"
  ADD CONSTRAINT fee_band_range_ordered
  CHECK (max_distance_m IS NULL OR max_distance_m > min_distance_m);

ALTER TABLE "order"
  ADD CONSTRAINT order_amounts_non_negative
  CHECK (
    items_subtotal_minor >= 0
    AND delivery_fee_minor >= 0
    AND platform_fee_minor >= 0
    AND total_minor >= 0
    AND commission_minor >= 0
  );

-- The total a student is shown must equal the parts they were shown
-- (FR-ORD-03). Commission is retained from the shop's share and is
-- deliberately not part of this sum.
ALTER TABLE "order"
  ADD CONSTRAINT order_total_is_sum_of_parts
  CHECK (total_minor = items_subtotal_minor + delivery_fee_minor + platform_fee_minor);

ALTER TABLE "order_item"
  ADD CONSTRAINT order_item_quantity_positive CHECK (quantity > 0);

ALTER TABLE "order_item"
  ADD CONSTRAINT order_item_line_total_consistent
  CHECK (line_total_minor = unit_price_minor * quantity);

-- A task's offered fee may exceed the requester's quote when a re-broadcast
-- raises it (FR-DLV-06); the platform absorbs the difference (ADR-004). It
-- may never be *less* than the base.
ALTER TABLE "task"
  ADD CONSTRAINT task_fee_not_below_base
  CHECK (fee_minor >= base_fee_minor AND base_fee_minor >= 0);

-- ===========================================================================
-- 3. Geography and radius (C-2, FR-TEN-04)
-- ===========================================================================

ALTER TABLE "college"
  ADD CONSTRAINT college_coordinates_valid
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

ALTER TABLE "shop"
  ADD CONSTRAINT shop_coordinates_valid
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

ALTER TABLE "delivery_point"
  ADD CONSTRAINT delivery_point_coordinates_valid
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);

-- FR-TEN-04: an administrator may set the radius between 1 km and 5 km.
ALTER TABLE "college_config"
  ADD CONSTRAINT college_config_radius_in_permitted_range
  CHECK (serviceable_radius_m BETWEEN 1000 AND 5000);

ALTER TABLE "shop_listing"
  ADD CONSTRAINT shop_listing_distance_non_negative
  CHECK (distance_from_college_m >= 0);

-- ===========================================================================
-- 4. The geodesic distance function (C-2, FR-SHOP-05)
-- ===========================================================================

-- Constraint C-2 requires geodesic distance — measured over the curved
-- surface of the earth — rather than straight-line distance on a flat map.
-- At a 3 km threshold the difference is large enough to admit or reject a
-- shop wrongly, so the calculation lives in exactly one place: here.
--
-- Casting to `geography` is what makes ST_Distance return metres along the
-- spheroid. Without the cast it returns degrees, which is meaningless as a
-- distance. SRID 4326 is plain WGS 84 latitude/longitude, what a phone's GPS
-- and Google's geocoder both emit.
CREATE OR REPLACE FUNCTION hoppo_geodesic_distance_m(
  lat_a DOUBLE PRECISION,
  lng_a DOUBLE PRECISION,
  lat_b DOUBLE PRECISION,
  lng_b DOUBLE PRECISION
) RETURNS DOUBLE PRECISION
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT ST_Distance(
    ST_SetSRID(ST_MakePoint(lng_a, lat_a), 4326)::geography,
    ST_SetSRID(ST_MakePoint(lng_b, lat_b), 4326)::geography
  );
$$;

COMMENT ON FUNCTION hoppo_geodesic_distance_m IS
  'Geodesic distance in metres between two WGS84 points. The single authority for SRS constraint C-2. Note the argument order: latitude first, then longitude, unlike PostGIS ST_MakePoint which takes longitude first.';

-- ===========================================================================
-- 5. Ratings (FR-TRST-01)
-- ===========================================================================

ALTER TABLE "rating"
  ADD CONSTRAINT rating_score_in_range CHECK (score BETWEEN 1 AND 5);

-- Nobody rates themselves.
ALTER TABLE "rating"
  ADD CONSTRAINT rating_not_self CHECK (rater_id <> ratee_id);

ALTER TABLE "rider_reliability"
  ADD CONSTRAINT rider_reliability_counts_non_negative
  CHECK (
    tasks_offered >= 0 AND tasks_accepted >= 0
    AND tasks_completed >= 0 AND tasks_abandoned >= 0
    AND rating_count >= 0 AND rating_sum >= 0
  );

-- ===========================================================================
-- 6. Opening hours (FR-CAT-04)
-- ===========================================================================

-- Minutes from midnight. 1440 is permitted as a closing time, meaning
-- midnight exactly. A close at or before the open means the window crosses
-- midnight, which resolveOpenState() in @hoppo/shared handles.
ALTER TABLE "shop_hours"
  ADD CONSTRAINT shop_hours_day_valid CHECK (day_of_week BETWEEN 0 AND 6);

ALTER TABLE "shop_hours"
  ADD CONSTRAINT shop_hours_minutes_valid
  CHECK (open_minute BETWEEN 0 AND 1440 AND close_minute BETWEEN 0 AND 1440);

-- ===========================================================================
-- 7. Task shape by type (FR-ORD-06, FR-ORD-09)
-- ===========================================================================

-- A SHOP_ORDER task must reference an order; the other two types must not.
ALTER TABLE "task"
  ADD CONSTRAINT task_order_matches_type
  CHECK (
    (type = 'SHOP_ORDER' AND order_id IS NOT NULL)
    OR (type <> 'SHOP_ORDER' AND order_id IS NULL)
  );

-- A rider may not be the requester of their own task.
ALTER TABLE "task"
  ADD CONSTRAINT task_rider_is_not_requester
  CHECK (rider_id IS NULL OR rider_id <> requester_id);

-- Once assigned, a task has a rider; before that, it does not. This is the
-- structural half of FR-DLV-04 — the conditional UPDATE is the other half.
ALTER TABLE "task"
  ADD CONSTRAINT task_rider_presence_matches_status
  CHECK (
    (status IN ('CREATED', 'BROADCASTING', 'UNFULFILLED') AND rider_id IS NULL)
    OR (status IN ('ASSIGNED', 'PICKED_UP', 'DELIVERED', 'COMPLETED', 'ESCALATED') AND rider_id IS NOT NULL)
    OR status = 'CANCELLED'
  );

ALTER TABLE "task"
  ADD CONSTRAINT task_broadcast_round_non_negative CHECK (broadcast_round >= 0);

ALTER TABLE "task"
  ADD CONSTRAINT task_otp_attempts_non_negative CHECK (otp_attempts >= 0);

-- ===========================================================================
-- 8. Append-only tables (FR-ADM-06, FR-SVER-09, FR-PAY-02)
-- ===========================================================================

-- The SRS calls the audit log and the wallet ledger "immutable" and
-- "append-only". A comment saying so is not a guarantee. This trigger is.
--
-- A correction to the ledger is a new, opposite entry — never an edit to an
-- existing one, which is how double-entry bookkeeping has worked for six
-- hundred years and why a tampered ledger is detectable.
CREATE OR REPLACE FUNCTION hoppo_forbid_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. Insert a compensating row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_is_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION hoppo_forbid_mutation();

CREATE TRIGGER wallet_entry_is_append_only
  BEFORE UPDATE OR DELETE ON "wallet_entry"
  FOR EACH ROW EXECUTE FUNCTION hoppo_forbid_mutation();

CREATE TRIGGER broadcast_log_is_insert_or_resolve_only
  BEFORE DELETE ON "broadcast_log"
  FOR EACH ROW EXECUTE FUNCTION hoppo_forbid_mutation();

-- ===========================================================================
-- 9. Verification and identity (Section 11)
-- ===========================================================================

-- Section 11 is explicit: store the document type, the last four characters,
-- and the decision. Never the full number. Four characters is therefore the
-- ceiling, and this constraint is what stops a careless insert from turning
-- the column into a store of full Aadhaar numbers.
ALTER TABLE "student_profile"
  ADD CONSTRAINT student_profile_govt_id_last4_length
  CHECK (govt_id_last4 IS NULL OR char_length(govt_id_last4) <= 4);

ALTER TABLE "verification_submission"
  ADD CONSTRAINT verification_govt_id_last4_length
  CHECK (govt_id_last4 IS NULL OR char_length(govt_id_last4) <= 4);

-- FR-ID-03: where Aadhaar is mandated, the uploaded image must carry an
-- expiry so the deletion job has something to scan for. An image with no
-- expiry would be kept forever, which is the outcome Section 11 warns about.
ALTER TABLE "verification_submission"
  ADD CONSTRAINT verification_govt_id_image_must_expire
  CHECK (govt_id_image_url IS NULL OR govt_id_image_expires_at IS NOT NULL);

ALTER TABLE "student_profile"
  ADD CONSTRAINT student_profile_year_plausible
  CHECK (year_of_study BETWEEN 1 AND 6);

-- A rejected submission must say why (FR-SVER-05: the reason is mandatory and
-- comes from a controlled list).
ALTER TABLE "verification_submission"
  ADD CONSTRAINT verification_rejection_has_reason
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL);

ALTER TABLE "shop_listing"
  ADD CONSTRAINT shop_listing_rejection_has_reason
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL);

-- ===========================================================================
-- 10. Performance indexes beyond the datamodel
-- ===========================================================================

-- The dispatcher's hottest query is "which tasks are due for broadcast right
-- now". A partial index — one that covers only the rows matching a condition
-- — keeps this tiny however large the task table grows, because completed
-- tasks are simply not in it.
CREATE INDEX task_dispatch_due_partial
  ON "task" (dispatch_due_at)
  WHERE status = 'CREATED' AND dispatch_due_at IS NOT NULL;

CREATE INDEX task_offer_expiry_partial
  ON "task" (offer_expires_at)
  WHERE status = 'BROADCASTING' AND offer_expires_at IS NOT NULL;

-- The shop dashboard's live queue (D-08): orders awaiting a decision.
CREATE INDEX order_shop_open_partial
  ON "order" (shop_listing_id, placed_at)
  WHERE status IN ('PLACED', 'SHOP_ACCEPTED', 'PREPARING', 'READY');

-- The admin verification queues (A-03, A-05), which only ever show pending rows.
CREATE INDEX verification_pending_partial
  ON "verification_submission" (college_id, submitted_at)
  WHERE status = 'PENDING';

CREATE INDEX shop_listing_pending_partial
  ON "shop_listing" (college_id, submitted_at)
  WHERE status = 'PENDING_VERIFICATION';

-- Trigram search indexes for FR-COMM-05 and FR-CAT-06 are declared in
-- schema.prisma instead, using Prisma's `type: Gin` / `ops: raw(...)` support,
-- so that the datamodel stays the single source of truth and a later
-- `migrate dev` does not propose dropping them.
