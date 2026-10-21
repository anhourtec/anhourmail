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

| #    | Migration                          | Commit      | Date       | Change                                                                                   | Rollback |
| ---- | ---------------------------------- | ----------- | ---------- | ---------------------------------------------------------------------------------------- | -------- |
| 0004 | `0004_waitlist_opt_in_and_invites` | uncommitted | 2026-10-21 | Waitlist double opt-in columns; invite source/waitlist link/acceptance                   | Safe     |
| 0003 | `0003_provisioning_queue`          | uncommitted | 2026-10-21 | `provisioning_job` table; `customer_domain.stalwart_id/last_error`, `mailbox.last_error` | Safe     |
| 0002 | `0002_user_first_last_name`        | uncommitted | 2026-10-21 | `auth_user.first_name` (not null, default '') and `last_name`                            | Safe     |
| 0001 | `0001_audit_append_only`           | uncommitted | 2026-10-21 | Trigger blocking UPDATE/DELETE/TRUNCATE on `audit_log`                                   | Caution  |
| 0000 | `0000_init`                        | uncommitted | 2026-10-21 | Initial control-plane schema (14 tables)                                                 | Safe     |

## Details

Each migration gets a section in this shape:

```
### 0000_name · `<sha>` · YYYY-MM-DD · <level>
- Added:
- Changed:
- Removed:
- Data:
- Rollback:
```

### 0004_waitlist_opt_in_and_invites · uncommitted · 2026-10-21 · Safe

- Added: `waitlist_entry.confirm_token_hash` (unique index), `confirm_expires_at`, `confirm_sent_at`, `confirmed_at`;
  `invite.source` (default `staff`), `invite.waitlist_entry_id`, `invite.accepted_user_id`, `invite.accepted_at`.
- Changed: —
- Removed: —
- Data: none. Existing waitlist rows stay `pending` with no token (a re-join issues one).
- Rollback: drop the columns and the index (outstanding confirmation and invite links stop working).

### 0003_provisioning_queue · uncommitted · 2026-10-21 · Safe

- Added: `provisioning_job` (kind, subject_id, status, attempts, last_error, run_after, locked_at) with indexes
  on (status, run_after) and (kind, subject_id); `customer_domain.stalwart_id`, `customer_domain.last_error`,
  `mailbox.last_error`.
- Changed: —
- Removed: —
- Data: none.
- Rollback: drop the table and columns (queued jobs are lost; desired state is unaffected and can be re-enqueued).

### 0002_user_first_last_name · uncommitted · 2026-10-21 · Safe

- Added: `auth_user.first_name text not null default ''`, `auth_user.last_name text`. `name` is the display name.
- Changed: —
- Removed: —
- Data: existing rows get `first_name = ''` (seeded/dev users only).
- Rollback: drop the two columns.

### 0001_audit_append_only · uncommitted · 2026-10-21 · Caution

- Added: `audit_log_append_only()` function and two triggers on `audit_log` (row-level BEFORE UPDATE OR DELETE,
  statement-level BEFORE TRUNCATE) that raise `insufficient_privilege` — the table is append-only for every role,
  owner included (ADR-0010).
- Changed: —
- Removed: —
- Data: none.
- Rollback: drop the triggers and function. Only do it for an audited retention purge (`audit.md` "Retention"),
  then re-apply.

### 0000_init · uncommitted · 2026-10-21 · Safe

- Added: better-auth tables (`auth_user`, `auth_session`, `auth_account`, `auth_verification`);
  `platform_role_assignment`, `user_profile`, `customer_account`, `account_membership`, `invite`, `waitlist_entry`
  (unique `email_hash`), `customer_domain`, `mailbox`, `mail_alias`, `audit_log` (unique `scope, seq`).
- Changed: —
- Removed: —
- Data: none.
- Rollback: drop the schema on a fresh database (nothing older to return to).
