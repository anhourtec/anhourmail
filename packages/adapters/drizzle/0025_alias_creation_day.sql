CREATE TABLE "alias_creation_day" (
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "alias_creation_day_account_id_day_kind_pk" PRIMARY KEY("account_id","day","kind"),
	CONSTRAINT "alias_creation_day_count" CHECK ("alias_creation_day"."count" > 0)
);
--> statement-breakpoint
ALTER TABLE "alias_creation_day" ADD CONSTRAINT "alias_creation_day_account_id_customer_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;