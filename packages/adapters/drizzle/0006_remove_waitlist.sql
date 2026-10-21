DROP TABLE "waitlist_entry" CASCADE;--> statement-breakpoint
ALTER TABLE "invite" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "invite" DROP COLUMN "waitlist_entry_id";