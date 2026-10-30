# 08 — Operations

Last updated: 2026-10-30 (data export and account deletion jobs, ADR-0025).

## Environments

| Env     | Where                                                                                                                                                                                          | Mail                                                                                  | Data                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| dev     | Developer machine, public repo `docker-compose.yml` profile `dev` (infra binds `DEV_BIND_ADDRESS`, default 127.0.0.1; apps listen on `DEV_HOST`)                                               | Stalwart on an isolated network; all non-local mail goes to Mailpit                   | Seeded demo data (`npm run db:seed -- --demo`); `credentials.md` generated and gitignored |
| ci      | GitHub Actions, profile `ci`                                                                                                                                                                   | Same isolation as dev                                                                 | Throwaway                                                                                 |
| staging | Small VPS (later), same private-ops compose as prod                                                                                                                                            | Real Stalwart; outbound only to an allow-list of our own test domains + seed accounts | Synthetic only                                                                            |
| prod    | One VPS, provider and region chosen in the private ops repo (`01-architecture.md` deploy shape); compose, NGINX and secrets from the private ops repo; only 80/443 + 25/465/587/993/995 public | Real                                                                                  | Customer data                                                                             |

Staging and production never run `npm run db:seed` (it refuses under `NODE_ENV=production`): the first Global
Administrator comes from the worker job `job:bootstrap-admin` (deploy/README.md "First platform administrator"), and
each environment sets `PLATFORM_DOMAIN` to its own domain so customers are shown that environment's mail hostnames.

The public repo's `docker-compose.yml` is **dev/CI only**. Production compose files, NGINX config, server IPs, deploy secrets and tuned abuse thresholds live only in the **private ops repo** and on the server (rule 44). The public repo ships images (`deploy/Dockerfile.*`), `.env.example` placeholders and the self-hosting guide.

### Running CI locally

`npm run ci:local` (`scripts/ci-local.sh`) runs the CI jobs from `.github/workflows/ci.yml` (the same `.cicd/*.sh` scripts, in the same order) against a commit, next to a running dev stack:

- It checks the ref (default `HEAD`) out in a throwaway local clone outside the repo (`$TMPDIR/anhourmail-ci-local/run-*`), so uncommitted work never leaks into the run. `--apply <path>` (repeatable) adds the working-tree state of those paths, to try a fix before committing it.
- The clone's `.env` is `.env.example` with every port moved to the 435xx/436xx block (mail ports too, allowed only there via `CI_LOCAL_SHIFTED_MAIL_PORTS=1` in `ports:check`) and `COMPOSE_PROJECT_NAME=anhourmail-ci`, so its containers, volumes and ports never touch the `anhourmail` dev project.
- `.cicd/setup.sh` (`npm ci`) runs once; before each job the clone is reset to its post-setup state and the ci stack removed, as each CI job starts fresh. `--jobs integration,e2e` runs a subset; `--verbose` streams output; `--keep` keeps the clone for debugging.
- It always tears down (also on failure or Ctrl-C): the job's processes, anything of the clone's still listening on a ci port, `docker compose down -v` for `anhourmail-ci`, and the clone with its `.env` and `credentials.md`. Job logs, the apps log and failure screenshots (no traces or HTML report: they can hold typed demo passwords) stay in the run's `logs/` directory.

## Backups and restore

| What                     | How                                                                                                                   | Frequency                        | Retention                 | Where                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------- | -------------------------------------- |
| Postgres (control plane) | `pg_dump -Fc` + WAL archiving (PITR)                                                                                  | Nightly dump, continuous WAL     | 30 daily, 12 monthly      | Encrypted, off-site object storage     |
| Stalwart RocksDB         | Quiesce or stop Stalwart → volume snapshot (native tooling; Stalwart has no online backup, `research/stalwart.md` §8) | Nightly, in a low-traffic window | 14 daily, 8 weekly        | Same                                   |
| Stalwart config          | `stalwart-cli snapshot` → plan file (secrets excluded)                                                                | On every config change + nightly | Versioned in the ops repo | Ops repo                               |
| Redis                    | Not backed up (rebuildable); AOF for restarts                                                                         | —                                | —                         | —                                      |
| Secrets key ring         | Offline copy, two operators                                                                                           | On change                        | Forever                   | Password manager + sealed offline copy |

**Monthly restore drill:** restore the latest Postgres dump and Stalwart snapshot into staging, run `stack:verify`-style checks plus a sample of mailboxes (counts, a known message per sampled mailbox via JMAP), and record time-to-restore in the ops log. A failed drill is a P1.

## Monitoring and alerts

| Signal                                                   | Source                                                                       | Alert                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| `/api/health/ready` non-200                              | External uptime check                                                        | Page                                    |
| Stalwart `/healthz/ready`, queue size, delivery failures | Prometheus `/metrics/prometheus` (Basic auth; Community metrics are limited) | Queue > N for 15 min; deferrals spike   |
| Blocklists (Spamhaus, Barracuda, Talos, …)               | Scheduler daily sweep                                                        | Any listing                             |
| Google Postmaster spam rate, Microsoft SNDS, Yahoo CFL   | Dashboards + FBL ingestion                                                   | Spam rate ≥ 0.1%                        |
| Hosting provider anti-spam IP block                      | Provider API poll                                                            | Immediate page                          |
| TLS certificate expiry (HTTP + mail)                     | Scheduler                                                                    | < 14 days                               |
| Backup job success, restore drill                        | Scheduler                                                                    | Any failure                             |
| Audit hash-chain verification                            | Scheduler                                                                    | Any break                               |
| Reconciler and service-account drift                     | Scheduler (`job:reconcile`, `job:service-accounts`)                          | Any drift                               |
| Storage measurement (`job:storage-usage`)                | Scheduler log                                                                | `failedBatches` > 0 three runs in a row |
| Worker/scheduler heartbeat                               | Container healthcheck                                                        | Unhealthy                               |
| Disk usage (Stalwart volume, Postgres)                   | Node exporter                                                                | > 75%                                   |

Alerts go to the operator by email (via a separate provider, so a broken mail stack can still page) and push.

## Scheduled and one-off jobs

The scheduler container runs every periodic job (rule 17; `apps/worker/src/scheduler.ts`), one at a time, each in its
own process. One-off jobs run in the worker image with `npm run -w @anhourmail/worker job:<name>`.

| Job                    | When               | Key                            | What                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job:audit-verify`     | Every 6 hours      | —                              | Verifies every audit hash chain; a break is logged at `fatal` and the job exits non-zero (`audit.md` "Integrity").                                                                                                                                                                |
| `job:reconcile`        | Hourly             | Provisioning + read-only audit | Desired state vs Stalwart (domains, accounts, quotas, suspension, app passwords, password credentials, managed scripts); reports drift as `platform.reconciler_drift`, re-queues non-destructive fixes, never deletes. The only job given the audit key.                          |
| `job:act-as-expiry`    | Every minute       | — (database only)              | Closes staff act-as sessions (ADR-0023) that expired, whose console session ended or whose staff member lost the role, and audits each `staff.act_as_ended` in the account and platform logs. The console stops honouring them at once regardless.                                |
| `job:service-accounts` | Every minute       | Provisioning                   | The management keys' owner accounts must exist and hold API keys only; drift audited. Refuses to run in production without `RECONCILE_IGNORE_DOMAINS`.                                                                                                                            |
| `job:domain-recheck`   | Every 5 minutes    | Provisioning                   | Re-checks DNS of pending domains added in the last week and activates those that pass; queues `domain.ensure` for domains whose DKIM keys were never read.                                                                                                                        |
| `job:domain-expiry`    | Daily              | Provisioning                   | Releases or deletes abandoned pending domains (`PENDING_DOMAIN`); audited `domain.released` / `domain.expired` in the domain's account.                                                                                                                                           |
| `job:mailbox-purge`    | Hourly             | Provisioning                   | Removes mailboxes past their deletion grace period (Stalwart account, then rows); audited `platform.mailbox_purged`; retires platform addresses. Skips (logs `held`) any due mailbox staff hold: its account or person suspended, or a staff hold on it.                          |
| `job:data-export`      | Every minute       | — (database + key ring)        | Builds waiting data exports (ADR-0025: control-plane data only), seals each with `SECRETS_KEYRING`, emails the requester, deletes archives past 7 days; audited `data.export_ready` / `data.export_expired`.                                                                      |
| `job:account-deletion` | Every 10 minutes   | — (database only)              | Accounts past their deletion grace period (ADR-0025): one idempotent step per run — mailboxes to `deleting` (the purge removes them), domains released, then the account row; emails everyone who was in it. Never before the grace period ends; a staff-suspended account waits. |
| `job:storage-usage`    | Every 10 minutes   | Provisioning                   | Reads each mailbox's `usedDiskQuota` (with its name, nothing else) in batches of 100 and records it on the mailbox row for the console. Logs `failedBatches` as a warning; those mailboxes keep their last good value.                                                            |
| `job:quota-cap`        | Once, on deploy    | Provisioning                   | Brings each account's mailbox quotas within its pooled storage: scales them down in proportion, never below the mail held (rounded up); queues `mailbox.ensure`; audited. Logs `keptAbovePoolAccountIds`, `unmeasured` (re-run).                                                  |
| `job:mailbox-backfill` | Once, on deploy    | —                              | Queues `mailbox.ensure` for every active mailbox (customer Sieve lock).                                                                                                                                                                                                           |
| `job:bootstrap-admin`  | Once, first deploy | —                              | Creates the first Global Administrator and emails a set-password link (deploy/README.md "First platform administrator"); audited `platform.admin_bootstrapped`.                                                                                                                   |

**Deploy step for the 2026-10-23 storage change** (Free 1 GB, Plus and Supporter 10 GB pooled per account): after the
release is up and the worker is running, run `job:quota-cap` once, check its log (`lowered`, `keptAbovePool`,
`unmeasured: 0`; re-run if any were unmeasured), and record the counts in `handoff.md`. Accounts kept above their pool
show it on the Mailboxes page and in their audit log (`mailbox.quota_changed`, reason `storage_pooled`).

**Deploy step for the Archive folder (2026-10-29, ADR-0014 update):** not a worker job — no management key can act
inside a mailbox — but part of the Stalwart bootstrap, which holds the administrator credential. In the ops repo's
bootstrap, after the other server settings and before its `ReloadSettings`, call `applyDefaultFolders(mgmt)` (every
mailbox opened from then on gets Archive from Stalwart); after the reload, call
`backfillArchiveFolders(mgmt, { skipDomains: [<service-account domains>] })` once (both from
`@anhourmail/stalwart-client`). It returns `{ checked, created, roleSet, failed }` (failed = Stalwart ids only); re-run
until `failed` is empty, and record the counts in `handoff.md`. A second run reports `created: 0, roleSet: 0`. It only
creates a folder or sets the `archive` role on an existing top-level Archive folder: no mail is moved or deleted.
Until it has run, the webmail tells a mailbox without Archive that nothing was moved. The dev plan does both on every
`npm run db:seed`.

**Deploy step for data export and account deletion (ADR-0025, migration 0027):** the scheduler's environment needs
`SECRETS_KEYRING` (the same ring as the web app: the worker seals export archives, the web app opens them),
`MAIL_TRANSPORT_URL`, `MAIL_FROM` and `APP_URL` (for the "export ready" and "account deleted" emails) — set them in the
private ops compose. Without them `job:data-export` and `job:account-deletion` fail at start (logged); nothing else
changes. Pending deletions are listed for Global Administrators under Platform → Pending deletions; a deletion that
should not go ahead (abuse investigation) is held by suspending the account, which stops every step until it is
lifted.

**Deploy step for mailbox delegation and send on behalf (ADR-0026, migration 0029, 2026-10-30):** the web app needs
`SENDER_DELEGATION_KEY` (64 lowercase hex, `openssl rand -hex 32`) and refuses to start in production without it; only
the web container and the Stalwart bootstrap get it, never the worker or scheduler. The ops repo's compose and
`deploy.sh` wiring must be on the server first, so pull **both** repos on every deploy (the deploy command in the ops
README and the handoff does). After a deploy that changes the sender-identity script (send-on-behalf exception, tag
expiry), run `scripts/deploy.sh --bootstrap-stalwart` once. On-behalf tags expire after five minutes and the script
compares against the mail server's clock, so the web and mail hosts must run NTP (skew well under five minutes).
Undo for delegated sends is held in one web process: a multi-instance web tier needs a shared store first.

**Server access to the private ops repo:** the server pulls it with a read-only deploy key (an SSH key added under the
repo's Deploy keys, write access off, `~/.ssh/config` host alias), not a personal token cached on the box.

## Suspending an account or a person

Staff do it from the console (Global Administrator, Platform → Customer accounts → the account): **Suspend account**
or, in the People tab, **Suspend person**, then a reason category, an internal note and a fresh step-up. The
procedure and when to use which is in `03-anti-spam-and-abuse.md` "Staff suspension". The worker applies the mailbox
changes like any suspension (jobs `mailbox.ensure`); if one gives up, the reconciler reports the mismatch and the
mailbox panel shows "not in force yet". Appeals come to `support@anhourtec.com`; **Lift suspension** restores.

## Runbooks

See `runbooks/README.md` for the list. Each runbook covers: symptoms, impact, first five minutes, diagnosis, fix, verification, follow-up.

## Release process

1. CI is green on `main` (all required checks, rule 41).
2. Tag `vYYYY.MM.DD-N`. CI builds the images from `deploy/Dockerfile.*` with `GIT_SHA` and pushes them to the registry.
3. Back up first if there are migrations with rollback level "Caution" or "Not recommended" (`migration.md`).
4. Deploy (from the private ops repo): bump the image tag there → pull → `docker compose up -d` → migrations run on app start → wait for health → smoke checks (sign-in, send/receive between two prod test mailboxes, `/api/health/ready`).
5. Record the release in `handoff.md` and the public changelog (user-facing changes, rule 31).
6. Roll back by redeploying the previous tag. Additive migrations stay. For destructive migrations, restore the backup.

## Stalwart upgrade process (rule 22)

Stalwart patches roughly weekly on the 0.16 line, and minors arrive every 2–4 months with breaking changes (`research/stalwart.md` §1).

1. Read the release notes and, for a minor version, `UPGRADING/` in the Stalwart repo. Never skip a minor.
2. Pin the new **tag + digest** in the public `docker-compose.yml` (dev/CI) and in the private ops repo's production compose.
3. Dev: `npm run dev:reset`, `npm run stack:verify`, integration tests, RBAC harness, e2e.
4. Re-verify the object shapes `packages/stalwart-client` uses (domain, account, route, strategy, listener, WebHook). Shapes are checked against the live schema at `/api/schema`.
5. Staging: back up → upgrade → verify → soak 48 h for minors (24 h for patches).
6. Prod: back up (snapshot) → upgrade in the low-traffic window → verify → watch queue and deliverability for 24 h.
7. Record the version, date, checks and anything odd in `handoff.md` and the ops log. Note the change on `/credits` (the exact Stalwart version we run).

Security patches skip the soak but still follow steps 1–4 and 6.

## Access control (pre-launch)

**Current policy (maintainer decision, 2026-10-23): open to everyone.** The web hosts are public (no IP allow-list)
and self-service sign-up is on (`SIGNUP_MODE=open`): anyone can create a personal Free account after verifying their
email. This replaces the 2026-10-21 decision below while pre-staging runs. The main open risk is outbound abuse from new
accounts until the abuse-controls phase (`09-roadmap.md` "Path to production": sending limits, trust tiers, phone verification, abuse queue) — staff watch new accounts and the
platform audit, and can close sign-up (`SIGNUP_MODE=closed`) or gate the web hosts (allow-list) at any time.

Earlier decision, kept for the record:

Decision 2026-10-21 (maintainer): until public launch the app is **not exposed to the internet**. The firewall
allows HTTPS (443) only from allow-listed IPs (staff, invited testers); everyone else is dropped before NGINX.
Within that boundary self-service sign-up is on (`SIGNUP_MODE=open`): new users get a personal Free account with
themselves as Owner (`provisionSignUp`, audited). Who gets an account is decided outside the product (the
allow-list; there is no waitlist — decision 2026-10-22). `SIGNUP_MODE=closed` makes `/sign-up` a 404 and the auth
endpoint refuses sign-ups. The allow-list itself lives in the private ops repo. Mail ports (25/465/587/993/995;
143, 110 and 4190 aren't published) are not behind the allow-list — mail must flow.

Password reset: `/forgot-password` (same answer whether or not the address exists) → one-hour link by email
(transactional mail via `MAIL_TRANSPORT_URL`; Mailpit in dev) → `/reset-password` → new argon2id hash, every
other session revoked, `auth.password_reset_requested` / `auth.password_reset` audited.
