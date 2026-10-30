ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_account_id_unique" UNIQUE("account_id","id");--> statement-breakpoint
CREATE TABLE "mailbox_delegation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"grantee_user_id" text NOT NULL,
	"right" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_delegation_right" CHECK ("mailbox_delegation"."right" in ('full_access', 'send_as', 'send_on_behalf'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_delegation" ADD CONSTRAINT "mailbox_delegation_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_delegation" ADD CONSTRAINT "mailbox_delegation_mailbox_fk" FOREIGN KEY ("account_id","mailbox_id") REFERENCES "public"."mailbox"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_delegation" ADD CONSTRAINT "mailbox_delegation_membership_fk" FOREIGN KEY ("account_id","grantee_user_id") REFERENCES "public"."account_membership"("account_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_delegation_unique_idx" ON "mailbox_delegation" USING btree ("mailbox_id","grantee_user_id","right");--> statement-breakpoint
CREATE INDEX "mailbox_delegation_grantee_idx" ON "mailbox_delegation" USING btree ("account_id","grantee_user_id");