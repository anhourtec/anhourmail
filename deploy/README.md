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
- NGINX access logs must not record invite tokens: redact the path segment after `/invite/` and the `next` query on
  `/sign-in` (e.g. a `map` on `$request_uri` into the log format), since both carry a single-use invite token
  (`docs/internal/07-security.md` "Invites"). Invite acceptance creates console logins even when sign-up is closed.
