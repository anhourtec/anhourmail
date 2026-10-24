ALTER TABLE "mailbox" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "office" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "office_phone" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "mobile_phone" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "street_address" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "country" text;