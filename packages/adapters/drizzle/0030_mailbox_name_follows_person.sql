-- Custom data migration: a mailbox's sender name now follows its person's name unless an admin set another
-- (`mailbox.display_name` null = follow; docs/internal/04-data-model.md "Names"). "Add a user" and "Make this a user"
-- used to copy the person's name into the mailbox, so a mailbox whose display name is exactly its person's name is
-- turned into one that follows it. What it sends as is unchanged; a different name stays as the admin's custom one.
UPDATE "mailbox" AS m
SET "display_name" = NULL
FROM "auth_user" AS u
WHERE m."user_id" = u."id"
  AND m."display_name" IS NOT NULL
  AND btrim(m."display_name") = btrim(u."name");
