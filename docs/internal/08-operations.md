# 08 — Operations

Last updated: 2026-10-21.

## Environments

| Env     | Where                                                                                                                                                                                               | Mail                                                                                  | Data                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| dev     | Developer machine, public repo `docker-compose.yml` profile `dev` (infra binds `DEV_BIND_ADDRESS`, default 127.0.0.1; apps listen on `DEV_HOST`)                                                    | Stalwart on an isolated network; all non-local mail goes to Mailpit                   | Seeded demo data (`npm run db:seed -- --demo`); `credentials.md` generated and gitignored |
| ci      | GitHub Actions, profile `ci`                                                                                                                                                                        | Same isolation as dev                                                                 | Throwaway                                                                                 |
| staging | Small VPS (later), same private-ops compose as prod                                                                                                                                                 | Real Stalwart; outbound only to an allow-list of our own test domains + seed accounts | Synthetic only                                                                            |
| prod    | One VPS, provider and region chosen in the private ops repo (`01-architecture.md` deploy shape); compose, NGINX and secrets from the private ops repo; only 80/443 + 25/465/587/993/995/4190 public | Real                                                                                  | Customer data                                                                             |

The public repo's `docker-compose.yml` is **dev/CI only**. Production compose files, NGINX config, server IPs, deploy secrets and tuned abuse thresholds live only in the **private ops repo** and on the server (rule 44). The public repo ships images (`deploy/Dockerfile.*`), `.env.example` placeholders and the self-hosting guide.

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

| Signal                                                   | Source                                                                       | Alert                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| `/api/health/ready` non-200                              | External uptime check                                                        | Page                                  |
| Stalwart `/healthz/ready`, queue size, delivery failures | Prometheus `/metrics/prometheus` (Basic auth; Community metrics are limited) | Queue > N for 15 min; deferrals spike |
| Blocklists (Spamhaus, Barracuda, Talos, …)               | Scheduler daily sweep                                                        | Any listing                           |
| Google Postmaster spam rate, Microsoft SNDS, Yahoo CFL   | Dashboards + FBL ingestion                                                   | Spam rate ≥ 0.1%                      |
| OVH anti-spam IP block                                   | OVH API poll                                                                 | Immediate page                        |
| TLS certificate expiry (HTTP + mail)                     | Scheduler                                                                    | < 14 days                             |
| Backup job success, restore drill                        | Scheduler                                                                    | Any failure                           |
| Audit hash-chain verification                            | Scheduler                                                                    | Any break                             |
| Reconciler drift                                         | Worker                                                                       | Any drift                             |
| Worker/scheduler heartbeat                               | Container healthcheck                                                        | Unhealthy                             |
| Disk usage (Stalwart volume, Postgres)                   | Node exporter                                                                | > 75%                                 |

Alerts go to the operator by email (via a separate provider, so a broken mail stack can still page) and push.

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

Decision 2026-10-21 (maintainer): until public launch the app is **not exposed to the internet**. The firewall
allows HTTPS (443) only from allow-listed IPs (staff, invited testers); everyone else is dropped before NGINX.
Within that boundary self-service sign-up is on (`SIGNUP_MODE=open`): new users get a personal Free account with
themselves as Owner (`provisionSignUp`, audited). Invite-only sign-up replaces it before the public beta
(`SIGNUP_MODE=closed` + invite acceptance, phase 3); `SIGNUP_MODE=closed` makes `/sign-up` a 404 and the auth
endpoint refuses sign-ups. The allow-list itself lives in the private ops repo. Mail ports (25/465/587/993/995/
143/110/4190) are not behind the allow-list — mail must flow.

Password reset: `/forgot-password` (same answer whether or not the address exists) → one-hour link by email
(transactional mail via `MAIL_TRANSPORT_URL`; Mailpit in dev) → `/reset-password` → new argon2id hash, every
other session revoked, `auth.password_reset_requested` / `auth.password_reset` audited.
