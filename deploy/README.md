# deploy/

Production build and deploy material. Nothing in this directory holds secrets, IPs or tuned abuse thresholds —
those live only on the server (`.env`) or in the private ops repository (CLAUDE.md rules 16 and 44).

| File                | What it is                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Dockerfile.web`    | `apps/web` (console on `app.anhourmail.com`, webmail on `mail.anhourmail.com`), Next.js standalone, non-root |
| `Dockerfile.site`   | `apps/site` (marketing, `/docs`, `/changelog`, `/credits`), Next.js standalone, non-root                     |
| `Dockerfile.worker` | `apps/worker` (queue worker + scheduler, same image, different command), heartbeat healthcheck               |

All images build from the repository root and take `--build-arg GIT_SHA=…`, which `/api/health` reports as the
version. CI builds all three on every push (`.cicd/build.sh`).

## Shape of production (v1)

- One VPS with clean IPv4/IPv6, settable rDNS and outbound port 25 (`docs/internal/08-operations.md`,
  `docs/internal/research/deliverability.md`).
- **NGINX** terminates HTTPS for the HTTP hosts only (site, `app.`, `mail.`, `mta-sts.`, `autoconfig.`), sets
  `X-Request-Id`, overwrites `X-Forwarded-*`, and never logs `/api/health`.
- **Stalwart owns the mail ports** (25, 465, 587, 993, 995) and their TLS via its built-in ACME. Its HTTP
  management and JMAP endpoints are reachable only on the internal Docker network; the webmail reaches JMAP through
  `apps/web`'s same-origin proxy.
- **Published ports in production are only NGINX 80/443 and Stalwart's mail ports 25, 465, 587, 993, 995.**
  ManageSieve (4190) and the cleartext-upgrade ports IMAP 143 / POP3 110 are not published, and mail apps are
  never told about them (`clientEndpoints` in `packages/shared/src/platform.ts`).
  App, worker, Postgres, Redis and Stalwart's HTTP listener have no host ports; containers talk only over internal
  Docker networks (CLAUDE.md rule 18).
- Local dev differs on purpose: `.env.example` binds infra to `127.0.0.1` (`DEV_BIND_ADDRESS`); a developer's own
  `.env` may open it to the LAN. That never applies to production.
- **Production deployment config is not in this repository.** The production compose file, NGINX config,
  server addresses, secrets and tuned abuse thresholds live in the private ops repository (CLAUDE.md rule 44).
  This public repo ships the images (these Dockerfiles), the dev/CI `docker-compose.yml` and the
  self-hosting guide (`/docs/self-hosting`), which is a starting point for operators, not our production setup.
- Production shape (documented in `docs/internal/01-architecture.md`): containers talk only over internal Docker
  networks; the only published ports are NGINX 80/443 and Stalwart's mail ports 25/465/587/993/995.
  Until then this directory only builds images.

## Rules

- Never commit `.env`, certificates, keys or server IPs here.
- Stalwart is pinned by tag and digest in compose; upgrades follow `docs/internal/08-operations.md`.
- Scheduled work runs in the worker/scheduler container, never a host crontab.

## One-off deploy steps

- **Customer Sieve lock backfill (webmail settings, 2026-10-22):** after deploying the release that adds
  `CUSTOMER_PERMISSIONS`, run `npm run job:mailbox-backfill --workspace @anhourmail/worker` once in the worker
  container. It queues `mailbox.ensure` for every active mailbox; the worker re-applies the mail-server permissions
  (customers can't write their own Sieve or VacationResponse). A managed Sieve script someone switched off is reported
  by the reconciler and re-activated by the next settings save (the worker has no owner access). Safe to re-run;
  audited as `platform.mailboxes_requeued`. From then on the hourly reconciler reports and re-queues any
  mailbox whose lock drifted (`sieveLockMismatch`).

- **Credential split (2026-10-23, ADR-0020):** replace `STALWART_API_KEY` with the three keys above (web: operations;
  worker: provisioning; scheduler: provisioning + audit), each from its own service account, then destroy the old key
  and its account. The apps refuse to start while `STALWART_API_KEY` is set.

- **App passwords and principals (2026-10-22, ADR-0020):** the same backfill also turns off self-service credentials,
  the password change and principal look-ups on every customer account (`CUSTOMER_DENIALS` in `CUSTOMER_PERMISSIONS`, also in `SUSPENDED_PERMISSIONS`; the reconciler's `sieveLocked` drift check covers the whole list).
  Run it once after this release too.

## Required production settings (the app refuses to start otherwise)

- `TRUST_PROXY=true` — the app runs only behind our NGINX, which sets `X-Forwarded-For` (the right-most entry is
  trusted). Without it every anonymous caller would share one rate-limit bucket (security audit 2026-10-21), and
  the webmail couldn't pass each visitor's address to Stalwart, whose failed-login ban would then hit the app
  itself. (Dev also runs with `true`: its port forwarder sets the header; see `.env.example`.)
- `APP_URL`, `WEBMAIL_URL`, `SITE_URL` must be `https://` (session cookies are `Secure`).
- `PLATFORM_DOMAIN` — the deployment's own domain, **required in production** (production uses `anhourmail.com`;
  the unset default exists for development only). Every hostname customers are told about is built under it: MX
  `mx1.`, SPF include `_spf.`, DKIM targets `<selector>.<customer domain>.dkim.`, `imap.`, `smtp.`, `autoconfig.`,
  `autodiscover.`, the console's mail-app settings and the free address domain; domain verification checks the same
  names. Set it on the web app **and** the worker, scheduler and any job. The web app refuses to start unless it is
  set and `APP_URL` and `WEBMAIL_URL` are directly under it (`app.<domain>`, `mail.<domain>`); worker processes
  refuse unless it is set and `APP_URL` (which they also need) is directly under it. A staging install on
  `staging.example.org` sets `PLATFORM_DOMAIN=staging.example.org` and publishes those hosts in its own DNS.
- `MAIL_TRANSPORT_URL` — `smtp://` or `smtps://` with optional `user:password@`; the only query options accepted are
  `secure`, `requireTLS`, `tls.servername` and `tls.rejectUnauthorized`. Anything else (including `logger` and
  `debug`, which would print SMTP transcripts) is refused at start-up; transport logging is always off.
- Never run `npm run db:seed` on a server: it applies the dev mail-server plan and creates demo logins. It refuses
  when `NODE_ENV=production` (unless `--force-dev-seed`), and — even with that flag — when `APP_URL` isn't a local
  `http://` address (`localhost`, `*.localhost`, loopback) or `PLATFORM_DOMAIN` is set to anything but a `.test`
  domain. The first administrator comes from `job:bootstrap-admin` (below).
- `BETTER_AUTH_SECRET` must not be the `.env.example` placeholder.
- `SECRETS_KEYRING` — the secrets-at-rest key ring (`id:base64(32 random bytes)`, newest first; older ids stay
  listed until nothing is sealed under them). Webmail sessions keep their mail-server tokens sealed with it.
- `STALWART_URL` — Stalwart's internal HTTP address (webmail sign-in and JMAP). Stalwart must run with
  `x:Http.useXForwarded: true` (the BFF forwards the end user's address so Stalwart's rate limits and login bans
  apply per person), which is safe only because its HTTP listener is reachable from the app network alone. Register the webmail's OAuth
  client once with exactly one redirect URI, `https://mail.anhourmail.com/oauth/callback` (`upsertOAuthClient` in
  `packages/stalwart-client`, client id `anhourmail-webmail`).
- `SIGNUP_MODE` defaults to `closed`; set `open` only while access is limited to the IP allow-list.
- `BREACHED_PASSWORD_CHECK` defaults to `on`: the **web** container checks new console and mailbox passwords against
  the public Pwned Passwords range API (`https://api.pwnedpasswords.com`, HTTPS egress needed; only the first five
  characters of the password's SHA-1 hash are sent). Without egress every check fails open with a
  `breached-password check unavailable` warning in the log. `off` turns it off; `fake` is refused in production.
- **Stalwart management keys — one per job, each only in its own containers** (ADR-0020 "Credential split"; exact
  sets in `packages/stalwart-client/src/keys.ts`, created by `ensureServiceAccount` / `issueServiceKey` from the same
  package). Each is a `Replace`-typed API key with an `allowedIps` list of the management network and an expiry, owned
  by a password-less service account whose custom role holds exactly the key's set (not the Admin role):
  - `STALWART_PROVISIONING_KEY` (account `svc-provision`) — **worker and scheduler only**: domains, accounts, DKIM keys
    and the permissions a customer mailbox keeps; no `impersonate`.
  - `STALWART_OPERATIONS_KEY` (account `svc-ops`) — **web only**: app passwords and the managed Sieve script on a
    mailbox (`impersonate`); no account, domain or DKIM access.
  - `STALWART_AUDIT_KEY` (account `svc-audit`) — **scheduler only**: reads managed Sieve scripts for the hourly check.

  Each process refuses to start in production without its own key or with any other key, the dev admin
  (`STALWART_DEV_ADMIN_*`) or the old `STALWART_API_KEY`; at start (web: before first use) each key is compared with
  its documented set (`GET /api/account`) and anything else is refused. Never give the web app the provisioning key:
  it would let the internet-facing process create and change accounts.

- **`MAILBOX_PASSWORD_GRANT_KEY`** — **web app and the management proxy only** (32+ random characters, e.g.
  `openssl rand -base64 48`). The web app signs each mailbox password reset or change with it (HMAC bound to the
  account and the exact argon2id hash, valid ≤ 1 hour); the management proxy accepts the worker's password replacement
  only with a valid grant, so the provisioning key alone can't set a customer's password. The worker and scheduler
  refuse to start with it. Rotate by setting the new value on both at once (grants in flight fail and are retried by
  the person or admin).

- **The public JMAP/CardDAV host (`imap.`) must not expose Stalwart's `/api/*`, `/auth/*`, `/admin`,
  `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`.** `/api/auth` turns an app password
  into an account-wide OAuth token (ADR-0020); only the paths mail, contact and calendar apps use (`/jmap`,
  `/dav/*`, `/.well-known/{jmap,carddav,caldav}`) are proxied there.
- NGINX access logs must not record invite tokens: redact the path segment after `/invite/` and the `next` query on
  `/sign-in` (e.g. a `map` on `$request_uri` into the log format), since both carry a single-use invite token
  (`docs/internal/07-security.md` "Invites"). Invite acceptance creates console logins even when sign-up is closed.

## First platform administrator

On a fresh server (migrations applied, mail transport working), create the first Global Administrator once from the
worker container:

```sh
npx tsx --env-file=/path/to/.env apps/worker/src/jobs/bootstrap-admin.ts --email you@example.org --first-name Ada \
  [--last-name Lovelace]
# or: npm run job:bootstrap-admin --workspace @anhourmail/worker -- --email … --first-name …
```

- It needs `DATABASE_URL`, `APP_URL`, `MAIL_TRANSPORT_URL`, `MAIL_FROM` and `PLATFORM_DOMAIN`. It creates a console
  login with a verified email and **no password**, grants `global_admin`, and emails a one-time link to the
  console's "Choose a new password" page (valid 60 minutes, single use). No password goes on the command line; the
  link is never printed or logged. After it expires, "Forgot password" on the console sends a new one.
- It **refuses and changes nothing** when anyone already holds a platform role (it can't be used to add admins
  later — grant roles from the console) or when the email already has a console login (a pre-registered sign-up is
  never promoted).
- Every run is audited in the platform scope as `platform.admin_bootstrapped` (system actor `bootstrap-admin`;
  refusals as `denied` with `admin_exists` / `login_exists`).
- It touches only Postgres and the system mailer: no mail-server plan, no mailboxes, no demo data.
- Exit codes: `0` created and emailed, `1` refused or bad input, `2` created but the email failed.
- In production it refuses to start unless `PLATFORM_DOMAIN` is set and `APP_URL` is directly under it (same check
  as the web app and the other worker processes).

**If the email failed (exit 2).** The login and role exist; only the link didn't go out. Fix the mail transport
(`MAIL_TRANSPORT_URL`, `MAIL_FROM`, the no-reply mailbox), then open the console's sign-in page, choose "Forgot
password" and enter the same address: it sends a fresh one-hour link. Don't re-run the job — it refuses, because an
administrator now exists.

**If the email address was mistyped.** The job won't run again, and nobody can receive the link. Remove the mistaken
login by hand, but only while it has never been used (no password set, no session), then run the job again with the
right address. In a `psql` session on the control-plane database:

```sql
begin;
-- Must return exactly one row; if it returns none, the login was used: stop and investigate instead.
select u.id from auth_user u
 where u.email = 'mistyped@example.org'
   and not exists (select 1 from auth_account a where a.user_id = u.id)
   and not exists (select 1 from auth_session s where s.user_id = u.id);
delete from auth_verification where value = '<id from above>';      -- the unused set-password token
delete from auth_user where id = '<id from above>';                 -- cascades its role and profile
commit;
```

The original `platform.admin_bootstrapped` audit entry stays (audit is append-only) and the re-run writes a second
one; note the manual removal and why in the operations log, since it bypasses the application.
