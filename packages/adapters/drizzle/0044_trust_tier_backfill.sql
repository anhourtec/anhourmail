-- Custom data migration (ADR-0034 §1, migration A): every account's sending tier on the account row, moved off the
-- per-person `user_profile.trust_tier` (nothing has written that column, so in practice every person is `new`).
-- Only rows still at the defaults (source `default`) are touched, so a re-run, or a row the app already set, is left
-- as it is. First match wins:
--   1. an owner whose person tier is `restricted`               → `restricted`, source `staff`;
--   2. the platform staff account (it holds a mailbox of a person with a platform role) → `standard`, source `staff`;
--   3. billing state `active` or `past_due` (a paid plan)        → `standard`, source `billing`;
--   4. everything else stays `new`, source `default`.
UPDATE "customer_account" AS a
SET "trust_tier" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "account_membership" AS m
        JOIN "user_profile" AS p ON p."user_id" = m."user_id"
        WHERE m."account_id" = a."id" AND m."role" = 'owner' AND p."trust_tier" = 'restricted'
      ) THEN 'restricted'
      ELSE 'standard'
    END,
    "trust_tier_source" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "account_membership" AS m
        JOIN "user_profile" AS p ON p."user_id" = m."user_id"
        WHERE m."account_id" = a."id" AND m."role" = 'owner' AND p."trust_tier" = 'restricted'
      ) THEN 'staff'
      WHEN EXISTS (
        SELECT 1 FROM "mailbox" AS mb
        JOIN "platform_role_assignment" AS r ON r."user_id" = mb."user_id"
        WHERE mb."account_id" = a."id"
      ) THEN 'staff'
      ELSE 'billing'
    END,
    "trust_tier_since" = now()
WHERE a."trust_tier_source" = 'default'
  AND (
    EXISTS (
      SELECT 1 FROM "account_membership" AS m
      JOIN "user_profile" AS p ON p."user_id" = m."user_id"
      WHERE m."account_id" = a."id" AND m."role" = 'owner' AND p."trust_tier" = 'restricted'
    )
    OR EXISTS (
      SELECT 1 FROM "mailbox" AS mb
      JOIN "platform_role_assignment" AS r ON r."user_id" = mb."user_id"
      WHERE mb."account_id" = a."id"
    )
    OR EXISTS (
      SELECT 1 FROM "account_billing" AS b
      WHERE b."account_id" = a."id" AND b."state" IN ('active', 'past_due')
    )
  );
--> statement-breakpoint
-- `last_restricted_at`: an account restricted above, suspended now (or one of its people), or staff-suspended before
-- and since lifted (the `trust.suspended` entries in its own audit log; a person's suspension is copied into each of
-- their accounts' logs), so the promotion job never promotes it automatically. The latest of those moments.
UPDATE "customer_account" AS a
SET "last_restricted_at" = x."at"
FROM (
  SELECT c."id", GREATEST(
      CASE WHEN c."trust_tier" = 'restricted' THEN now() END,
      c."suspended_at",
      (
        SELECT max(p."suspended_at") FROM "account_membership" AS m
        JOIN "user_profile" AS p ON p."user_id" = m."user_id"
        WHERE m."account_id" = c."id"
      ),
      (
        SELECT max(l."at") FROM "audit_log" AS l
        WHERE l."scope" = 'account:' || c."id"::text AND l."action" = 'trust.suspended' AND l."result" = 'success'
      )
    ) AS "at"
  FROM "customer_account" AS c
  WHERE c."last_restricted_at" IS NULL
) AS x
WHERE a."id" = x."id" AND x."at" IS NOT NULL;
