ALTER TABLE "invite" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "waitlist_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "accepted_user_id" text;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD COLUMN "confirm_token_hash" text;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD COLUMN "confirm_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD COLUMN "confirm_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist_entry" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entry_confirm_token_idx" ON "waitlist_entry" USING btree ("confirm_token_hash");