CREATE TABLE "avatar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"mailbox_id" uuid,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avatar_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "avatar_mailbox_id_unique" UNIQUE("mailbox_id"),
	CONSTRAINT "avatar_one_owner" CHECK (num_nonnulls("avatar"."user_id", "avatar"."mailbox_id") = 1),
	CONSTRAINT "avatar_size" CHECK ("avatar"."byte_size" > 0 AND "avatar"."byte_size" <= 262144 AND octet_length("avatar"."data") = "avatar"."byte_size")
);
--> statement-breakpoint
ALTER TABLE "avatar" ADD CONSTRAINT "avatar_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avatar" ADD CONSTRAINT "avatar_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;