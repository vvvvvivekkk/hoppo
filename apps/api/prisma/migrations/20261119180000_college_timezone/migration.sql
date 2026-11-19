-- Opening hours are stored as minutes from midnight (540 = 09:00). Without a
-- timezone on the college, "is this shop open now" was resolved against the
-- API process's local time — so the same shop appeared to open at 09:00 UTC
-- on a server outside India, which is 14:30 in Hyderabad, and showed as
-- closed through most of its real trading day.
--
-- Asia/Kolkata as the default, since every college in scope is in India.
-- See docs/srs-resolutions.md R-18.
ALTER TABLE "college" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';
