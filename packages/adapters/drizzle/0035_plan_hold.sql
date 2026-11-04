CREATE TABLE "plan_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receive_until" timestamp with time zone,
	CONSTRAINT "plan_hold_subject_type" CHECK ("plan_hold"."subject_type" in ('mailbox', 'domain', 'alias')),
	CONSTRAINT "plan_hold_receive_until" CHECK ("plan_hold"."receive_until" is null or "plan_hold"."subject_type" = 'mailbox')
);
--> statement-breakpoint
ALTER TABLE "plan_hold" ADD CONSTRAINT "plan_hold_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_hold_subject_idx" ON "plan_hold" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "plan_hold_account_idx" ON "plan_hold" USING btree ("account_id");