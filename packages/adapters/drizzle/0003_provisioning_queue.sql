CREATE TABLE "provisioning_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"run_after" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_domain" ADD COLUMN "stalwart_id" text;--> statement-breakpoint
ALTER TABLE "customer_domain" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "provisioning_job_ready_idx" ON "provisioning_job" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "provisioning_job_subject_idx" ON "provisioning_job" USING btree ("kind","subject_id");