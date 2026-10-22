ALTER TABLE "mailbox" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "mailbox_purge_idx" ON "mailbox" USING btree ("purge_after") WHERE status = 'deleting';