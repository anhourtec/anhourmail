CREATE TABLE "account_billing" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'free' NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_source" text DEFAULT 'none' NOT NULL,
	"paid_plan" text,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"currency" text,
	"plan_amount_minor" integer,
	"storage_blocks" integer DEFAULT 0 NOT NULL,
	"extra_mailboxes" integer DEFAULT 0 NOT NULL,
	"period_paid_storage_blocks" integer DEFAULT 0 NOT NULL,
	"period_paid_extra_mailboxes" integer DEFAULT 0 NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"restricted_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"lapsed_at" timestamp with time zone,
	"comp_until" timestamp with time zone,
	"last_invoice_id" text,
	"last_invoice_status" text,
	"checkout_pending_until" timestamp with time zone,
	"address_ceiling_override" integer,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_billing_provider_customer_id_unique" UNIQUE("provider_customer_id"),
	CONSTRAINT "account_billing_provider_subscription_id_unique" UNIQUE("provider_subscription_id"),
	CONSTRAINT "account_billing_state" CHECK ("account_billing"."state" in ('free', 'active', 'past_due', 'restricted', 'lapsed')),
	CONSTRAINT "account_billing_plan_source" CHECK ("account_billing"."plan_source" in ('none', 'stripe', 'comp', 'staff')),
	CONSTRAINT "account_billing_paid_plan" CHECK ("account_billing"."paid_plan" is null or "account_billing"."paid_plan" in ('plus', 'supporter')),
	CONSTRAINT "account_billing_currency" CHECK ("account_billing"."currency" is null or "account_billing"."currency" in ('USD', 'CAD')),
	CONSTRAINT "account_billing_quantities" CHECK ("account_billing"."storage_blocks" >= 0 and "account_billing"."extra_mailboxes" >= 0 and "account_billing"."period_paid_storage_blocks" >= 0 and "account_billing"."period_paid_extra_mailboxes" >= 0),
	CONSTRAINT "account_billing_amount" CHECK ("account_billing"."plan_amount_minor" is null or "account_billing"."plan_amount_minor" >= 0),
	CONSTRAINT "account_billing_invoice_status" CHECK ("account_billing"."last_invoice_status" is null or "account_billing"."last_invoice_status" in ('paid', 'open', 'uncollectible', 'void')),
	CONSTRAINT "account_billing_ceiling" CHECK ("account_billing"."address_ceiling_override" is null or "account_billing"."address_ceiling_override" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"account_id" uuid,
	"object_id" text NOT NULL,
	"provider_created_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "billing_event_provider_event_id_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "billing_event_status" CHECK ("billing_event"."status" in ('queued', 'processed', 'orphan', 'dismissed')),
	CONSTRAINT "billing_event_orphan" CHECK (("billing_event"."account_id" is null) = ("billing_event"."status" in ('orphan', 'dismissed')))
);
--> statement-breakpoint
ALTER TABLE "account_billing" ADD CONSTRAINT "account_billing_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_event" ADD CONSTRAINT "billing_event_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_billing_state_idx" ON "account_billing" USING btree ("state","state_since");--> statement-breakpoint
CREATE INDEX "account_billing_sync_idx" ON "account_billing" USING btree ("last_synced_at") WHERE "account_billing"."provider_customer_id" is not null;--> statement-breakpoint
CREATE INDEX "billing_event_pending_idx" ON "billing_event" USING btree ("account_id","provider_created_at") WHERE "billing_event"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "billing_event_status_idx" ON "billing_event" USING btree ("status","received_at");