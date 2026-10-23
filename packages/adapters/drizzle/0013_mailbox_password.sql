ALTER TABLE "mailbox" ADD COLUMN "pending_password_hash" text;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "password_credential_id" text;