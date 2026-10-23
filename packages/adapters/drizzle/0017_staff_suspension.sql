CREATE TABLE "mailbox_staff_hold" (
	"mailbox_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_staff_hold_mailbox_id_kind_pk" PRIMARY KEY("mailbox_id","kind")
);
--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "suspension_note" text;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_account" ADD COLUMN "suspended_by" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "suspension_note" text;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_profile" ADD COLUMN "suspended_by" text;--> statement-breakpoint
ALTER TABLE "mailbox_staff_hold" ADD CONSTRAINT "mailbox_staff_hold_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;