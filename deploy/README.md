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
- **Stalwart owns the mail ports** (25, 465, 587, 993, 995, 4190) and their TLS via its built-in ACME. Its HTTP
  management and JMAP endpoints are reachable only on the internal Docker network; the webmail reaches JMAP through
  `apps/web`'s same-origin proxy.
- **Published ports in production are only NGINX 80/443 and Stalwart's mail ports 25, 465, 587, 993, 995, 4190.**
  App, worker, Postgres, Redis and Stalwart's HTTP listener have no host ports; containers talk only over internal
  Docker networks (CLAUDE.md rule 18).
- Local dev differs on purpose: `.env.example` binds infra to `127.0.0.1` (`DEV_BIND_ADDRESS`); a developer's own
  `.env` may open it to the LAN. That never applies to production.
- **Production deployment config is not in this repository.** The production compose file, NGINX config,
  server addresses, secrets and tuned abuse thresholds live in the private ops repository (CLAUDE.md rule 44).
  This public repo ships the images (these Dockerfiles), the dev/CI `docker-compose.yml` and the
  self-hosting guide (`/docs/self-hosting`), which is a starting point for operators, not our production setup.
- Production shape (documented in `docs/internal/01-architecture.md`): containers talk only over internal Docker
  networks; the only published ports are NGINX 80/443 and Stalwart's mail ports 25/465/587/993/995/4190.
  Until then this directory only builds images.

## Rules

- Never commit `.env`, certificates, keys or server IPs here.
- Stalwart is pinned by tag and digest in compose; upgrades follow `docs/internal/08-operations.md`.
- Scheduled work runs in the worker/scheduler container, never a host crontab.

## One-off deploy steps

- **Customer Sieve lock backfill (webmail settings, 2026-10-22):** after deploying the release that adds
  `CUSTOMER_PERMISSIONS`, run `npm run job:mailbox-backfill --workspace @anhourmail/worker` once in the worker
  container. It queues `mailbox.ensure` for every active mailbox; the worker re-applies the mail-server permissions
  (customers can't write their own Sieve or VacationResponse) and re-activates each managed Sieve script. Safe to
  re-run; audited as `platform.mailboxes_requeued`. From then on the hourly reconciler reports and re-queues any
  mailbox whose lock drifted (`sieveLockMismatch`).

- **App passwords and principals (2026-10-22, ADR-0020):** the same backfill also turns off self-service credentials,
  the password change and principal look-ups on every customer account (`CUSTOMER_DENIALS` in `CUSTOMER_PERMISSIONS`, also in `SUSPENDED_PERMISSIONS`; the reconciler's `sieveLocked` drift check covers the whole list).
  Run it once after this release too.

## Required production settings (the app refuses to start otherwise)

- `TRUST_PROXY=true` — the app runs only behind our NGINX, which sets `X-Forwarded-For` (the right-most entry is
  trusted). Without it every anonymous caller would share one rate-limit bucket (security audit 2026-10-21), and
  the webmail couldn't pass each visitor's address to Stalwart, whose failed-login ban would then hit the app
  itself. (Dev also runs with `true`: its port forwarder sets the header; see `.env.example`.)
- `APP_URL`, `WEBMAIL_URL`, `SITE_URL` must be `https://` (session cookies are `Secure`).
- `BETTER_AUTH_SECRET` must not be the `.env.example` placeholder.
- `SECRETS_KEYRING` — the secrets-at-rest key ring (`id:base64(32 random bytes)`, newest first; older ids stay
  listed until nothing is sealed under them). Webmail sessions keep their mail-server tokens sealed with it.
- `STALWART_URL` — Stalwart's internal HTTP address (webmail sign-in and JMAP). Stalwart must run with
  `x:Http.useXForwarded: true` (the BFF forwards the end user's address so Stalwart's rate limits and login bans
  apply per person), which is safe only because its HTTP listener is reachable from the app network alone. Register the webmail's OAuth
  client once with exactly one redirect URI, `https://mail.anhourmail.com/oauth/callback` (`upsertOAuthClient` in
  `packages/stalwart-client`, client id `anhourmail-webmail`).
- `SIGNUP_MODE` defaults to `closed`; set `open` only while access is limited to the IP allow-list.
- `STALWART_API_KEY` — the management key (ADR-0017, ADR-0020) on an Admin-role service account with
  `permissions: { "@type": "Replace" }` and exactly the set in `docs/internal/02-mail-infrastructure.md` ("Production
  management key"): `authenticate`; the `sysDomain*`, `sysAccount*`, `sysDkimSignature*` objects it manages;
  `impersonate` with `sysAppPassword{Create,Get,Query,Destroy}` and `sysApiKey{Get,Query}` (app passwords and the
  reconciler's credential check); `jmapSieveScript{Get,Query,Create,Update,Validate}`, `jmapBlobUpload` and
  `jmapBlobGet` (the managed Sieve script). Never `jmapEmail*`, `jmapMailbox*`, `jmapBlobLookup` or any other mail
  permission, and an `allowedIps` list of the app and worker hosts.
- **The public JMAP/CardDAV host (`imap.`) must not expose Stalwart's `/api/*`, `/auth/*`, `/admin`,
  `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`.** `/api/auth` turns an app password
  into an account-wide OAuth token (ADR-0020); only the paths mail, contact and calendar apps use (`/jmap`,
  `/dav/*`, `/.well-known/{jmap,carddav,caldav}`) are proxied there.
- NGINX access logs must not record invite tokens: redact the path segment after `/invite/` and the `next` query on
  `/sign-in` (e.g. a `map` on `$request_uri` into the log format), since both carry a single-use invite token
  (`docs/internal/07-security.md` "Invites"). Invite acceptance creates console logins even when sign-up is closed.
