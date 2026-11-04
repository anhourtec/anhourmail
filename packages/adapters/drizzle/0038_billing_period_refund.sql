ALTER TABLE "account_billing" ADD COLUMN "period_paid_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_billing" ADD COLUMN "self_service_refund_at" timestamp with time zone;