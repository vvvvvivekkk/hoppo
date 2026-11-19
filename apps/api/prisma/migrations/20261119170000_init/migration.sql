-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "CollegeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('STUDENT', 'SHOP_OWNER', 'SHOP_STAFF', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNSUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RejectionReason" AS ENUM ('ID_CARD_ILLEGIBLE', 'ID_CARD_EXPIRED', 'NAME_MISMATCH', 'ROLL_NUMBER_MISMATCH', 'NOT_ENROLLED_AT_COLLEGE', 'DOCUMENT_INCOMPLETE', 'SUSPECTED_FORGERY', 'DUPLICATE_ACCOUNT', 'ADDRESS_OUTSIDE_RADIUS', 'LICENCE_INVALID', 'OTHER');

-- CreateEnum
CREATE TYPE "GovtIdType" AS ENUM ('DRIVING_LICENCE', 'VOTER_ID', 'PASSPORT', 'AADHAAR_MASKED');

-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('ON_CAMPUS', 'OFF_CAMPUS');

-- CreateEnum
CREATE TYPE "ShopDocumentType" AS ENUM ('ESTABLISHMENT_LICENCE', 'GSTIN_CERTIFICATE', 'OWNER_PHOTO_ID', 'FRONTAGE_PHOTO', 'CAMPUS_PERMIT', 'FSSAI_LICENCE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PLACED', 'SHOP_ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderCancelledBy" AS ENUM ('STUDENT', 'SHOP', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('SHOP_ORDER', 'PARCEL_PICKUP', 'PEER_ERRAND');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('CREATED', 'BROADCASTING', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'COMPLETED', 'UNFULFILLED', 'ESCALATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'ONLINE', 'WALLET');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'HELD', 'CAPTURED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "WalletDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "WalletEntryType" AS ENUM ('DELIVERY_FEE_EARNED', 'ERRAND_REIMBURSEMENT', 'ORDER_HOLD', 'ORDER_CAPTURE', 'ORDER_RELEASE', 'WITHDRAWAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChatRoomType" AS ENUM ('TASK', 'DIRECT', 'GROUP');

-- CreateEnum
CREATE TYPE "PostCategory" AS ENUM ('NOTES_RESOURCES', 'INTERNSHIPS_JOBS', 'LOST_FOUND', 'BUY_SELL', 'ANNOUNCEMENTS', 'GENERAL');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('PUBLISHED', 'HIDDEN_PENDING_REVIEW', 'REMOVED');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('POST', 'COMMENT', 'MESSAGE', 'USER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('PHONE_VERIFY', 'EMAIL_VERIFY', 'PASSWORD_RESET', 'SHOP_LOGIN');

-- CreateEnum
CREATE TYPE "BroadcastOutcome" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

-- CreateTable
CREATE TABLE "college" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "email_domain" TEXT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "status" "CollegeStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "college_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "college_config" (
    "college_id" TEXT NOT NULL,
    "serviceable_radius_m" INTEGER NOT NULL DEFAULT 3000,
    "acceptance_window_seconds" INTEGER NOT NULL DEFAULT 60,
    "max_broadcast_rounds" INTEGER NOT NULL DEFAULT 3,
    "initial_proximity_m" INTEGER NOT NULL DEFAULT 1500,
    "proximity_increment_m" INTEGER NOT NULL DEFAULT 1000,
    "fee_increment_minor" INTEGER NOT NULL DEFAULT 500,
    "dispatch_lead_minutes" INTEGER NOT NULL DEFAULT 7,
    "work_mode_idle_timeout_minutes" INTEGER NOT NULL DEFAULT 120,
    "rider_ping_interval_seconds" INTEGER NOT NULL DEFAULT 15,
    "shop_accept_window_seconds" INTEGER NOT NULL DEFAULT 300,
    "max_otp_attempts" INTEGER NOT NULL DEFAULT 5,
    "platform_fee_minor" INTEGER NOT NULL DEFAULT 0,
    "commission_bps" INTEGER NOT NULL DEFAULT 0,
    "min_withdrawal_minor" INTEGER NOT NULL DEFAULT 10000,
    "max_verification_submissions" INTEGER NOT NULL DEFAULT 3,
    "verification_window_days" INTEGER NOT NULL DEFAULT 7,
    "abandonment_ban_threshold" INTEGER NOT NULL DEFAULT 3,
    "abandonment_window_days" INTEGER NOT NULL DEFAULT 7,
    "abandonment_ban_hours" INTEGER NOT NULL DEFAULT 48,
    "chat_retention_days" INTEGER NOT NULL DEFAULT 180,
    "report_hide_threshold" INTEGER NOT NULL DEFAULT 5,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "college_config_pkey" PRIMARY KEY ("college_id")
);

-- CreateTable
CREATE TABLE "fee_band" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "min_distance_m" INTEGER NOT NULL,
    "max_distance_m" INTEGER,
    "fee_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_band_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_point" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "college_id" TEXT,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "avatar_url" TEXT,
    "mobile_verified_at" TIMESTAMP(3),
    "email_verified_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profile" (
    "user_id" TEXT NOT NULL,
    "roll_number" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "year_of_study" INTEGER NOT NULL,
    "id_card_url" TEXT,
    "govt_id_type" "GovtIdType",
    "govt_id_last4" TEXT,
    "govt_id_verified_at" TIMESTAMP(3),
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNSUBMITTED',
    "verified_at" TIMESTAMP(3),
    "verified_by_user_id" TEXT,
    "rider_terms_version" TEXT,
    "rider_terms_accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "verification_submission" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "roll_number" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "year_of_study" INTEGER NOT NULL,
    "id_card_url" TEXT NOT NULL,
    "govt_id_type" "GovtIdType",
    "govt_id_last4" TEXT,
    "govt_id_image_url" TEXT,
    "govt_id_image_expires_at" TIMESTAMP(3),
    "consent_given_at" TIMESTAMP(3),
    "consent_purpose_text" TEXT,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "rejection_reason" "RejectionReason",
    "rejection_note" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_state" (
    "user_id" TEXT NOT NULL,
    "work_mode_on" BOOLEAN NOT NULL DEFAULT false,
    "work_mode_on_at" TIMESTAMP(3),
    "last_latitude" DOUBLE PRECISION,
    "last_longitude" DOUBLE PRECISION,
    "last_ping_at" TIMESTAMP(3),
    "active_task_id" TEXT,
    "barred_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rider_state_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "rider_reliability" (
    "user_id" TEXT NOT NULL,
    "tasks_offered" INTEGER NOT NULL DEFAULT 0,
    "tasks_accepted" INTEGER NOT NULL DEFAULT 0,
    "tasks_completed" INTEGER NOT NULL DEFAULT 0,
    "tasks_abandoned" INTEGER NOT NULL DEFAULT 0,
    "acceptance_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "abandonment_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "avg_delivery_seconds" INTEGER,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "flagged_for_review_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rider_reliability_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "recipient" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_token" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "token" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "user_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("user_id","category")
);

-- CreateTable
CREATE TABLE "shop" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "owner_mobile" TEXT NOT NULL,
    "owner_email" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "pin_adjusted" BOOLEAN NOT NULL DEFAULT false,
    "location_type" "LocationType" NOT NULL,
    "fssai_licence_number" TEXT,
    "fssai_expires_at" TIMESTAMP(3),
    "gstin" TEXT,
    "razorpay_account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_listing" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "distance_from_college_m" INTEGER NOT NULL,
    "status" "ShopStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejection_reason" "RejectionReason",
    "rejection_note" TEXT,
    "flagged_for_radius_review_at" TIMESTAMP(3),
    "temporarily_closed_until" TIMESTAMP(3),
    "closure_note" TEXT,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_document" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "doc_type" "ShopDocumentType" NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_staff" (
    "shop_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_staff_pkey" PRIMARY KEY ("shop_id","user_id")
);

-- CreateTable
CREATE TABLE "shop_hours" (
    "id" TEXT NOT NULL,
    "shop_listing_id" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "open_minute" INTEGER NOT NULL,
    "close_minute" INTEGER NOT NULL,

    CONSTRAINT "shop_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_category" (
    "id" TEXT NOT NULL,
    "shop_listing_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item" (
    "id" TEXT NOT NULL,
    "shop_listing_id" TEXT NOT NULL,
    "category_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_minor" INTEGER NOT NULL,
    "prep_minutes" INTEGER NOT NULL DEFAULT 10,
    "image_url" TEXT,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "shop_listing_id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PLACED',
    "items_subtotal_minor" INTEGER NOT NULL,
    "delivery_fee_minor" INTEGER NOT NULL,
    "platform_fee_minor" INTEGER NOT NULL DEFAULT 0,
    "total_minor" INTEGER NOT NULL,
    "commission_minor" INTEGER NOT NULL DEFAULT 0,
    "payment_method" "PaymentMethod" NOT NULL,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "payment_ref" TEXT,
    "delivery_point_id" TEXT,
    "drop_landmark" TEXT,
    "drop_latitude" DOUBLE PRECISION,
    "drop_longitude" DOUBLE PRECISION,
    "student_note" TEXT,
    "stated_prep_minutes" INTEGER,
    "expected_ready_at" TIMESTAMP(3),
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shop_accepted_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" "OrderCancelledBy",
    "cancelled_reason" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "catalog_item_id" TEXT,
    "name_snapshot" TEXT NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total_minor" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'CREATED',
    "order_id" TEXT,
    "requester_id" TEXT NOT NULL,
    "rider_id" TEXT,
    "pickup_label" TEXT NOT NULL,
    "pickup_latitude" DOUBLE PRECISION NOT NULL,
    "pickup_longitude" DOUBLE PRECISION NOT NULL,
    "drop_label" TEXT NOT NULL,
    "drop_latitude" DOUBLE PRECISION NOT NULL,
    "drop_longitude" DOUBLE PRECISION NOT NULL,
    "distance_m" INTEGER NOT NULL,
    "description" TEXT,
    "collection_ref" TEXT,
    "reimbursement_minor" INTEGER,
    "base_fee_minor" INTEGER NOT NULL,
    "fee_minor" INTEGER NOT NULL,
    "broadcast_round" INTEGER NOT NULL DEFAULT 0,
    "current_proximity_m" INTEGER,
    "offer_expires_at" TIMESTAMP(3),
    "dispatch_due_at" TIMESTAMP(3),
    "otp_hash" TEXT,
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "otp_issued_at" TIMESTAMP(3),
    "pickup_proof_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_broadcast_at" TIMESTAMP(3),
    "assigned_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "escalated_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_log" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "radius_m" INTEGER NOT NULL,
    "fee_minor" INTEGER NOT NULL,
    "eligible_count" INTEGER NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "BroadcastOutcome" NOT NULL DEFAULT 'PENDING',
    "accepted_by_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "broadcast_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_room" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "type" "ChatRoomType" NOT NULL,
    "task_id" TEXT,
    "name" TEXT,
    "description" TEXT,
    "created_by_user_id" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_member" (
    "room_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "last_read_message_id" TEXT,
    "muted_until" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "chat_member_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "room_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "body" TEXT,
    "attachment_url" TEXT,
    "attachment_type" TEXT,
    "attachment_size_bytes" INTEGER,
    "client_message_id" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_receipt" (
    "message_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),

    CONSTRAINT "message_receipt_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateTable
CREATE TABLE "blocked_user" (
    "owner_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_user_pkey" PRIMARY KEY ("owner_id","target_id")
);

-- CreateTable
CREATE TABLE "post" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "category" "PostCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachment_url" TEXT,
    "link_url" TEXT,
    "upvote_count" INTEGER NOT NULL DEFAULT 0,
    "comment_count" INTEGER NOT NULL DEFAULT 0,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "status" "PostStatus" NOT NULL DEFAULT 'PUBLISHED',
    "pinned_at" TIMESTAMP(3),
    "edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_vote" (
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_vote_pkey" PRIMARY KEY ("post_id","user_id")
);

-- CreateTable
CREATE TABLE "saved_post" (
    "post_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_post_pkey" PRIMARY KEY ("post_id","user_id")
);

-- CreateTable
CREATE TABLE "comment" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'PUBLISHED',
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_entry" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "direction" "WalletDirection" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "type" "WalletEntryType" NOT NULL,
    "task_id" TEXT,
    "order_id" TEXT,
    "counterparty_user_id" TEXT,
    "note" TEXT,
    "balance_after_minor" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_request" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "bank_account_last4" TEXT,
    "bank_ifsc" TEXT,
    "upi_id" TEXT,
    "handled_by_user_id" TEXT,
    "handled_at" TIMESTAMP(3),
    "payout_reference" TEXT,
    "rejection_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "rater_id" TEXT NOT NULL,
    "ratee_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "shop_listing_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "handled_by_user_id" TEXT,
    "handled_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "college_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "detail" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "college_status_idx" ON "college"("status");

-- CreateIndex
CREATE INDEX "fee_band_college_id_idx" ON "fee_band"("college_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_band_college_id_min_distance_m_key" ON "fee_band"("college_id", "min_distance_m");

-- CreateIndex
CREATE INDEX "delivery_point_college_id_is_active_idx" ON "delivery_point"("college_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "user_mobile_key" ON "user"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_college_id_role_status_idx" ON "user"("college_id", "role", "status");

-- CreateIndex
CREATE INDEX "user_college_id_status_idx" ON "user"("college_id", "status");

-- CreateIndex
CREATE INDEX "student_profile_verification_status_idx" ON "student_profile"("verification_status");

-- CreateIndex
CREATE INDEX "verification_submission_college_id_status_submitted_at_idx" ON "verification_submission"("college_id", "status", "submitted_at");

-- CreateIndex
CREATE INDEX "verification_submission_user_id_submitted_at_idx" ON "verification_submission"("user_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "rider_state_active_task_id_key" ON "rider_state"("active_task_id");

-- CreateIndex
CREATE INDEX "rider_state_work_mode_on_last_ping_at_idx" ON "rider_state"("work_mode_on", "last_ping_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_revoked_at_idx" ON "refresh_token"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "otp_challenge_recipient_purpose_created_at_idx" ON "otp_challenge"("recipient", "purpose", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_token_token_key" ON "device_token"("token");

-- CreateIndex
CREATE INDEX "device_token_user_id_idx" ON "device_token"("user_id");

-- CreateIndex
CREATE INDEX "shop_location_type_idx" ON "shop"("location_type");

-- CreateIndex
CREATE INDEX "shop_listing_college_id_status_idx" ON "shop_listing"("college_id", "status");

-- CreateIndex
CREATE INDEX "shop_listing_college_id_status_distance_from_college_m_idx" ON "shop_listing"("college_id", "status", "distance_from_college_m");

-- CreateIndex
CREATE UNIQUE INDEX "shop_listing_shop_id_college_id_key" ON "shop_listing"("shop_id", "college_id");

-- CreateIndex
CREATE INDEX "shop_document_shop_id_doc_type_idx" ON "shop_document"("shop_id", "doc_type");

-- CreateIndex
CREATE INDEX "shop_staff_user_id_idx" ON "shop_staff"("user_id");

-- CreateIndex
CREATE INDEX "shop_hours_shop_listing_id_day_of_week_idx" ON "shop_hours"("shop_listing_id", "day_of_week");

-- CreateIndex
CREATE INDEX "catalog_category_shop_listing_id_idx" ON "catalog_category"("shop_listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_category_shop_listing_id_name_key" ON "catalog_category"("shop_listing_id", "name");

-- CreateIndex
CREATE INDEX "catalog_item_shop_listing_id_is_available_is_deleted_idx" ON "catalog_item"("shop_listing_id", "is_available", "is_deleted");

-- CreateIndex
CREATE INDEX "catalog_item_category_id_idx" ON "catalog_item"("category_id");

-- CreateIndex
CREATE INDEX "catalog_item_name_idx" ON "catalog_item" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "order_reference_key" ON "order"("reference");

-- CreateIndex
CREATE INDEX "order_college_id_status_placed_at_idx" ON "order"("college_id", "status", "placed_at");

-- CreateIndex
CREATE INDEX "order_shop_listing_id_status_placed_at_idx" ON "order"("shop_listing_id", "status", "placed_at");

-- CreateIndex
CREATE INDEX "order_student_id_placed_at_idx" ON "order"("student_id", "placed_at");

-- CreateIndex
CREATE INDEX "order_item_order_id_idx" ON "order_item"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_order_id_key" ON "task"("order_id");

-- CreateIndex
CREATE INDEX "task_status_dispatch_due_at_idx" ON "task"("status", "dispatch_due_at");

-- CreateIndex
CREATE INDEX "task_status_offer_expires_at_idx" ON "task"("status", "offer_expires_at");

-- CreateIndex
CREATE INDEX "task_college_id_status_created_at_idx" ON "task"("college_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "task_rider_id_status_idx" ON "task"("rider_id", "status");

-- CreateIndex
CREATE INDEX "task_requester_id_created_at_idx" ON "task"("requester_id", "created_at");

-- CreateIndex
CREATE INDEX "broadcast_log_task_id_idx" ON "broadcast_log"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_log_task_id_round_key" ON "broadcast_log"("task_id", "round");

-- CreateIndex
CREATE UNIQUE INDEX "chat_room_task_id_key" ON "chat_room"("task_id");

-- CreateIndex
CREATE INDEX "chat_room_college_id_type_idx" ON "chat_room"("college_id", "type");

-- CreateIndex
CREATE INDEX "chat_room_college_id_last_message_at_idx" ON "chat_room"("college_id", "last_message_at");

-- CreateIndex
CREATE INDEX "chat_member_user_id_left_at_idx" ON "chat_member"("user_id", "left_at");

-- CreateIndex
CREATE INDEX "message_room_id_sent_at_idx" ON "message"("room_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_sender_id_client_message_id_key" ON "message"("sender_id", "client_message_id");

-- CreateIndex
CREATE INDEX "message_receipt_user_id_read_at_idx" ON "message_receipt"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "post_college_id_status_created_at_idx" ON "post"("college_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "post_college_id_category_status_created_at_idx" ON "post"("college_id", "category", "status", "created_at");

-- CreateIndex
CREATE INDEX "post_college_id_status_upvote_count_idx" ON "post"("college_id", "status", "upvote_count");

-- CreateIndex
CREATE INDEX "post_title_idx" ON "post" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "post_body_idx" ON "post" USING GIN ("body" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "saved_post_user_id_created_at_idx" ON "saved_post"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "comment_post_id_created_at_idx" ON "comment"("post_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_entry_user_id_created_at_idx" ON "wallet_entry"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_entry_task_id_idx" ON "wallet_entry"("task_id");

-- CreateIndex
CREATE INDEX "withdrawal_request_status_created_at_idx" ON "withdrawal_request"("status", "created_at");

-- CreateIndex
CREATE INDEX "withdrawal_request_user_id_created_at_idx" ON "withdrawal_request"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "rating_ratee_id_created_at_idx" ON "rating"("ratee_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rating_task_id_rater_id_ratee_id_key" ON "rating"("task_id", "rater_id", "ratee_id");

-- CreateIndex
CREATE INDEX "report_college_id_status_created_at_idx" ON "report"("college_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "report_target_type_target_id_idx" ON "report"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_reporter_id_target_type_target_id_key" ON "report"("reporter_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_log_college_id_created_at_idx" ON "audit_log"("college_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_target_type_target_id_created_at_idx" ON "audit_log"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "college_config" ADD CONSTRAINT "college_config_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_band" ADD CONSTRAINT "fee_band_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_point" ADD CONSTRAINT "delivery_point_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_submission" ADD CONSTRAINT "verification_submission_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_submission" ADD CONSTRAINT "verification_submission_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_state" ADD CONSTRAINT "rider_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_state" ADD CONSTRAINT "rider_state_active_task_id_fkey" FOREIGN KEY ("active_task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_reliability" ADD CONSTRAINT "rider_reliability_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_token" ADD CONSTRAINT "device_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_listing" ADD CONSTRAINT "shop_listing_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_listing" ADD CONSTRAINT "shop_listing_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_listing" ADD CONSTRAINT "shop_listing_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_document" ADD CONSTRAINT "shop_document_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_staff" ADD CONSTRAINT "shop_staff_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_staff" ADD CONSTRAINT "shop_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_hours" ADD CONSTRAINT "shop_hours_shop_listing_id_fkey" FOREIGN KEY ("shop_listing_id") REFERENCES "shop_listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_category" ADD CONSTRAINT "catalog_category_shop_listing_id_fkey" FOREIGN KEY ("shop_listing_id") REFERENCES "shop_listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_shop_listing_id_fkey" FOREIGN KEY ("shop_listing_id") REFERENCES "shop_listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "catalog_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_shop_listing_id_fkey" FOREIGN KEY ("shop_listing_id") REFERENCES "shop_listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_catalog_item_id_fkey" FOREIGN KEY ("catalog_item_id") REFERENCES "catalog_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_rider_id_fkey" FOREIGN KEY ("rider_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_log" ADD CONSTRAINT "broadcast_log_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_room" ADD CONSTRAINT "chat_room_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_room" ADD CONSTRAINT "chat_room_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_room" ADD CONSTRAINT "chat_room_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_member" ADD CONSTRAINT "chat_member_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_member" ADD CONSTRAINT "chat_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "chat_room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_user" ADD CONSTRAINT "blocked_user_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_user" ADD CONSTRAINT "blocked_user_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_vote" ADD CONSTRAINT "post_vote_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_vote" ADD CONSTRAINT "post_vote_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_post" ADD CONSTRAINT "saved_post_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_post" ADD CONSTRAINT "saved_post_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entry" ADD CONSTRAINT "wallet_entry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entry" ADD CONSTRAINT "wallet_entry_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_request" ADD CONSTRAINT "withdrawal_request_handled_by_user_id_fkey" FOREIGN KEY ("handled_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating" ADD CONSTRAINT "rating_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating" ADD CONSTRAINT "rating_rater_id_fkey" FOREIGN KEY ("rater_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating" ADD CONSTRAINT "rating_ratee_id_fkey" FOREIGN KEY ("ratee_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_handled_by_user_id_fkey" FOREIGN KEY ("handled_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

