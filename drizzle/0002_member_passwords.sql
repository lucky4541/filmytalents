ALTER TYPE "public"."otp_purpose" ADD VALUE 'REGISTER';--> statement-breakpoint
ALTER TYPE "public"."otp_purpose" ADD VALUE 'RESET_PASSWORD';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_set_at" timestamp with time zone;