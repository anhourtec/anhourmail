CREATE TABLE "billing_catalogue" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"drift" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"drift_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_catalogue_one_row" CHECK ("billing_catalogue"."id" = 1)
);
