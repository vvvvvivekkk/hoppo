\set ON_ERROR_STOP off
\pset pager off

-- Seed just enough valid data to hang violations off.
INSERT INTO college (id, name, address, city, state, latitude, longitude, status, created_at, updated_at)
VALUES ('c1', 'Anurag University', 'Venkatapur', 'Hyderabad', 'Telangana', 17.3045, 78.6188, 'ACTIVE', now(), now());

INSERT INTO college_config (college_id, updated_at) VALUES ('c1', now());

INSERT INTO "user" (id, college_id, role, status, name, mobile, email, password_hash, created_at, updated_at)
VALUES ('u1', 'c1', 'STUDENT', 'ACTIVE', 'Test Student', '+919000000001', 's1@au.edu.in', 'x', now(), now());
INSERT INTO "user" (id, college_id, role, status, name, mobile, email, password_hash, created_at, updated_at)
VALUES ('u2', 'c1', 'STUDENT', 'ACTIVE', 'Test Rider', '+919000000002', 's2@au.edu.in', 'x', now(), now());

\echo '--- 1. a STUDENT with no college should be rejected'
INSERT INTO "user" (id, role, status, name, mobile, email, password_hash, created_at, updated_at)
VALUES ('bad1', 'STUDENT', 'ACTIVE', 'No College', '+919000000003', 'x1@x.com', 'x', now(), now());

\echo '--- 2. a SUPER_ADMIN with no college should be ACCEPTED'
INSERT INTO "user" (id, role, status, name, mobile, email, password_hash, created_at, updated_at)
VALUES ('sa1', 'SUPER_ADMIN', 'ACTIVE', 'Platform Admin', '+919000000004', 'sa@hoppo.app', 'x', now(), now());

\echo '--- 3. radius of 9 km should be rejected (FR-TEN-04 permits 1-5 km)'
UPDATE college_config SET serviceable_radius_m = 9000 WHERE college_id = 'c1';

\echo '--- 4. radius of 5 km should be ACCEPTED'
UPDATE college_config SET serviceable_radius_m = 5000 WHERE college_id = 'c1';

\echo '--- 5. latitude of 200 should be rejected'
UPDATE college SET latitude = 200 WHERE id = 'c1';

\echo '--- 6. a rating of 7 should be rejected (scale is 1-5)'
INSERT INTO shop (id, name, category, owner_name, owner_mobile, owner_email, address, city, state, latitude, longitude, location_type, created_at, updated_at)
VALUES ('sh1','Campus Cafe','FOOD','Owner','+919000000010','o@x.com','Gate 1','Hyderabad','Telangana',17.3050,78.6190,'ON_CAMPUS',now(),now());
INSERT INTO shop_listing (id, shop_id, college_id, distance_from_college_m, status, submitted_at, updated_at)
VALUES ('sl1','sh1','c1',120,'ACTIVE',now(),now());
INSERT INTO "order" (id, college_id, reference, student_id, shop_listing_id, status,
  items_subtotal_minor, delivery_fee_minor, platform_fee_minor, total_minor, commission_minor,
  payment_method, payment_status, placed_at, updated_at)
VALUES ('o1','c1','HP-TEST1','u1','sl1','PLACED', 12000, 2500, 0, 14500, 1200, 'CASH','PENDING',now(),now());
INSERT INTO task (id, college_id, type, status, order_id, requester_id, rider_id,
  pickup_label, pickup_latitude, pickup_longitude, drop_label, drop_latitude, drop_longitude,
  distance_m, base_fee_minor, fee_minor, created_at, updated_at)
VALUES ('t1','c1','SHOP_ORDER','COMPLETED','o1','u1','u2','Campus Cafe',17.3050,78.6190,'Hostel B',17.3040,78.6180,900,2500,2500,now(),now());
INSERT INTO rating (id, task_id, rater_id, ratee_id, score, created_at)
VALUES ('r1','t1','u1','u2',7,now());

\echo '--- 7. a rating of 5 should be ACCEPTED'
INSERT INTO rating (id, task_id, rater_id, ratee_id, score, created_at)
VALUES ('r2','t1','u1','u2',5,now());

\echo '--- 8. rating yourself should be rejected'
INSERT INTO rating (id, task_id, rater_id, ratee_id, score, created_at)
VALUES ('r3','t1','u1','u1',5,now());

\echo '--- 9. an order total that does not equal its parts should be rejected'
INSERT INTO "order" (id, college_id, reference, student_id, shop_listing_id, status,
  items_subtotal_minor, delivery_fee_minor, platform_fee_minor, total_minor, commission_minor,
  payment_method, payment_status, placed_at, updated_at)
VALUES ('o2','c1','HP-TEST2','u1','sl1','PLACED', 12000, 2500, 0, 99999, 0, 'CASH','PENDING',now(),now());

\echo '--- 10. a BROADCASTING task that already has a rider should be rejected'
INSERT INTO task (id, college_id, type, status, requester_id, rider_id,
  pickup_label, pickup_latitude, pickup_longitude, drop_label, drop_latitude, drop_longitude,
  distance_m, base_fee_minor, fee_minor, created_at, updated_at)
VALUES ('t2','c1','PARCEL_PICKUP','BROADCASTING','u1','u2','Gate',17.3050,78.6190,'Hostel',17.3040,78.6180,900,2500,2500,now(),now());

\echo '--- 11. a PARCEL_PICKUP carrying an order_id should be rejected'
INSERT INTO task (id, college_id, type, status, order_id, requester_id,
  pickup_label, pickup_latitude, pickup_longitude, drop_label, drop_latitude, drop_longitude,
  distance_m, base_fee_minor, fee_minor, created_at, updated_at)
VALUES ('t3','c1','PARCEL_PICKUP','CREATED','o1','u1','Gate',17.3050,78.6190,'Hostel',17.3040,78.6180,900,2500,2500,now(),now());

\echo '--- 12. an offered fee BELOW the quoted base should be rejected'
INSERT INTO task (id, college_id, type, status, requester_id,
  pickup_label, pickup_latitude, pickup_longitude, drop_label, drop_latitude, drop_longitude,
  distance_m, base_fee_minor, fee_minor, created_at, updated_at)
VALUES ('t4','c1','PEER_ERRAND','CREATED','u1','Gate',17.3050,78.6190,'Hostel',17.3040,78.6180,900,2500,2000,now(),now());

\echo '--- 13. a 12-digit govt id in the last4 column should be rejected (Section 11)'
INSERT INTO student_profile (user_id, roll_number, department, year_of_study, govt_id_type, govt_id_last4, verification_status, created_at, updated_at)
VALUES ('u1','26EG107A01','AI',4,'AADHAAR_MASKED','123456789012','VERIFIED',now(),now());

\echo '--- 14. storing only the last 4 should be ACCEPTED'
INSERT INTO student_profile (user_id, roll_number, department, year_of_study, govt_id_type, govt_id_last4, verification_status, created_at, updated_at)
VALUES ('u1','26EG107A01','AI',4,'AADHAAR_MASKED','9012','VERIFIED',now(),now());

\echo '--- 15. a govt id image with no expiry should be rejected (FR-ID-03)'
INSERT INTO verification_submission (id, user_id, college_id, roll_number, department, year_of_study, id_card_url, govt_id_image_url, status, submitted_at)
VALUES ('v1','u1','c1','26EG107A01','AI',4,'s3://card.jpg','s3://aadhaar.jpg','PENDING',now());

\echo '--- 16. a REJECTED submission with no reason should be rejected (FR-SVER-05)'
INSERT INTO verification_submission (id, user_id, college_id, roll_number, department, year_of_study, id_card_url, status, submitted_at)
VALUES ('v2','u1','c1','26EG107A01','AI',4,'s3://card.jpg','REJECTED',now());

\echo '--- 17. UPDATE on the audit log should be rejected (FR-ADM-06)'
INSERT INTO audit_log (id, actor_id, college_id, action, target_type, target_id, created_at)
VALUES ('a1','u1','c1','STUDENT_VERIFIED','user','u1',now());
UPDATE audit_log SET action = 'TAMPERED' WHERE id = 'a1';

\echo '--- 18. DELETE on the audit log should be rejected'
DELETE FROM audit_log WHERE id = 'a1';

\echo '--- 19. UPDATE on the wallet ledger should be rejected (FR-PAY-02)'
INSERT INTO wallet_entry (id, user_id, direction, amount_minor, type, balance_after_minor, created_at)
VALUES ('w1','u2','CREDIT',2500,'DELIVERY_FEE_EARNED',2500,now());
UPDATE wallet_entry SET amount_minor = 999999 WHERE id = 'w1';

\echo '--- 20. hours on day 9 should be rejected'
INSERT INTO shop_hours (id, shop_listing_id, day_of_week, open_minute, close_minute)
VALUES ('h1','sl1',9,540,1320);

\echo '--- 21. the geodesic distance function should return real metres'
SELECT round(hoppo_geodesic_distance_m(17.3045, 78.6188, 17.3850, 78.4867)::numeric, 1) AS au_to_hyderabad_centre_m;
SELECT round(hoppo_geodesic_distance_m(17.3045, 78.6188, 17.3050, 78.6190)::numeric, 1) AS campus_cafe_m;
SELECT round(hoppo_geodesic_distance_m(0, 0, 0, 1)::numeric, 1) AS one_degree_at_equator_m;
