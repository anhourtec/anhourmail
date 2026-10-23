CREATE TABLE "retired_platform_address" (
	"address" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"retired_at" timestamp with time zone NOT NULL
);
