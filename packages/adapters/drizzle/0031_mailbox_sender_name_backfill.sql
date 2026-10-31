-- Custom data migration: the mail server's account description is now the mailbox's sender name — its custom display
-- name, else its person's name (core `people/names.ts`). Mailboxes created before this were sent no description when
-- they had a person but no display name, so queue one `mailbox.ensure` for each mailbox on the mail server that is
-- active or suspended (the job keeps a suspension in force; deleting or still-provisioning mailboxes get their own).
-- Idempotent in effect: a mailbox that already has a queued ensure just gets one more run of the same sync.
INSERT INTO "provisioning_job" ("id", "kind", "subject_id", "status", "attempts", "run_after")
SELECT gen_random_uuid(), 'mailbox.ensure', m."id"::text, 'queued', 0, now()
FROM "mailbox" AS m
WHERE m."stalwart_id" IS NOT NULL
  AND m."status" IN ('active', 'suspended')
  AND (m."user_id" IS NOT NULL OR m."display_name" IS NOT NULL);
