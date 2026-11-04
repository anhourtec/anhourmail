CREATE TABLE "billing_dispute" (
	"dispute_id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_dispute_status" CHECK ("billing_dispute"."status" in ('open', 'won', 'lost', 'warning_closed', 'cleared'))
);
--> statement-breakpoint
ALTER TABLE "billing_dispute" ADD CONSTRAINT "billing_dispute_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_dispute_account_idx" ON "billing_dispute" USING btree ("account_id","opened_at");