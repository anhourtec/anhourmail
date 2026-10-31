-- Custom data migration: customer mailboxes may no longer use the mail server's file storage or read share
-- notifications (`FILE_STORAGE_PERMISSIONS` and the `jmapShareNotification*` denials in packages/stalwart-client).
-- Denials reach an existing account only when its permissions are written again, so queue one `mailbox.ensure` for
-- every mailbox that has an account on the mail server, whatever its status:
-- - active: writes the customer lockdown;
-- - suspended, deleting: writes the suspension (a superset), keeping it in force; a deleting mailbox past its grace
--   period is left to the purge (the job does nothing);
-- - failed: the job is the retry of what failed (it ends active, or failed again); a resume that is still waiting for
--   an administrator's password keeps waiting and turns nothing on (`mailbox.ensure`);
-- - provisioning: it already has a queued ensure (a resume or restore; its account is suspended until then); one more
--   run of the same sync changes nothing.
-- The hourly reconciler also finds any account left without the lock (`sieveLockMismatch`). Idempotent in effect.
INSERT INTO "provisioning_job" ("id", "kind", "subject_id", "status", "attempts", "run_after")
SELECT gen_random_uuid(), 'mailbox.ensure', m."id"::text, 'queued', 0, now()
FROM "mailbox" AS m
WHERE m."stalwart_id" IS NOT NULL;
