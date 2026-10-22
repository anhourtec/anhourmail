CREATE TABLE "app_password" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocols" text[] NOT NULL,
	"credential_id" text NOT NULL,
	"credential_created_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_domain" ADD COLUMN "catch_all_mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "app_password" ADD CONSTRAINT "app_password_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_password" ADD CONSTRAINT "app_password_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_password_mailbox_idx" ON "app_password" USING btree ("mailbox_id");--> statement-breakpoint
ALTER TABLE "customer_domain" ADD CONSTRAINT "customer_domain_catch_all_mailbox_id_mailbox_id_fk" FOREIGN KEY ("catch_all_mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE set null ON UPDATE no action;