CREATE TABLE "account_deletion" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	CONSTRAINT "account_deletion_window" CHECK ("account_deletion"."delete_after" > "account_deletion"."requested_at")
);
--> statement-breakpoint
CREATE TABLE "data_export" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"requested_by" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"archive" "bytea",
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	CONSTRAINT "data_export_kind" CHECK ("data_export"."kind" in ('account', 'personal')),
	CONSTRAINT "data_export_account" CHECK (("data_export"."kind" = 'account') = ("data_export"."account_id" is not null)),
	CONSTRAINT "data_export_archive" CHECK ("data_export"."archive" is null or "data_export"."status" = 'ready')
);
--> statement-breakpoint
ALTER TABLE "account_deletion" ADD CONSTRAINT "account_deletion_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export" ADD CONSTRAINT "data_export_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export" ADD CONSTRAINT "data_export_requested_by_auth_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_deletion_due_idx" ON "account_deletion" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX "data_export_requester_idx" ON "data_export" USING btree ("requested_by","kind","created_at");--> statement-breakpoint
CREATE INDEX "data_export_waiting_idx" ON "data_export" USING btree ("created_at") WHERE "data_export"."status" in ('queued', 'building');--> statement-breakpoint
CREATE INDEX "data_export_expiry_idx" ON "data_export" USING btree ("expires_at") WHERE "data_export"."status" = 'ready';