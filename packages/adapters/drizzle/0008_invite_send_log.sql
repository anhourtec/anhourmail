CREATE TABLE "invite_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"invite_id" uuid,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite_send" ADD CONSTRAINT "invite_send_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_send_account_at_idx" ON "invite_send" USING btree ("account_id","sent_at");