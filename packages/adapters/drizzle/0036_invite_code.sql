CREATE TABLE "invite_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"grants_signup" boolean DEFAULT false NOT NULL,
	"comp_plan" text,
	"comp_days" integer,
	"email" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_by" text,
	"redeemed_account_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "invite_code_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invite_code_grants" CHECK ("invite_code"."grants_signup" or "invite_code"."comp_plan" is not null),
	CONSTRAINT "invite_code_comp_plan" CHECK ("invite_code"."comp_plan" is null or "invite_code"."comp_plan" in ('plus', 'supporter')),
	CONSTRAINT "invite_code_comp" CHECK (("invite_code"."comp_plan" is null) = ("invite_code"."comp_days" is null)),
	CONSTRAINT "invite_code_comp_days" CHECK ("invite_code"."comp_days" is null or "invite_code"."comp_days" between 1 and 365),
	CONSTRAINT "invite_code_label" CHECK (char_length("invite_code"."label") <= 200),
	CONSTRAINT "invite_code_email" CHECK ("invite_code"."email" is null or "invite_code"."email" = lower("invite_code"."email")),
	CONSTRAINT "invite_code_expiry" CHECK ("invite_code"."expires_at" > "invite_code"."created_at")
);
--> statement-breakpoint
ALTER TABLE "invite_code" ADD CONSTRAINT "invite_code_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code" ADD CONSTRAINT "invite_code_redeemed_by_auth_user_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code" ADD CONSTRAINT "invite_code_redeemed_account_id_customer_account_id_fk" FOREIGN KEY ("redeemed_account_id") REFERENCES "public"."customer_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code" ADD CONSTRAINT "invite_code_revoked_by_auth_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_code_created_idx" ON "invite_code" USING btree ("created_at");