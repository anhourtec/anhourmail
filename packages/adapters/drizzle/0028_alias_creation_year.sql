-- Custom data migration: the alias creation counts now cover a rolling year (Free's yearly cap). Until now only
-- today's and yesterday's counts were kept, so seed the year from the aliases that still exist (creations whose
-- alias was since deleted are gone and can't be recovered). GREATEST keeps a higher count already recorded for a day.
INSERT INTO "alias_creation_day" ("account_id", "day", "kind", "count")
SELECT "account_id", ("created_at" AT TIME ZONE 'UTC')::date, "kind", count(*)::int
FROM "mail_alias"
WHERE "created_at" >= now() - interval '366 days'
GROUP BY 1, 2, 3
ON CONFLICT ("account_id", "day", "kind") DO UPDATE SET "count" = GREATEST("alias_creation_day"."count", EXCLUDED."count");
