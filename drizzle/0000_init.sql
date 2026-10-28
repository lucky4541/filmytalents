CREATE TYPE "public"."admin_status" AS ENUM('ACTIVE', 'INVITED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('APPLIED', 'VIEWED', 'SHORTLISTED', 'ROUND2', 'SELECTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."billing_cycle" AS ENUM('MONTHLY', 'QUARTERLY', 'HALFYEARLY', 'YEARLY');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('OPEN', 'RESOLVED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."casting_status" AS ENUM('DRAFT', 'SCHEDULED', 'PENDING', 'CHANGES', 'REJECTED', 'LIVE', 'CLOSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."gateway" AS ENUM('RAZORPAY', 'CASHFREE');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('PHOTO', 'VIDEO');--> statement-breakpoint
CREATE TYPE "public"."otp_purpose" AS ENUM('LOGIN', 'CHANGE_PHONE');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('CREATED', 'SUCCESS', 'FAILED', 'REFUNDED', 'PARTIAL_REFUND');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('VISIBLE', 'HIDDEN', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."post_type" AS ENUM('PHOTO', 'VIDEO', 'POST', 'COMMENT');--> statement-breakpoint
CREATE TYPE "public"."slot_status" AS ENUM('OPEN', 'BOOKED', 'CHECKED_IN', 'NO_SHOW', 'DONE');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."verify_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'MORE_INFO');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('ALL', 'PRO');--> statement-breakpoint
CREATE TABLE "admins" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" text NOT NULL,
	"status" "admin_status" DEFAULT 'INVITED' NOT NULL,
	"invite_token" text,
	"invite_expiry" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email"),
	CONSTRAINT "admins_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
CREATE TABLE "application_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"author_name" text NOT NULL,
	"by_admin" boolean DEFAULT true NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"casting_id" text NOT NULL,
	"role_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" "application_status" DEFAULT 'APPLIED' NOT NULL,
	"tape_url" text,
	"note" text DEFAULT '' NOT NULL,
	"rating" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"admin_id" text,
	"actor_name" text NOT NULL,
	"module" text NOT NULL,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audition_days" (
	"id" text PRIMARY KEY NOT NULL,
	"casting_id" text NOT NULL,
	"title" text NOT NULL,
	"date" text NOT NULL,
	"start" text NOT NULL,
	"end" text NOT NULL,
	"slot_mins" integer NOT NULL,
	"mode" text DEFAULT 'In person' NOT NULL,
	"venue" text NOT NULL,
	"bring" text DEFAULT '' NOT NULL,
	"reminders_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audition_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"day_id" text NOT NULL,
	"time" text NOT NULL,
	"application_id" text,
	"status" "slot_status" DEFAULT 'OPEN' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "audition_slots_application_id_unique" UNIQUE("application_id")
);
--> statement-breakpoint
CREATE TABLE "auto_rules" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"group" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"template" text NOT NULL,
	"sent_7d" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"segment" jsonb NOT NULL,
	"link" text,
	"audience" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered" integer DEFAULT 0 NOT NULL,
	"opened" integer DEFAULT 0 NOT NULL,
	"clicked" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canned_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "casting_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"casting_id" text NOT NULL,
	"name" text NOT NULL,
	"gender" text DEFAULT 'Any' NOT NULL,
	"age_min" integer DEFAULT 18 NOT NULL,
	"age_max" integer DEFAULT 60 NOT NULL,
	"positions" integer DEFAULT 1 NOT NULL,
	"height_note" text DEFAULT '' NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"experience" text DEFAULT 'Any' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "castings" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"production" text NOT NULL,
	"show_production_as" text DEFAULT 'name' NOT NULL,
	"project_type" text NOT NULL,
	"poster_url" text,
	"description" text NOT NULL,
	"location" text NOT NULL,
	"mode" text DEFAULT 'In person' NOT NULL,
	"venue" text DEFAULT '' NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"budget" text DEFAULT '' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"visibility" "visibility" DEFAULT 'ALL' NOT NULL,
	"pro_early_access_hours" integer DEFAULT 0 NOT NULL,
	"status" "casting_status" DEFAULT 'DRAFT' NOT NULL,
	"publish_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"featured" boolean DEFAULT false NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"send_alert" boolean DEFAULT true NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"review_note" text DEFAULT '' NOT NULL,
	"posted_by_user_id" text,
	"created_by_admin_id" text,
	"client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "castings_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "catalogue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"list" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"reported_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"reason" text NOT NULL,
	"message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "case_status" DEFAULT 'OPEN' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"company" text NOT NULL,
	"contact_name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"a_id" text NOT NULL,
	"b_id" text NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"percent" integer,
	"amount_off" integer,
	"plan_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"cycles" "billing_cycle"[] DEFAULT '{}'::billing_cycle[] NOT NULL,
	"max_uses" integer,
	"used" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "data_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" text NOT NULL,
	"following_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_follower_id_following_id_pk" PRIMARY KEY("follower_id","following_id")
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"user_id" text NOT NULL,
	"post_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_user_id_post_id_pk" PRIMARY KEY("user_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "media_type" NOT NULL,
	"url" text NOT NULL,
	"thumb_url" text,
	"caption" text DEFAULT '' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"text" text NOT NULL,
	"flagged" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"ip" text,
	"provider" text DEFAULT 'dummy' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"base" integer NOT NULL,
	"discount" integer DEFAULT 0 NOT NULL,
	"gst" integer NOT NULL,
	"amount" integer NOT NULL,
	"gateway" "gateway" NOT NULL,
	"gateway_order_id" text NOT NULL,
	"gateway_payment_id" text,
	"status" "payment_status" DEFAULT 'CREATED' NOT NULL,
	"method" text,
	"coupon_code" text,
	"refund_amount" integer DEFAULT 0 NOT NULL,
	"refund_reason" text DEFAULT '' NOT NULL,
	"invoice_no" text,
	"billing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "payments_gateway_order_id_unique" UNIQUE("gateway_order_id"),
	CONSTRAINT "payments_invoice_no_unique" UNIQUE("invoice_no")
);
--> statement-breakpoint
CREATE TABLE "plan_prices" (
	"plan_id" text NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"price" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plan_prices_plan_id_cycle_pk" PRIMARY KEY("plan_id","cycle")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"popular" boolean DEFAULT false NOT NULL,
	"color" text DEFAULT 'gold' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "post_type" NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"media_url" text,
	"parent_id" text,
	"status" "post_status" DEFAULT 'VISIBLE' NOT NULL,
	"flag" text,
	"reports_count" integer DEFAULT 0 NOT NULL,
	"likes_count" integer DEFAULT 0 NOT NULL,
	"remove_reason" text DEFAULT '' NOT NULL,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_views" (
	"id" text PRIMARY KEY NOT NULL,
	"viewed_id" text NOT NULL,
	"viewer_id" text,
	"by_admin" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text,
	"admin_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"reported_user_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"target_label" text NOT NULL,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" "case_status" DEFAULT 'OPEN' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role" text PRIMARY KEY NOT NULL,
	"modules" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round2_invites" (
	"application_id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"venue" text NOT NULL,
	"bring" text DEFAULT '' NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"query" text NOT NULL,
	"alerts" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"cipher" text NOT NULL,
	"hint" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_items" (
	"share_id" text NOT NULL,
	"application_id" text NOT NULL,
	"pick" text,
	"comment" text DEFAULT '' NOT NULL,
	"picked_at" timestamp with time zone,
	CONSTRAINT "share_items_share_id_application_id_pk" PRIMARY KEY("share_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "shortlist_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"casting_id" text NOT NULL,
	"role_id" text,
	"client_id" text NOT NULL,
	"title" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"show_videos" boolean DEFAULT true NOT NULL,
	"show_measurements" boolean DEFAULT true NOT NULL,
	"allow_download" boolean DEFAULT false NOT NULL,
	"passcode_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"views" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shortlist_shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"from_admin" boolean NOT NULL,
	"name" text NOT NULL,
	"text" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"user_id" text NOT NULL,
	"subject" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_id" text,
	"channel" text DEFAULT 'app' NOT NULL,
	"first_response_mins" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"phone" text NOT NULL,
	"phone_verified_at" timestamp with time zone,
	"name" text DEFAULT '' NOT NULL,
	"email" text,
	"gender" text,
	"dob" timestamp with time zone,
	"city" text,
	"state" text,
	"bio" text DEFAULT '' NOT NULL,
	"crafts" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"experience" text,
	"height_cm" integer,
	"avatar_url" text,
	"cover_url" text,
	"instagram" text,
	"youtube" text,
	"is_minor" boolean DEFAULT false NOT NULL,
	"guardian_name" text,
	"guardian_relation" text,
	"guardian_phone" text,
	"guardian_consent_at" timestamp with time zone,
	"verified" boolean DEFAULT false NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"suspended_until" timestamp with time zone,
	"chat_muted_until" timestamp with time zone,
	"warnings" integer DEFAULT 0 NOT NULL,
	"plan_id" text DEFAULT 'free' NOT NULL,
	"plan_cycle" "billing_cycle",
	"plan_until" timestamp with time zone,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"applications_month" text DEFAULT '' NOT NULL,
	"applications_count" integer DEFAULT 0 NOT NULL,
	"referral_code" text NOT NULL,
	"referred_by_id" text,
	"bonus_days" integer DEFAULT 0 NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"privacy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"profile_views" integer DEFAULT 0 NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_code_unique" UNIQUE("code"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "verification_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"doc_type" text NOT NULL,
	"docs" jsonb NOT NULL,
	"status" "verify_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_casting_id_castings_id_fk" FOREIGN KEY ("casting_id") REFERENCES "public"."castings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_role_id_casting_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."casting_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audition_days" ADD CONSTRAINT "audition_days_casting_id_castings_id_fk" FOREIGN KEY ("casting_id") REFERENCES "public"."castings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audition_slots" ADD CONSTRAINT "audition_slots_day_id_audition_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."audition_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audition_slots" ADD CONSTRAINT "audition_slots_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "casting_roles" ADD CONSTRAINT "casting_roles_casting_id_castings_id_fk" FOREIGN KEY ("casting_id") REFERENCES "public"."castings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "castings" ADD CONSTRAINT "castings_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "castings" ADD CONSTRAINT "castings_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "castings" ADD CONSTRAINT "castings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reported_id_users_id_fk" FOREIGN KEY ("reported_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_a_id_users_id_fk" FOREIGN KEY ("a_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_b_id_users_id_fk" FOREIGN KEY ("b_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_following_id_users_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewed_id_users_id_fk" FOREIGN KEY ("viewed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round2_invites" ADD CONSTRAINT "round2_invites_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_items" ADD CONSTRAINT "share_items_share_id_shortlist_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shortlist_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_items" ADD CONSTRAINT "share_items_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_shares" ADD CONSTRAINT "shortlist_shares_casting_id_castings_id_fk" FOREIGN KEY ("casting_id") REFERENCES "public"."castings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlist_shares" ADD CONSTRAINT "shortlist_shares_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_admins_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_casting_user_uq" ON "applications" USING btree ("casting_id","user_id");--> statement-breakpoint
CREATE INDEX "app_casting_status_idx" ON "applications" USING btree ("casting_id","status");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_module_idx" ON "audit_logs" USING btree ("module");--> statement-breakpoint
CREATE UNIQUE INDEX "slot_day_time_uq" ON "audition_slots" USING btree ("day_id","time");--> statement-breakpoint
CREATE INDEX "castings_status_idx" ON "castings" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "castings_poster_idx" ON "castings" USING btree ("posted_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalogue_list_name_uq" ON "catalogue_items" USING btree ("list","name");--> statement-breakpoint
CREATE UNIQUE INDEX "conv_pair_uq" ON "conversations" USING btree ("a_id","b_id");--> statement-breakpoint
CREATE INDEX "media_user_idx" ON "media" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "msg_conv_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "notif_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_phone_idx" ON "otp_codes" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "posts_status_idx" ON "posts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pv_viewed_idx" ON "profile_views" USING btree ("viewed_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_plan_idx" ON "users" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "users_city_idx" ON "users" USING btree ("city");--> statement-breakpoint
CREATE INDEX "verif_status_idx" ON "verification_requests" USING btree ("status");