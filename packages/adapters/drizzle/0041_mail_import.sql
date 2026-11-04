CREATE TABLE "mail_import" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"batch_id" uuid,
	"requested_by" text,
	"requested_as" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_host" text NOT NULL,
	"source_port" integer NOT NULL,
	"source_username" text,
	"source_secret" text,
	"destination_secret" text,
	"destination_credential_id" text,
	"destination_credential_created_at" timestamp with time zone,
	"destination_credential_expires_at" timestamp with time zone,
	"options" jsonb NOT NULL,
	"status" text NOT NULL,
	"phase" text,
	"blocked_reason" text,
	"error_code" text,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"folders_total" integer DEFAULT 0 NOT NULL,
	"messages_total" integer DEFAULT 0 NOT NULL,
	"bytes_total" bigint DEFAULT 0 NOT NULL,
	"messages_done" integer DEFAULT 0 NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"too_large" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"run_after" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sync_until" timestamp with time zone,
	"last_pass_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"credentials_wiped_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	CONSTRAINT "mail_import_requested_as" CHECK ("mail_import"."requested_as" in ('own', 'admin')),
	CONSTRAINT "mail_import_source_kind" CHECK ("mail_import"."source_kind" in ('imap_password')),
	CONSTRAINT "mail_import_source_port" CHECK ("mail_import"."source_port" in (993, 143)),
	CONSTRAINT "mail_import_status" CHECK ("mail_import"."status" in ('queued', 'running', 'paused', 'blocked', 'syncing', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "mail_import_phase" CHECK ("mail_import"."phase" is null or "mail_import"."phase" in ('verifying', 'copying')),
	CONSTRAINT "mail_import_blocked_reason" CHECK ("mail_import"."blocked_reason" is null or "mail_import"."blocked_reason" in ('quota_full', 'source_auth', 'source_unreachable', 'source_certificate', 'source_tls_required', 'destination_credential', 'mailbox_unavailable')),
	CONSTRAINT "mail_import_wiped" CHECK ("mail_import"."status" not in ('completed', 'cancelled', 'failed') or ("mail_import"."source_secret" is null and "mail_import"."destination_secret" is null and "mail_import"."source_username" is null and "mail_import"."credentials_wiped_at" is not null)),
	CONSTRAINT "mail_import_host_length" CHECK (char_length("mail_import"."source_host") between 1 and 253),
	CONSTRAINT "mail_import_counters" CHECK ("mail_import"."messages_done" >= 0 and "mail_import"."duplicates" >= 0 and "mail_import"."too_large" >= 0 and "mail_import"."failed" >= 0 and "mail_import"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_import_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" text,
	"rows" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_import_batch_rows" CHECK ("mail_import_batch"."rows" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mail_import_folder" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"role" text,
	"source_path" text,
	"uidvalidity" bigint,
	"last_uid" bigint DEFAULT 0 NOT NULL,
	"messages_total" integer DEFAULT 0 NOT NULL,
	"messages_done" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"too_large" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mail_import_folder_role" CHECK ("mail_import_folder"."role" is null or "mail_import_folder"."role" in ('inbox', 'sent', 'drafts', 'junk', 'trash', 'archive', 'all')),
	CONSTRAINT "mail_import_folder_status" CHECK ("mail_import_folder"."status" in ('pending', 'copying', 'done', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "mail_import" ADD CONSTRAINT "mail_import_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_import" ADD CONSTRAINT "mail_import_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_import" ADD CONSTRAINT "mail_import_batch_id_mail_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."mail_import_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_import" ADD CONSTRAINT "mail_import_requested_by_auth_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_import_batch" ADD CONSTRAINT "mail_import_batch_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_import_batch" ADD CONSTRAINT "mail_import_batch_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_import_folder" ADD CONSTRAINT "mail_import_folder_import_id_mail_import_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."mail_import"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_import_live_mailbox_idx" ON "mail_import" USING btree ("mailbox_id") WHERE "mail_import"."status" not in ('completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE INDEX "mail_import_due_idx" ON "mail_import" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "mail_import_account_idx" ON "mail_import" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_import_batch_idx" ON "mail_import" USING btree ("batch_id") WHERE "mail_import"."batch_id" is not null;--> statement-breakpoint
CREATE INDEX "mail_import_batch_account_idx" ON "mail_import_batch" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_import_folder_import_idx" ON "mail_import_folder" USING btree ("import_id","created_at");