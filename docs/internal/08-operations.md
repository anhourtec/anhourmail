# 08 — Operations

Last updated: 2026-11-05 (the mail importer and its deploy gate, import pages and notify job, orphaned spam-training samples clean-up, the emergency session kill; no phone verification, ADR-0031); 2026-11-04 (webmail push through NGINX: buffering off, read timeout, caps); 2026-10-31 (file storage lockdown deploy step); 2026-10-30 (data export and account deletion jobs, ADR-0025).

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
| `job:import-expiry`    | Hourly             | — (database only)              | Mail import sweep (ADR-0030): terminal imports still holding a secret, username or folder name are wiped and their revoke queued; paused or blocked ones past their credential fail (`expired`); syncs past their window complete. Audited `data.import_*`.                       |
| `job:import-notify`    | Every minute       | — (database + mailer)          | Mail import summary (ADR-0030 §16): each ended import is claimed (`notified_at`) and its email sent to the person who started it and, for an admin-started one, the mailbox's person; counts per folder role only. Cancelled imports are claimed without an email. Not audited.   |
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

**Deploy step for the internal-mail marker and the forwarding guard (2026-10-30):** run `scripts/deploy.sh --bootstrap-stalwart` once after the deploy: it installs the new submission script (marker), the `inbound-headers` script (strips the marker from port-25 mail) and the DATA expression. The web app needs a usable authserv id in production (`MAIL_AUTHSERV_ID`, a hostname; unset defaults to `mx1.<PLATFORM_DOMAIN>`, which must be what Stalwart stamps in Authentication-Results) and refuses to start without one; set the same value for the web app and the scheduler. About 30 s after the web app starts it upgrades existing forwarding scripts to the guard (audited `platform.mail_rules_upgraded`; at most once a day); the reconciler reports `unguardedForwarding`. Checks that need real DNS are in ADR-0019's "forwarding and DMARC" note.

**Deploy step for the file storage lockdown (migration 0032, 2026-10-31):** customer mailboxes lose the mail server's
file storage (JMAP FileNode, WebDAV `/dav/file/`) and share notifications (`07-security.md` "App passwords").
Migration 0032 queues a `mailbox.ensure` for every mailbox with an account on the mail server, which writes the new
denials; the reconciler's `sieveLockMismatch` catches any it missed (every status but `provisioning`, whose own job
writes them). The provisioning key's set shrinks with them (it holds exactly what a customer keeps: now 162 + 15 =
177). Two things follow: a worker or scheduler on the previous release can't write the old lockdown once the role is
narrowed (verified: `notUpdated`), so its ensures and suspensions would fail and give up; and the new worker refuses
to start while its key's role is still wider than the set. Changes that don't write permissions (password
replacement, app password revocation, quota) work with the narrowed key on accounts still on the old lockdown
(verified). So the release goes out in this order, from the ops directory on the server, with `.env`'s `IMAGE_TAG`
(and `APP_SRC` checked out at it) already set to the new release — the plan runs from `worker:${IMAGE_TAG}`:

```sh
# 1. Builds the new images, stops worker + scheduler (and NGINX while the temporary admin exists), narrows the service
#    roles, issues three new keys, removes every file share, re-locks no-reply/postmaster. Older keys wider than the
#    new set are reported "prune after switching" (not a failure); NGINX comes back at the end.
PLAN_ROTATE_KEY=true scripts/deploy.sh --bootstrap-stalwart
# 2. Copy secrets/stalwart-{provisioning,operations,audit}-key into .env (editor, never echo), then migrate (0032
#    queues the ensures) and start everything on the new release, with the smoke check.
scripts/deploy.sh
# 3. Remove the old keys. PLAN_PURGE_FILES=true also destroys files stored before the lockdown (step 1 printed how many
#    accounts have any); leave it out to keep them. This stops worker + scheduler again ...
PLAN_PRUNE_KEYS=true PLAN_PURGE_FILES=true scripts/deploy.sh --bootstrap-stalwart
# 4. ... so start them again (no rebuild).
scripts/deploy.sh --skip-build
```

Deploying the new release before step 1 leaves the worker and scheduler refusing to start until step 1 has run. Step 3
also covers the pending "bootstrap once after the deploy" for the marker scripts. After step 4, check the reconciler's
next run reports no `sieveLockMismatch` (`platform.reconciler_drift` absent or without it).

**Server access to the private ops repo:** the server pulls it with a read-only deploy key (an SSH key added under the
repo's Deploy keys, write access off, `~/.ssh/config` host alias), not a personal token cached on the box.

## Mail importer (ADR-0030)

A fourth process from the worker image: `npm run --silent --workspace @anhourmail/worker importer`, its own container
(never inside the worker or scheduler). It claims mail imports from Postgres, copies one slice of each over IMAP and
gives it back. Heartbeat: `find /tmp/importer-heartbeat -mmin -2`.

- **Deploy gate (ops repo; before the importer runs anywhere, checked by the deploy, not assumed):** its network
  reaches **only** Postgres, Stalwart's IMAPS port (`IMPORT_DESTINATION_IMAP`, internal address) and public TCP
  993/143. From inside the importer container a connection to Stalwart HTTP (`/api/auth`, `/jmap`, the management
  listener), the management proxy and Redis **must fail**, and outbound to any other port must fail. The image runs
  with `NODE_ENV=production`, so the development switches refuse to start. Dev rehearses this with the compose
  `importer` service (profile `import`: an internal network whose only exit, `import-edge`, forwards Postgres and the
  mail server's 993/143).
- **Settings:** `DATABASE_URL`, `SECRETS_KEYRING` (the web app's ring: it opens what the web app sealed),
  `IMPORT_DESTINATION_IMAP` (`host:port`, required), `IMPORT_DESTINATION_TLS_NAME` (default the public IMAP host from
  `PLATFORM_DOMAIN`), `PLATFORM_DOMAIN`, `IMPORT_MESSAGE_CAPS` (message caps per destination mailbox over a rolling 30 days, by trust tier, e.g.
  `new=<n>,standard=<n>,restricted=0`; required for `new`, `standard`, `restricted`; values are private, ops repo only),
  and capacity settings `IMPORT_PROCESS_CONCURRENCY` (2), `IMPORT_GLOBAL_CONCURRENCY` (4), `IMPORT_SLICE_MINUTES` (15),
  `IMPORT_LEASE_SECONDS` (120), `IMPORT_MAX_MESSAGES_PER_SECOND` (20), `IMPORT_MAX_BYTES_PER_SECOND` (10 MB/s). It is
  refused any Stalwart key, `STALWART_URL`, `REDIS_URL`, `MAILBOX_PASSWORD_GRANT_KEY` and `SENDER_DELEGATION_KEY`, and
  the dev-only `IMPORT_DEV_*` and `IMPORT_MAX_MESSAGE_BYTES`.
- **The worker's training key** (deploy step before this release's worker starts): issue the fourth service account
  and key, `svc-train` / `STALWART_TRAINING_KEY` (`TRAINING_KEY_PERMISSIONS`; the ops repo's Stalwart bootstrap creates it with `ensureServiceAccount` /
  `issueServiceKey` for role `training`, like the others), give it to the **queue worker only**, and teach the management proxy to allow that key nothing but
  `x:SpamTrainingSample/get` (properties `accountId`, `isSpam`, `expiresAt` only), `/query` and `/set { destroy }`.
  The worker refuses to start in production without it. If `x:SpamClassifier.holdSamplesFor` isn't the default 180
  days, set `STALWART_SPAM_SAMPLE_HOLD_MS` on the worker to the same value (a mismatch fails the clean-up jobs loudly).
  The per-minute service-account check now expects `svc-train` too.
- **Kill and restart are safe:** a killed importer's imports are picked up by any importer once the lease runs out
  (≤ `IMPORT_LEASE_SECONDS`) and resume from their checkpoints; its training-sample window is covered then.
- **Console and emails (slices 10–11):** people start and watch imports on the console's Import mail page; admins
  can upload a CSV for up to `MAX_MAILBOXES` mailboxes at once. The scheduler's `job:import-notify` sends the summary
  email (needs `MAIL_TRANSPORT_URL`, `MAIL_FROM`, `APP_URL`, like `job:data-export`). A failed send is logged by
  error name and not retried; the console still shows the result.
- **Support questions:** "it says Needs you" — the import page names the reason and the fix (`IMPORT_BLOCKED_TEXT`);
  a refused source sign-in is never retried by us (so the provider doesn't lock the account). "It ended" with
  `expired` — it waited past its destination credential (7 days, 14 with sync); start a new one, nothing is copied twice.
  Folder names are gone from finished imports by design; we can't tell anyone what was in which folder afterwards.
- **Dev:** the demo seed's `import-source@dev.test` is the old provider (Other IMAP server, `127.0.0.1`, 993); the
  scheduler isn't part of `npm run dev`, so run `npm run --workspace @anhourmail/worker job:import-notify` to send
  summaries (they land in Mailpit). A `npm run dev` started before the import routes existed must be restarted (seen
  2026-11-05: its web server answered 500 on every route using the new import tiers until restarted).
- **Alerts:** `platform.provisioning_failed` for `mail_import.credential_revoke` (with `data.import_credentials_wiped`
  in the account's log; the credential still expires on its own), for `mail_import.training_cleanup` and for
  `mailbox.training_purge` (the samples a purged mailbox's account left; ADR-0030 update).

### Orphaned spam-training samples

Before 2026-11-05 a purged mailbox's spam-training samples (sender, subject and a copy of each message) stayed on the
mail server for up to `holdSamplesFor` (180 days). Since then the purge queues `mailbox.training_purge`; the ones from
before are removed once with `scripts/stalwart-training-orphans.ts`:

- `npm run ops:training-orphans` — **dry run** (default): prints counts only (`samples`, `accounts`, `orphaned`,
  `orphanedAccountIds`, `reappearedAccountIds`, `inherited`); changes nothing. Before anything goes, the account ids
  missing from the full list are asked for again by id; any that exist keep their samples, and `--apply` then refuses
  (exit 1, `refused`, with the count) so the list can be checked first. `-- --apply` destroys the orphaned samples; `-- --inherited`
  also destroys samples of an existing account made before it was created (none so far: ids aren't reused).
- Credentials: the provisioning key (reads account ids and creation times) and the training key (reads only a sample's
  `accountId`, `isSpam`, `expiresAt`; destroys), or the dev admin in development. On a server, run it where both keys
  are already held and through the management proxy, like the other one-off jobs; set `STALWART_SPAM_SAMPLE_HOLD_MS`
  if `holdSamplesFor` isn't the default.
- Dev, 2026-11-05 (dry run, latest): 1,252 samples, 1,251 orphaned across 259 account ids, 0 reappeared, 0 inherited.

## Suspending an account or a person

Staff do it from the console (Global Administrator, Platform → Customer accounts → the account): **Suspend account**
or, in the People tab, **Suspend person**, then a reason category, an internal note and a fresh step-up. The
procedure and when to use which is in `03-anti-spam-and-abuse.md` "Staff suspension". The worker applies the mailbox
changes like any suspension (jobs `mailbox.ensure`); if one gives up, the reconciler reports the mismatch and the
mailbox panel shows "not in force yet". Appeals come to `support@anhourtec.com`; **Lift suspension** restores.

**Emergency blanket session kill:** a mail app that was signed in before the suspension keeps its open IMAP and
submission sessions (Stalwart v0.16.27; app passwords are revoked for spam, abuse and phishing, which ends sessions
that used one). If a suspended sender is still pushing mail through a session signed in with the password, restart
the Stalwart container: every open session ends and the suspension refuses the reconnect. Mail already queued still
goes out unless cancelled by hand in Stalwart's queue (no key of ours may do it yet).

## Runbooks

See `runbooks/README.md` for the list. Each runbook covers: symptoms, impact, first five minutes, diagnosis, fix, verification, follow-up.

## Release process

1. CI is green on `main` (all required checks, rule 41).
2. Tag `vYYYY.MM.DD-N`. CI builds the images from `deploy/Dockerfile.*` with `GIT_SHA` and pushes them to the registry.
3. Back up first if there are migrations with rollback level "Caution" or "Not recommended" (`migration.md`).
4. Deploy (from the private ops repo): bump the image tag there → pull → `docker compose up -d` → migrations run on app start → wait for health → smoke checks (sign-in, send/receive between two prod test mailboxes, `/api/health/ready`).
5. Record the release in `handoff.md` and the public changelog (user-facing changes, rule 31).
6. Roll back by redeploying the previous tag. Additive migrations stay. For destructive migrations, restore the backup.

## Webmail push through NGINX

The webmail's push stream (`GET /api/webmail/push` on the webmail host, server-sent events; 05-webmail.md "Push") is a
long-lived response. The production NGINX config lives in the private ops repository (rule 44); for this path it needs:

- **No response buffering:** `proxy_buffering off;` (the app also sends `X-Accel-Buffering: no`, which NGINX honours by
  default) and `proxy_cache off;`. No `gzip` on it (the app sends `Cache-Control: no-store, no-transform`).
- **A read timeout above the 25-second heartbeat:** the default `proxy_read_timeout 60s` is enough; never below 30 s.
  Streams end by themselves after about 30 minutes and the browser reconnects.
- **HTTP/1.1 to the app with keep-alive:** `proxy_http_version 1.1;` and `proxy_set_header Connection "";`
  (HTTP/2 to browsers is fine and lets tabs share the connection).
- The usual `X-Forwarded-For` / `X-Real-IP` headers, as for the rest of the webmail API (rate limits count per session).

Nothing new is published: the BFF's upstream push socket goes to Stalwart's HTTP listener (`/jmap/ws`) on the internal
Docker network, like the JMAP proxy. Each process holds at most 2,000 upstream sockets and 8,000 streams
(`PUSH_LIMITS`); over that the webmail falls back to its 30-second check, so a full process degrades, it doesn't fail.
Check after a deploy: open the webmail, send yourself a message from another mailbox, and it appears within a couple
of seconds (in the browser's network panel, `push` stays pending with `ready` and `state` events).

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
accounts until the abuse-controls phase (`09-roadmap.md` "Path to production": sending limits, trust tiers, abuse queue; no phone verification, which the sign-up proof-of-work and sign-up limits replace, ADR-0031) — staff watch new accounts and the
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
