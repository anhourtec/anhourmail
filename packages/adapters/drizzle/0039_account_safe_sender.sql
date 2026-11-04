CREATE TABLE "account_safe_sender" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"entry" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_safe_sender_entry_length" CHECK (char_length("account_safe_sender"."entry") BETWEEN 3 AND 254)
);
--> statement-breakpoint
ALTER TABLE "account_safe_sender" ADD CONSTRAINT "account_safe_sender_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_safe_sender" ADD CONSTRAINT "account_safe_sender_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_safe_sender_entry_idx" ON "account_safe_sender" USING btree ("account_id","entry");