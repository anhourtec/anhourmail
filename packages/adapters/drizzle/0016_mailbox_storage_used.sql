ALTER TABLE "mailbox" ADD COLUMN "storage_used_bytes" bigint;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "storage_checked_at" timestamp with time zone;