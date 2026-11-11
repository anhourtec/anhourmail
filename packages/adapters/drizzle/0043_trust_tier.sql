ALTER TABLE "customer_account" ADD COLUMN "trust_tier" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "trust_tier_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "trust_tier_source" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "trust_reason" text;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "trust_note" text;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "trust_set_by" text;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "last_restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "sending_restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "sending_restricted_reason" text;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "sending_restricted_note" text;--> statement-breakpoint
ALTER TABLE "mailbox" ADD COLUMN "sending_restricted_by" text;--> statement-breakpoint
CREATE INDEX "customer_account_trust_promote_idx" ON "customer_account" USING btree ("trust_tier","created_at") WHERE "customer_account"."trust_tier" = 'new';--> statement-breakpoint
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_trust_tier" CHECK ("customer_account"."trust_tier" in ('new', 'standard', 'trusted', 'restricted'));--> statement-breakpoint
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_trust_tier_source" CHECK ("customer_account"."trust_tier_source" in ('default', 'automatic', 'billing', 'staff'));--> statement-breakpoint
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_trust_reason" CHECK ("customer_account"."trust_reason" is null or "customer_account"."trust_reason" in ('spam', 'abuse', 'phishing', 'payment', 'legal', 'other'));--> statement-breakpoint
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_trust_note" CHECK ("customer_account"."trust_note" is null or char_length("customer_account"."trust_note") between 1 and 2000);--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_sending_restricted" CHECK (("mailbox"."sending_restricted_at" is null) = ("mailbox"."sending_restricted_reason" is null));--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_sending_restricted_reason" CHECK ("mailbox"."sending_restricted_reason" is null or "mailbox"."sending_restricted_reason" in ('spam', 'abuse', 'phishing', 'payment', 'legal', 'other'));--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_sending_restricted_note" CHECK ("mailbox"."sending_restricted_note" is null or char_length("mailbox"."sending_restricted_note") between 1 and 2000);