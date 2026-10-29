CREATE TABLE "webmail_signature" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"default_new" boolean DEFAULT false NOT NULL,
	"default_reply" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webmail_signature_name_length" CHECK (char_length("webmail_signature"."name") BETWEEN 1 AND 32),
	CONSTRAINT "webmail_signature_size" CHECK (char_length("webmail_signature"."html") <= 307200 AND char_length("webmail_signature"."text") <= 10000)
);
--> statement-breakpoint
ALTER TABLE "webmail_preference" ADD COLUMN "signatures_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webmail_signature" ADD CONSTRAINT "webmail_signature_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webmail_signature" ADD CONSTRAINT "webmail_signature_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webmail_signature_name_idx" ON "webmail_signature" USING btree ("mailbox_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "webmail_signature_default_new_idx" ON "webmail_signature" USING btree ("mailbox_id") WHERE "webmail_signature"."default_new";--> statement-breakpoint
CREATE UNIQUE INDEX "webmail_signature_default_reply_idx" ON "webmail_signature" USING btree ("mailbox_id") WHERE "webmail_signature"."default_reply";