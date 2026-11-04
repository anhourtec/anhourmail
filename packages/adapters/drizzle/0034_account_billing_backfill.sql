-- Custom data migration (ADR-0029 §11): one billing row per existing account. Free accounts start `free` with no plan
-- source; accounts already on Plus or Supporter (seeded or set by staff before billing existed) become an `active`
-- staff grant with no end. Idempotent (ON CONFLICT DO NOTHING): rows the app already wrote are left as they are, and
-- accounts created later get their row in the create's own transaction.
INSERT INTO "account_billing" ("account_id", "state", "state_since", "plan_source", "paid_plan", "updated_at")
SELECT a."id",
       CASE WHEN a."plan" IN ('plus', 'supporter') THEN 'active' ELSE 'free' END,
       now(),
       CASE WHEN a."plan" IN ('plus', 'supporter') THEN 'staff' ELSE 'none' END,
       CASE WHEN a."plan" IN ('plus', 'supporter') THEN a."plan" ELSE NULL END,
       now()
FROM "customer_account" AS a
ON CONFLICT ("account_id") DO NOTHING;
