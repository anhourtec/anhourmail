<h3 align="center">
  <a name="readme-top"></a>
  <!-- Logo placeholder: replace with the AnhourMail mark once the brand assets land in apps/site/public. -->
  <img src="./apps/site/public/logo.svg" alt="AnhourMail" height="96">
</h3>

<div align="center">
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0">
  </a>
  <a href="#project-status">
    <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="Status: pre-alpha">
  </a>
  <a href="https://github.com/anhourtec/anhourmail/graphs/contributors">
    <img src="https://img.shields.io/github/contributors/anhourtec/anhourmail.svg" alt="Contributors">
  </a>
  <a href="https://anhourmail.com">
    <img src="https://img.shields.io/badge/Visit-anhourmail.com-0077C8" alt="Visit anhourmail.com">
  </a>
</div>

<p align="center">
  <a href="#why-anhourmail">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start-local-development">Quick start</a> ·
  <a href="https://anhourmail.com/docs/self-hosting">Self-hosting</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="#license">License</a>
</p>

---

# AnhourMail

**Private, fast hosted email with a modern open-source webmail.** Bring your own domain, use unlimited and
masked aliases, and read your mail in a webmail that loads instantly — no tracking, no ads, open source.
Open source and available as a hosted service at [anhourmail.com](https://anhourmail.com).

## Project status

**In development — not open for sign-ups yet.** The control plane (Phase 3) and the webmail (Phase 4) are being
built in the open; billing, abuse controls and the production deployment come next. Follow the
[roadmap](./docs/internal/09-roadmap.md) and the [changelog](https://anhourmail.com/changelog).

**Works today (local development):**

- **Console** — custom domains with guided DNS and live checks; mailboxes with storage, suspend, resume and
  delete with a 30-day restore window; aliases and masked aliases; people, invites and roles; an audit log;
  global search; staff pages for customer accounts; app passwords for mail apps (scoped to IMAP, SMTP, contacts
  or mail over HTTPS, shown once); catch-all addresses on custom domains.
- **Sign-in security** — two-factor sign-in with an authenticator app, recovery codes and passkeys; owners can
  require a second factor; a Security page with sessions and recent activity.
- **Webmail** — sign in with a mailbox, folders and threads, a safe reader (plain text, markdown, invitations,
  forwarded mail; HTML in a sandboxed frame with remote images blocked), writing, replying and forwarding with
  drafts and undo send, archive / delete / junk / move / pin, search, several mailboxes in one session, and
  contacts that also sync to phones and desktop apps over CardDAV, and settings for appearance, reading, writing
  and signatures, automatic replies, confirmed forwarding and blocked senders.
- **Engineering** — role-based access checked on every route, an append-only audit trail, rate limits on every
  endpoint, and a CI pipeline you can run locally with `npm run ci:local`.

---

## Why AnhourMail?

- **Webmail that is actually fast**: talks [JMAP](https://jmap.io) to the mail server through a same-origin
  proxy, syncs incrementally, caches locally and renders lists virtually. No IMAP in the browser path.
- **Private by default**: no tracking pixels, no third-party analytics, remote images blocked until you allow
  them, HTML mail rendered in a sandboxed frame.
- **Your domain, your addresses**: guided DNS setup with live per-record checks, catch-all, unlimited aliases and
  masked (random) aliases you can switch off at any time.
- **Standard protocols**: IMAP, SMTP and JMAP for any mail app, with app passwords and two-factor sign-in.
- **Leave whenever you want**: full export (mbox/EML + contacts) and account deletion, any time.
- **Transparent**: a public cost breakdown, a transparency report and open-source code.
- **Open source**: developed in the open — the apps under AGPL-3.0, the reusable libraries under MIT.

---

## Features

**Planned for v1**

| Feature            | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| **Free address**   | `you@anhourmail.com` with 10 GB                                             |
| **Custom domains** | Bring your own domains on paid plans, with guided DNS and live verification |
| **Aliases**        | Aliases, catch-all and masked aliases you can switch off at any time        |
| **Mail access**    | IMAP, SMTP and JMAP; app passwords; two-factor sign-in                      |
| **Webmail**        | Open-source, keyboard-first, works on phones                                |
| **Data export**    | mbox/EML + contacts export, account deletion                                |
| **Trust**          | Privacy policy, acceptable use policy, status page, transparency report     |

**Later:** calendar (CalDAV), a filter editor, per-user encryption at rest. Contacts with CardDAV sync are
already in the webmail.

Plans, prices and limits are defined once in [`packages/shared`](./packages/shared) and rendered into the app,
the marketing site and the docs.

---

## Architecture

```
            browser
               │  HTTPS
     ┌─────────┴───────────────────────────────┐
     │ NGINX (TLS for web hosts)               │
     └──┬──────────────┬──────────────────┬────┘
        │              │                  │
  anhourmail.com   app.anhourmail.com   mail.anhourmail.com
  apps/site        apps/web (console)   apps/web (webmail, same app,
  site + /docs                          separate origin)
                       │                  │  same-origin JMAP proxy
                       │                  ▼
                       │   packages/jmap-client ──► Stalwart JMAP
                       │
                       ├── packages/stalwart-client ──► Stalwart management (internal only)
                       ├── Postgres (control plane only, never mail content)
                       └── Redis (sessions, queues, rate limits)

  apps/worker: provisioning jobs, DNS checks, quota sync, reconciler, imports
  Stalwart: SMTP 25/465/587, IMAP 993, ManageSieve 4190 — run unmodified
```

The mail engine is [Stalwart](https://github.com/stalwartlabs/stalwart), run **unmodified** and driven only
through its API. Accounts, plans, domains, limits, abuse controls and audit live in our control plane. See
[`docs/internal/01-architecture.md`](./docs/internal/01-architecture.md).

---

## Quick start (local development)

You need Node.js 22, npm 10 and Docker. Nothing in the dev stack can send mail off your machine: every
outbound message lands in Mailpit, and the mail server's network has no internet route.

```bash
cp .env.example .env
npm ci
npm run dev              # starts the compose services if needed, then every app
npm run db:seed -- --demo   # demo accounts; writes credentials.md (gitignored, local only)
```

| What                | URL                                                               |
| ------------------- | ----------------------------------------------------------------- |
| Marketing site      | http://localhost:43100                                            |
| Docs                | http://localhost:43100/docs                                       |
| Changelog / credits | http://localhost:43100/changelog, /credits                        |
| Console             | http://localhost:43200                                            |
| Webmail             | http://localhost:43300 (same app as the console, on its own port) |
| Mailpit UI          | http://localhost:43026                                            |
| Stalwart admin UI   | http://localhost:43080/admin                                      |
| Postgres / Redis    | 127.0.0.1:43432 / 127.0.0.1:43379                                 |

All ports are bound to `127.0.0.1` and can be changed in `.env`; `npm run ports:check` reports clashes.
`npm run dev:reset` wipes the local volumes and re-seeds. `npm run check`, `npm test`, `npm run test:int`,
`npm run test:rbac` and `npm run test:e2e` run the checks and test suites; `npm run ci:local` runs the whole CI
pipeline on a clean copy of your commits without touching your dev stack. To run your own instance, follow the
[self-hosting guide](https://anhourmail.com/docs/self-hosting).

---

## Project layout

| Path                       | What it is                                                           | Licence       |
| -------------------------- | -------------------------------------------------------------------- | ------------- |
| `apps/web`                 | Console and webmail (Next.js), API routes, JMAP proxy                | AGPL-3.0-only |
| `apps/site`                | Marketing site, public docs (`/docs`), changelog, credits            | AGPL-3.0-only |
| `apps/worker`              | Jobs and scheduler: provisioning, DNS checks, reconciler, imports    | AGPL-3.0-only |
| `packages/core`            | Domain rules and services, no database or SDK imports                | AGPL-3.0-only |
| `packages/adapters`        | Postgres and in-memory adapters, contract tests                      | AGPL-3.0-only |
| `packages/shared`          | Plans, limits, hostnames, DNS templates, roles (one source of truth) | AGPL-3.0-only |
| `packages/ui`              | Design tokens, fonts, skeletons                                      | AGPL-3.0-only |
| `packages/jmap-client`     | Small typed JMAP client                                              | MIT           |
| `packages/stalwart-client` | Client for Stalwart's management API                                 | MIT           |
| `packages/server`          | Logger, health probes, Redis helpers                                 | MIT           |
| `packages/config`          | Shared TypeScript config                                             | MIT           |
| `infra/`                   | Stalwart and Postgres dev configuration                              | AGPL-3.0-only |
| `docs/public`              | User guides published at anhourmail.com/docs                         | —             |
| `docs/internal`            | Architecture, ADRs, research, runbooks                               | —             |

---

## Built with

AnhourMail stands on the work of these projects — thank you.

- [Stalwart](https://github.com/stalwartlabs/stalwart) — the mail server (AGPL-3.0, Stalwart Labs), run unmodified
- [Next.js](https://nextjs.org) and [React](https://react.dev)
- [shadcn/ui](https://ui.shadcn.com), [Tailwind CSS](https://tailwindcss.com) and [Lucide](https://lucide.dev)
- [PostgreSQL](https://www.postgresql.org) and [Redis](https://redis.io)
- [Drizzle ORM](https://orm.drizzle.team) and [Better Auth](https://www.better-auth.com)
- [Fumadocs](https://fumadocs.dev) for the docs
- [Playwright](https://playwright.dev) and [Vitest](https://vitest.dev) for testing
- [Mailpit](https://mailpit.axllent.org) for safe local mail

The full list of dependencies and their licences is in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and
on [anhourmail.com/credits](https://anhourmail.com/credits). Listing a project here does not imply its
endorsement of AnhourMail.

---

## Contributing

We welcome contributions. Please read the [Contributing Guide](./CONTRIBUTING.md) before opening a pull
request. Contributors sign our [Contributor License Agreement](./CLA.md) once, through the CLA Assistant bot on
your first pull request.

Please follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

### Contributors

<a href="https://github.com/anhourtec/anhourmail/graphs/contributors">
  <img alt="contributors" src="https://contrib.rocks/image?repo=anhourtec/anhourmail"/>
</a>

---

## Security

Please do not open public issues for security problems. Report them privately to
**security@anhourmail.com** — see [SECURITY.md](./SECURITY.md).

---

## License

- **Apps** (`apps/*`) and the product packages (`core`, `adapters`, `shared`, `ui`) are licensed under the
  **GNU Affero General Public License v3.0 only** ([LICENSE](./LICENSE)).
- **Reusable libraries** (`packages/jmap-client`, `packages/stalwart-client`, `packages/server`,
  `packages/config`) are licensed under the **MIT License** — see the `LICENSE` file in each package.
- Every source file carries an SPDX header saying which licence applies.
- Code derived from HourMail (MIT) keeps its original MIT notice in those files.
- **Stalwart** is AGPL-3.0 software by Stalwart Labs. AnhourMail runs it unmodified and talks to it over its
  public APIs; its source is at [github.com/stalwartlabs/stalwart](https://github.com/stalwartlabs/stalwart).
  If we ever modify it, we will publish those changes.
- **Commercial licences:** the [CLA](./CLA.md) lets Anhourtec offer the code under commercial terms as well.
  That revenue funds development, while the public code stays AGPL.

## Trademarks

"AnhourMail" and the AnhourMail logo are trademarks of Anhourtec. The code is open; the name is not. Forks must
use a different name and logo — see [TRADEMARKS.md](./TRADEMARKS.md).

<p align="right">
  <a href="#readme-top">↑ Back to top</a>
</p>
