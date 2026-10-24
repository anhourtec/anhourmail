# Database migrations

Rule 15: every migration is logged here, **newest first**, with its rollback level. Never edit an applied migration. Destructive changes take three steps (add → move data → drop) and happen only after a backup.

## How migrations run

- Schema: `packages/adapters/src/db-postgres/schema.ts`; generated SQL in `packages/adapters/drizzle/`.
- Generate: `npm run db:generate -w @anhourmail/adapters -- --name <what>`. Custom data migration: `drizzle-kit generate --custom --name <what>`.
- Apply: automatically on `apps/web` container start (entrypoint), or `npm run db:migrate`. There are no down migrations.
- Grants that keep `audit_log` append-only are part of the migrations (ADR-0010).

**When did a migration run on a server?**

```sql
select id, hash, to_timestamp(created_at / 1000) from drizzle.__drizzle_migrations order by id;
```

**Back up before a destructive release:**

```sh
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > backup-$(date -u +%Y%m%dT%H%MZ).dump
# restore
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup.dump
```

## Rollback levels

| Level               | Meaning                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| **Safe**            | Additive only (new table, nullable column, index). Older code keeps working.                           |
| **Caution**         | Additive, but older code may meet data it doesn't understand (new enum value, new required behaviour). |
| **Not recommended** | Drops, renames or type changes. Restore the backup instead of rolling back.                            |

## Summary

| #    | Migration                          | Commit      | Date       | Change                                                                                                   | Rollback        |
| ---- | ---------------------------------- | ----------- | ---------- | -------------------------------------------------------------------------------------------------------- | --------------- |
| 0018 | `0018_add_user`                    | uncommitted | 2026-10-24 | `mailbox.display_name`, `mailbox.must_change_password`; `user_profile.must_change_password` + profile    | Safe            |
| 0017 | `0017_staff_suspension`            | uncommitted | 2026-10-23 | `mailbox_staff_hold`; suspension reason, note, time and staff id on `customer_account`, `user_profile`   | Safe            |
| 0016 | `0016_mailbox_storage_used`        | uncommitted | 2026-10-23 | `mailbox.storage_used_bytes`, `mailbox.storage_checked_at` (last storage measurement; sizes only)        | Safe            |
| 0015 | `0015_platform_addresses`          | uncommitted | 2026-10-23 | `retired_platform_address` (platform-domain addresses never reissued to another account)                 | Safe            |
| 0014 | `0014_mailbox_password_grant`      | uncommitted | 2026-10-23 | `mailbox.pending_password_grant` (the web app's HMAC grant for the waiting hash)                         | Safe            |
| 0013 | `0013_mailbox_password`            | uncommitted | 2026-10-23 | `mailbox.pending_password_hash` (argon2id hash waiting for the worker), `mailbox.password_credential_id` | Safe            |
| 0012 | `0012_app_passwords_catch_all`     | uncommitted | 2026-10-22 | `app_password` (metadata only); `customer_domain.catch_all_mailbox_id`                                   | Safe            |
| 0011 | `0011_webmail_settings`            | uncommitted | 2026-10-22 | `webmail_preference` (display choices per mailbox), `forwarding_target` (one confirmed target each)      | Safe            |
| 0010 | `0010_session_sign_in_method`      | uncommitted | 2026-10-22 | `auth_session.sign_in_method` (how the session signed in)                                                | Safe            |
| 0009 | `0009_sign_in_security`            | uncommitted | 2026-10-22 | `auth_two_factor`, `auth_passkey`; `auth_user.two_factor_enabled`; `customer_account.sign_in_policy`     | Safe            |
| 0008 | `0008_invite_send_log`             | uncommitted | 2026-10-22 | `invite_send` table (one row per invite email sent) for the per-account daily cap                        | Safe            |
| 0006 | `0006_remove_waitlist`             | uncommitted | 2026-10-22 | Drop `waitlist_entry`; drop `invite.source`, `invite.waitlist_entry_id`                                  | Not recommended |
| 0005 | `0005_domain_claims`               | uncommitted | 2026-10-21 | Domain names unique per account; across accounts only once claimed (verified)                            | Caution         |
| 0004 | `0004_waitlist_opt_in_and_invites` | `3e75c1f`   | 2026-10-21 | Waitlist double opt-in columns; invite source/waitlist link/acceptance                                   | Safe            |
| 0003 | `0003_provisioning_queue`          | `843be65`   | 2026-10-21 | `provisioning_job` table; `customer_domain.stalwart_id/last_error`, `mailbox.last_error`                 | Safe            |
| 0002 | `0002_user_first_last_name`        | `710e664`   | 2026-10-21 | `auth_user.first_name` (not null, default '') and `last_name`                                            | Safe            |
| 0001 | `0001_audit_append_only`           | `710e664`   | 2026-10-21 | Trigger blocking UPDATE/DELETE/TRUNCATE on `audit_log`                                                   | Caution         |
| 0000 | `0000_init`                        | `710e664`   | 2026-10-21 | Initial control-plane schema (14 tables)                                                                 | Safe            |

## Details

Each migration gets a section in this shape:

```
### 0016_mailbox_storage_used · uncommitted · 2026-10-23 · Safe

- Added: `mailbox.storage_used_bytes` (bigint, nullable), `mailbox.storage_checked_at` (timestamptz, nullable) — written
  by the scheduler's `job:storage-usage` from Stalwart's `usedDiskQuota`; a size only, never anything about the mail.
- Changed: —
- Removed: —
- Data: none. Existing mailboxes read as "not measured yet" until the first run (within 10 minutes).
- Rollback: drop the two columns (the console stops showing storage used; nothing else depends on them).

### 0000_name · `<sha>` · YYYY-MM-DD · <level>
- Added:
- Changed:
- Removed:
- Data:
- Rollback:
```

### 0018_add_user · uncommitted · 2026-10-24 · Safe

- Added: `mailbox.display_name` (sender name, nullable), `mailbox.must_change_password` (bool, default false);
  `user_profile.must_change_password` (bool, default false) and optional profile details `job_title`, `department`,
  `office`, `office_phone`, `mobile_phone`, `street_address`, `city`, `region`, `postal_code`, `country` (text,
  nullable; personal data, removed with the person by the existing cascade).
- Changed: —
- Removed: —
- Data: none. Existing mailboxes and people get no name, no flag and no details.
- Rollback: drop the thirteen columns (the flags and names are lost; nobody is forced to change a password after).

### 0017_staff_suspension · uncommitted · 2026-10-23 · Safe

- Added: `mailbox_staff_hold` (mailbox_id → mailbox, cascade; kind `account` | `person`; pk both) — the mailboxes a
  staff suspension suspended, so lifting resumes exactly those; `customer_account.suspension_reason`,
  `suspension_note` (staff-only), `suspended_at`, `suspended_by`; the same four on `user_profile`.
- Changed: — (`customer_account.status` and `user_profile.suspended` already existed; a suspension sets them).
- Removed: —
- Data: none. Nobody is suspended until staff do it.
- Rollback: lift every suspension first (or accept that held mailboxes stay suspended), then drop the table and the
  eight columns.

### 0015_platform_addresses · uncommitted · 2026-10-23 · Safe

- Added: `retired_platform_address` (address text primary key, account_id uuid not null — deliberately no foreign key,
  retired_at timestamptz not null). Free platform-domain addresses that were in use and are gone are never handed to a
  different account (ADR-0021).
- Changed: —
- Removed: —
- Data: none (starts empty; addresses are retired by the purge and by deleting a masked alias on the platform domain).
- Rollback: drop the table. Older code ignores it; the no-reuse guarantee is lost for anything retired meanwhile, so
  export the rows first if rolling back for real.

### 0014_mailbox_password_grant · uncommitted · 2026-10-23 · Safe

- Added: `mailbox.pending_password_grant` (text, null): `<expiry>.<hex HMAC-SHA256>` made by the web app with
  `MAILBOX_PASSWORD_GRANT_KEY` over `stalwart account id | sha256(pending hash) | expiry`; the worker forwards it and
  the management proxy verifies it (security review run-26 M1). Cleared with the hash. Not a secret on its own (it
  only authorises that exact hash on that account for ≤ 1 hour).
- Changed / Removed / Data: none. Rollback: older code ignores the column (and production then refuses resets at the
  proxy until it is back).

### 0013_mailbox_password · uncommitted · 2026-10-23 · Safe

- Added: `mailbox.pending_password_hash` (text, null): a new mailbox password as a salted argon2id PHC string waiting
  for the worker (set at creation, by an admin's reset or by the person's own change; cleared once Stalwart has it or
  when its job gives up — never the password itself, rule 23). `mailbox.password_credential_id` (text, null): Stalwart's
  id for the mailbox's Password credential as the control plane last set it; the reconciler reports a different one.
- Changed: —
- Removed: —
- Data: none. Existing mailboxes have no recorded id until their next `mailbox.ensure`; run `job:mailbox-backfill`
  after deploying so the reconciler stops reporting them as untracked. Rollback: older code ignores both columns.

### 0012_app_passwords_catch_all · uncommitted · 2026-10-22 · Safe

- Added: `app_password` (`id`, `account_id` → `customer_account` and `mailbox_id` → `mailbox`, both on delete
  cascade; `name`, `protocols text[]`, `credential_id` + `credential_created_at` (Stalwart's id and creation time —
  ids are reused, so both are matched before a revoke), `status` active/revoking, `created_by`, `created_at`; index on
  `mailbox_id`). Metadata only: the secret is never stored (ADR-0020). `customer_domain.catch_all_mailbox_id` (uuid →
  `mailbox`, on delete set null): the domain's catch-all mailbox, null = off.
- Changed: —
- Removed: —
- Data: none (new table empty; every domain's catch-all starts off).
- Rollback: drop the column and the table. App passwords already on the mail server keep working but disappear from
  the console (revoke them on Stalwart first, or they can't be revoked from the console); a catch-all already applied
  stays on the mail server until the domain is next applied (`domain.ensure` resets it).

### 0011_webmail_settings · uncommitted · 2026-10-22 · Safe

- Added: `webmail_preference` (`mailbox_id` primary key → `mailbox` on delete cascade, `prefs jsonb`, `updated_at`):
  the webmail's display preferences per mailbox — closed choices only, normalised on read, no mail content and no
  addresses. `forwarding_target` (`mailbox_id` primary key → `mailbox`, `account_id` → `customer_account`, both on
  delete cascade; `address`, `status` pending/confirmed, `token_hash` unique (sha256 of the confirmation token, null
  once confirmed), `expires_at`, `confirmed_at`, `requested_at`, `sends_in_window`, `window_started_at`).
- Changed: —
- Removed: —
- Data: none (new tables; no rows until someone changes a webmail setting or asks to forward).
- Rollback: drop both tables. Preferences fall back to defaults; forwarding rules already in the mail server keep
  working until the person changes them, but a pending confirmation link stops working.

### 0010_session_sign_in_method · uncommitted · 2026-10-22 · Safe

- Added: `auth_session.sign_in_method text` (nullable): `password`, `password+trusted_device`, `password+totp`,
  `password+recovery_code` or `passkey`, written when better-auth creates a session (`signInMethodFor`).
- Changed: —
- Removed: —
- Data: none. Existing sessions have null and count as `password`: under an account requirement they are ended on
  their next request and the person signs in again.
- Rollback: drop the column; requirements then can't tell how a session signed in (older code never reads it).

### 0009_sign_in_security · uncommitted · 2026-10-22 · Safe

- Added: `auth_two_factor` (one row per person, unique `user_id` → `auth_user` ON DELETE CASCADE; `secret` is the
  two-factor plugin's encrypted TOTP secret sealed again with the key ring, `backup_codes` a JSON list of SHA-256
  recovery-code hashes, `verified`, `failed_verification_count`, `locked_until`, `created_at`); `auth_passkey`
  (WebAuthn public keys: `credential_id` unique, `public_key`, `counter` bigint, `device_type`, `backed_up`,
  `transports`, `aaguid`, `name`, `created_at`; index on `user_id`, ON DELETE CASCADE);
  `auth_user.two_factor_enabled boolean not null default false`; `customer_account.sign_in_policy text not null
default 'none'` (`none` | `two_factor` | `passkey`).
- Changed: —
- Removed: —
- Data: none (everyone starts with no factors and every account with no requirement).
- Rollback: drop the two tables and two columns. Everyone loses their authenticator app and passkeys (they sign in with
  the password alone) and account requirements are forgotten; older code never reads them.

### 0008_invite_send_log · uncommitted · 2026-10-22 · Safe

- Added: `invite_send` (id, account_id → `customer_account` ON DELETE CASCADE, invite_id, sent_at) with index
  `invite_send_account_at_idx` (account_id, sent_at). No email address or token is stored.
- Changed: —
- Removed: —
- Data: none (the daily cap starts counting from empty).
- Rollback: drop the table and index; the daily invite-email cap stops working (older code never reads it).

### 0007_mailbox_lifecycle · uncommitted · 2026-10-22 · Safe

- Added: `mailbox.purge_after timestamptz` (nullable; set while a mailbox is `deleting`), partial index
  `mailbox_purge_idx` on `purge_after` `where status = 'deleting'` (the hourly purge's lookup).
- Changed: `mailbox.status` gains the value `deleting` (text column; no constraint change).
- Removed: —
- Data: none (existing rows get `purge_after = null`).
- Rollback: first make sure no row is `deleting` (restore them, or let the purge finish), then drop the index and
  the column. Older code reads `deleting` rows as `provisioning`.

### 0006_remove_waitlist · uncommitted · 2026-10-22 · Not recommended

- Added: —
- Changed: —
- Removed: table `waitlist_entry` (with its indexes); columns `invite.source` and `invite.waitlist_entry_id`. The
  maintainer removed the waitlist from the product (2026-10-22); there was no production data yet.
- Data: dev/demo waitlist rows and their attribution are deleted. In a deployment holding real sign-ups, export
  them first (this migration is the drop step of add → move → drop; the move step is the maintainer's export).
- Rollback: restore from the pre-migration backup; re-creating the empty table from 0004 is possible but the data
  is gone.

### 0005_domain_claims · `d628175` · 2026-10-21 · Caution

- Added: unique index `customer_domain_account_name_idx` (account_id, name); partial unique index
  `customer_domain_claimed_name_idx` on name where `status <> 'pending_dns'`.
- Changed: —
- Removed: the global unique constraint `customer_domain_name_unique`.
- Data: none. Older code may now meet two pending rows with the same name in different accounts.
- Rollback: drop both indexes and re-add the unique constraint (fails if two accounts hold the same pending name —
  delete the unverified duplicates first).

### 0004_waitlist_opt_in_and_invites · `3e75c1f` · 2026-10-21 · Safe

- Added: `waitlist_entry.confirm_token_hash` (unique index), `confirm_expires_at`, `confirm_sent_at`, `confirmed_at`;
  `invite.source` (default `staff`), `invite.waitlist_entry_id`, `invite.accepted_user_id`, `invite.accepted_at`.
- Changed: —
- Removed: —
- Data: none. Existing waitlist rows stay `pending` with no token (a re-join issues one).
- Rollback: drop the columns and the index (outstanding confirmation and invite links stop working).

### 0003_provisioning_queue · `843be65` · 2026-10-21 · Safe

- Added: `provisioning_job` (kind, subject_id, status, attempts, last_error, run_after, locked_at) with indexes
  on (status, run_after) and (kind, subject_id); `customer_domain.stalwart_id`, `customer_domain.last_error`,
  `mailbox.last_error`.
- Changed: —
- Removed: —
- Data: none.
- Rollback: drop the table and columns (queued jobs are lost; desired state is unaffected and can be re-enqueued).

### 0002_user_first_last_name · `710e664` · 2026-10-21 · Safe

- Added: `auth_user.first_name text not null default ''`, `auth_user.last_name text`. `name` is the display name.
- Changed: —
- Removed: —
- Data: existing rows get `first_name = ''` (seeded/dev users only).
- Rollback: drop the two columns.

### 0001_audit_append_only · `710e664` · 2026-10-21 · Caution

- Added: `audit_log_append_only()` function and two triggers on `audit_log` (row-level BEFORE UPDATE OR DELETE,
  statement-level BEFORE TRUNCATE) that raise `insufficient_privilege` — the table is append-only for every role,
  owner included (ADR-0010).
- Changed: —
- Removed: —
- Data: none.
- Rollback: drop the triggers and function. Only do it for an audited retention purge (`audit.md` "Retention"),
  then re-apply.

### 0000_init · `710e664` · 2026-10-21 · Safe

- Added: better-auth tables (`auth_user`, `auth_session`, `auth_account`, `auth_verification`);
  `platform_role_assignment`, `user_profile`, `customer_account`, `account_membership`, `invite`, `waitlist_entry`
  (unique `email_hash`), `customer_domain`, `mailbox`, `mail_alias`, `audit_log` (unique `scope, seq`).
- Changed: —
- Removed: —
- Data: none.
- Rollback: drop the schema on a fresh database (nothing older to return to).
