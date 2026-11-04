CREATE TABLE "webmail_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webmail_template_name_length" CHECK (char_length("webmail_template"."name") BETWEEN 1 AND 64),
	CONSTRAINT "webmail_template_size" CHECK (char_length("webmail_template"."html") <= 65536 AND char_length("webmail_template"."text") <= 20000)
);
--> statement-breakpoint
ALTER TABLE "webmail_template" ADD CONSTRAINT "webmail_template_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webmail_template" ADD CONSTRAINT "webmail_template_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webmail_template_name_idx" ON "webmail_template" USING btree ("mailbox_id",lower("name"));