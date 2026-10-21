ALTER TABLE "customer_domain" DROP CONSTRAINT "customer_domain_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "customer_domain_account_name_idx" ON "customer_domain" USING btree ("account_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_domain_claimed_name_idx" ON "customer_domain" USING btree ("name") WHERE status <> 'pending_dns';