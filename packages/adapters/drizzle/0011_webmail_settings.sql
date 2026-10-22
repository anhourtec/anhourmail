CREATE TABLE "forwarding_target" (
	"mailbox_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL,
	"sends_in_window" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webmail_preference" (
	"mailbox_id" uuid PRIMARY KEY NOT NULL,
	"prefs" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forwarding_target" ADD CONSTRAINT "forwarding_target_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_target" ADD CONSTRAINT "forwarding_target_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webmail_preference" ADD CONSTRAINT "webmail_preference_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forwarding_target_token_idx" ON "forwarding_target" USING btree ("token_hash");