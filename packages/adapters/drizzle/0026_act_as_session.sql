CREATE TABLE "act_as_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" text NOT NULL,
	"staff_role" text NOT NULL,
	"auth_session_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "act_as_session_reason_length" CHECK (char_length("act_as_session"."reason") between 1 and 500),
	CONSTRAINT "act_as_session_window" CHECK ("act_as_session"."expires_at" > "act_as_session"."started_at")
);
--> statement-breakpoint
ALTER TABLE "act_as_session" ADD CONSTRAINT "act_as_session_staff_user_id_auth_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "act_as_session" ADD CONSTRAINT "act_as_session_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "act_as_session_staff_idx" ON "act_as_session" USING btree ("staff_user_id","auth_session_id");--> statement-breakpoint
CREATE INDEX "act_as_session_open_idx" ON "act_as_session" USING btree ("expires_at") WHERE "act_as_session"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "act_as_session_one_open_idx" ON "act_as_session" USING btree ("staff_user_id") WHERE "act_as_session"."ended_at" is null;