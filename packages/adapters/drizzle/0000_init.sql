CREATE TABLE "account_membership" (
	"account_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_membership_account_id_user_id_pk" PRIMARY KEY("account_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"actor_role" text,
	"actor_account_id" text,
	"on_behalf_of" jsonb,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_label" text,
	"result" text NOT NULL,
	"error_code" text,
	"request_id" text,
	"ip" text,
	"user_agent" text,
	"meta" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_domain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending_dns' NOT NULL,
	"verify_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_domain_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"account_id" uuid,
	"role" text,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mail_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_alias_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "mailbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" text,
	"address" text NOT NULL,
	"stalwart_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "platform_role_assignment" (
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_role_assignment_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"user_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'free' NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"trust_tier" text DEFAULT 'new' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_hash" text NOT NULL,
	"community" text,
	"ref" text,
	"utm" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_membership" ADD CONSTRAINT "account_membership_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_membership" ADD CONSTRAINT "account_membership_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_domain" ADD CONSTRAINT "customer_domain_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_alias" ADD CONSTRAINT "mail_alias_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_alias" ADD CONSTRAINT "mail_alias_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_assignment" ADD CONSTRAINT "platform_role_assignment_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_membership_user_idx" ON "account_membership" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_scope_seq_idx" ON "audit_log" USING btree ("scope","seq");--> statement-breakpoint
CREATE INDEX "audit_log_scope_at_idx" ON "audit_log" USING btree ("scope","at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_domain_account_idx" ON "customer_domain" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "invite_email_idx" ON "invite" USING btree ("email");--> statement-breakpoint
CREATE INDEX "mail_alias_mailbox_idx" ON "mail_alias" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mailbox_account_idx" ON "mailbox" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entry_email_hash_idx" ON "waitlist_entry" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "waitlist_entry_created_idx" ON "waitlist_entry" USING btree ("created_at");