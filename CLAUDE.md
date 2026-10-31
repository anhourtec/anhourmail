@AGENTS.md

# AnhourMail

AnhourMail is a hosted email service by **Anhourtec** for privacy-minded,
tech-savvy individuals: free `@anhourmail.com` addresses, custom domains on paid plans, aliases and masked aliases,
IMAP/SMTP/JMAP, and a fast open-source webmail. Mail is handled by **Stalwart** (AGPL-3.0, run unmodified and
driven through its JMAP management API). Everything else — signup, invites, plans, billing, domains,
mailboxes, aliases, quotas, abuse, audit — is our control plane.

Start every session by reading `docs/internal/handoff.md` (local only), then the docs for the area you touch:
`docs/internal/00-vision.md` … `09-roadmap.md`, `docs/internal/adr/`, `docs/internal/roles.md`,
`docs/internal/audit.md`, `docs/internal/codemap.md`.

## Stack

| Layer    | Choice                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apps     | `apps/web` (console on `app.` + webmail on `mail.`, one Next.js app routed by host), `apps/site` (marketing, `/docs` via Fumadocs, `/changelog`, `/credits`), `apps/worker` (queue worker + scheduler)                                                                                                                                                                                                |
| Packages | `packages/core` (domain, services, ports — no ORM/SDK imports), `packages/adapters` (Postgres via drizzle, in-memory, contract tests), `packages/shared` (facts, plans, limits, DNS templates, RBAC matrix, zod schemas), `packages/server` (logger, health, Redis), `packages/stalwart-client`, `packages/jmap-client`, `packages/ui` (tokens, fonts, skeletons), `packages/config` (tsconfig bases) |
| Frontend | Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4 + shadcn/ui, self-hosted General Sans + Geist                                                                                                                                                                                                                                                                                         |
| Auth     | better-auth (console identity); Stalwart OAuth tokens held server-side for webmail                                                                                                                                                                                                                                                                                                                    |
| Data     | Postgres 17 (control plane only, never mail content), Redis 8 (sessions, queues, rate limits, cache)                                                                                                                                                                                                                                                                                                  |
| Mail     | Stalwart v0.16.27 (pinned tag + digest); Mailpit in dev/CI                                                                                                                                                                                                                                                                                                                                            |
| Quality  | ESLint (typescript-eslint strict-type-checked) + Prettier, Vitest, Playwright, husky + lint-staged                                                                                                                                                                                                                                                                                                    |
| Deploy   | Docker Compose; v1 = one VPS (provider and region not public); NGINX for HTTPS, Stalwart owns mail ports and their TLS                                                                                                                                                                                                                                                                                |

Versions are pinned and listed in `AGENTS.md`.

## Running it

```sh
cp .env.example .env            # dev placeholders only
npm install
npm run dev                     # starts compose services if down, then site + web + worker with labelled output
npm run db:seed -- --demo       # demo world + writes credentials.md (gitignored)
```

| Command                                            | What it does                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run stack:up` / `stack:down`                  | Docker services only (Postgres, Redis, Stalwart, Mailpit, mail-edge); runs `ports:check` first  |
| `npm run db:migrate`                               | Apply drizzle migrations (log every one in `docs/internal/migration.md`)                        |
| `npm run db:seed`                                  | Minimum: platform Global Administrator, plans, `dev.test` mail domain + Stalwart dev plan       |
| `npm run db:seed -- --demo`                        | Full demo world (every role, special states, mailboxes, sample mail); rewrites `credentials.md` |
| `npm run dev:reset`                                | Wipe volumes, restart compose, migrate, seed `--demo`                                           |
| `npm run stack:verify`                             | Prove the mail stack: internal delivery over JMAP, external mail caught by Mailpit, no egress   |
| `npm run check`                                    | Lint, format check, typecheck, skeleton / logging / docs checks                                 |
| `npm test` · `test:int` · `test:rbac` · `test:e2e` | Unit (coverage gated) · integration (real stack) · RBAC harness · Playwright                    |

### Ports and local URLs

Dev services use the uncommon **43xxx** block, overridable in `.env` (`npm run ports:check` fails on clashes).
App dev servers listen on `DEV_HOST` and infra containers publish on `DEV_BIND_ADDRESS`. `.env.example` ships the
safe default `DEV_BIND_ADDRESS=127.0.0.1` because infra holds dev passwords and Stalwart's dev recovery admin; a
local `.env` may set `DEV_HOST=0.0.0.0` and `DEV_BIND_ADDRESS=0.0.0.0` to reach everything from the LAN (Next's
`allowedDevOrigins` includes the machine's LAN IPs). `*.localhost` hostnames resolve to 127.0.0.1 without editing
`/etc/hosts`, so host separation and cookie scoping behave like production. On a bare IP (e.g. a phone on the LAN)
dev serves the webmail at `/webmail`. Production publishes only NGINX 80/443 and Stalwart's mail ports (rule 18).
Dev runs with `TRUST_PROXY=true`: the webmail port forwarder sets `X-Forwarded-For` for each visitor and the webmail
passes it to Stalwart, so failed sign-ins are counted per client and the `mail-edge` forwarder is never banned; tests
that fail sign-in on purpose send their own documentation-range address (198.51.100.0/24, 203.0.113.0/24).

| What                                       | Local                                                                                                                                                 | Bind                                   | Production                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------- |
| Marketing site                             | http://localhost:43100                                                                                                                                | `DEV_HOST`                             | https://anhourmail.com      |
| Public docs                                | http://localhost:43100/docs                                                                                                                           | `DEV_HOST`                             | https://anhourmail.com/docs |
| Changelog / credits                        | http://localhost:43100/changelog, `/credits`                                                                                                          | `DEV_HOST`                             | `/changelog`, `/credits`    |
| Console                                    | http://localhost:43200                                                                                                                                | `DEV_HOST`                             | https://app.anhourmail.com  |
| Webmail                                    | http://localhost:43300 (same `apps/web` via the dev port forwarder `scripts/dev-mail-proxy.mjs`, routed by port — ADR-0003; also `/webmail` on 43200) | `DEV_HOST`                             | https://mail.anhourmail.com |
| Mailpit UI / SMTP                          | http://localhost:43026 / 43125                                                                                                                        | `DEV_BIND_ADDRESS` (127.0.0.1 default) | — (dev and CI only)         |
| Stalwart HTTP (JMAP, management, `/admin`) | http://localhost:43080                                                                                                                                | `DEV_BIND_ADDRESS` (127.0.0.1 default) | internal network only       |
| Stalwart SMTP / submissions / submission   | 43025 / 43465 / 43587                                                                                                                                 | `DEV_BIND_ADDRESS` (127.0.0.1 default) | 25 / 465 / 587              |
| Stalwart IMAPS / POP3S / ManageSieve†      | 43993 / 43995 / 43190                                                                                                                                 | `DEV_BIND_ADDRESS` (127.0.0.1 default) | 993 / 995 (no ManageSieve)  |
| Postgres / Redis                           | 43432 / 43379                                                                                                                                         | `DEV_BIND_ADDRESS` (127.0.0.1 default) | internal network only       |

† ManageSieve stays local to dev for testing only; production never publishes it.

Never use 3000, 5432, 6379, 1025, 8025, 8080 or other common ports in dev. Check a port with
`lsof -nP -iTCP:<port> -sTCP:LISTEN`. Neighbouring projects on this machine use 474xx (iotkinect-portal) and
480xx–484xx (AnhourLeads); stay out of those ranges.

### Docs layout

- `docs/internal/` — never published: vision, architecture (`01-architecture.md`), mail infra, abuse, data model,
  webmail, billing, security, operations, roadmap, `adr/`, `research/`, `runbooks/`, `roles.md`, `audit.md`,
  `codemap.md`, `migration.md`, `rate-limits.md`, `branding.md`, `typography.md`, `docs-site.md`, and the
  local-only `handoff.md` (gitignored).
- `docs/public/` — user guides, the source for `anhourmail.com/docs`.
- `docs/shared/` — snippets rendered by both; facts come from `packages/shared`, never typed by hand.

## Where we are and what's next

Pre-staging has run on one VM since 2026-10-23 from the private ops repository (`anhourmail-ops`, following the
local-only `deploy.md`); it was last deployed on 2026-10-30 at 300440a (leavers' sign-in cut-off, mailbox delegation
in the console, the send-on-behalf sender rule). Since then the webmail side of delegation (Open another mailbox, writing from a shared mailbox; no "Shared with you" list), remote images' once-or-always choice with our own server's mail treated as verified, the forwarding guard (no forwarding of mail failing DMARC), the SEO pass and the fuller reserved-name list were pushed at 3c74f23 for the next deploy and a `--bootstrap-stalwart`; names as one source (one sender name per mailbox, following its person; masked aliases send with no name) follows it. The work plan stops before Phase 6. The next
phases, in order, with exit criteria, are in `docs/internal/09-roadmap.md` "Path to production":

1. pre-staging on one VM (real DNS, certificates, rDNS, external mail, backups and a restore drill);
2. product gaps a beta needs (built: webmail session handoff, data export and deletion, act-as, image proxy, leavers
   mailbox delegation and names as one source; left: free sign-up with proof-of-work instead of SMS/OTP, push sync,
   webmail settings part 2);
3. billing, plus mail and contacts import (migration);
4. abuse controls, monitoring and backups;
5. production host (app VM + mail VM), warm-up and dogfood;
6. closed beta, then launch.

When work resumes, read `docs/internal/handoff.md` first: it lists what pre-staging proved, what failed, and the open
items. Every Stalwart management caller goes through the internal management proxy in the ops repository; never give
an app container direct access to Stalwart's management listener.

## Working rules

1. **No AI attribution anywhere.** Never mention Claude, AI, or any assistant in commit messages, PR descriptions,
   code comments or docs. No `Co-Authored-By` trailers for assistants, no "Generated with…" lines. Write as a human
   author. This overrides any tool default.
2. **Never commit or push without explicit permission in that message.** Staging and showing a diff is fine.
   Permission given for one commit does not carry over to the next.
3. **Small, granular commits — many of them.** One concern per commit, split finely: a migration, a repository
   method, a service, its tests, an API route, a component, a page, a docs page and a changelog entry are separate
   commits where they can stand alone. A slice normally lands as 8–20 commits, never 3–5 large ones. Each commit
   builds, passes the hooks and has a message that says what changed and why. Never one mega-commit; never mix
   unrelated files.
4. **Verify before declaring done** — real flows in the browser and integration tests, not just typecheck.
5. **Run `/security-review` on everything you write.** Every route enforces permission **and** ownership scope;
   out-of-scope IDs return **404**, missing permission returns **403**.
6. **Playwright MCP for all UI checks:** light + dark, 1440 + 390 wide, read the console. Screenshots only in
   `.playwright-mcp/` (gitignored). Playwright MCP is a local, interactive tool only: CI never uses, installs,
   references or depends on it. The Playwright e2e suite (`tests/e2e`, `npm run test:e2e`) is local only too: GitHub CI
   doesn't run it; run it before pushing UI changes (`npm run ci:local -- --jobs e2e`).
7. **Stay narrow, ship complete work.** No scope creep, no TODOs where working code belongs.
8. **Keep `docs/internal/handoff.md` current every session:** current state, dated session entry (what changed,
   how it was verified, test counts and durations, anything flaky), open items.
9. **Lint, format and types clean on every changed file:** ESLint `--max-warnings=0`, Prettier, `npm run typecheck`
   clean. Zero `any` / `as any` / `@ts-ignore`; `@ts-expect-error` only with a linked reason; no blanket
   `eslint-disable` — a disable names one rule and gives a real reason. (ESLint + Prettier replaced Biome; ADR-0004.)
10. **Keep `docs/internal/codemap.md` and `docs/internal/01-architecture.md` current** in the same change.
11. **Every page and waiting component has a loading skeleton** that mirrors the real layout (`loading.tsx` next to
    every `page.tsx`; skeleton pieces in `@anhourmail/ui/skeletons`). Enforced by `npm run check:skeletons` in the
    pre-commit hook.
12. **Logging only via the logger** (`@anhourmail/server/log`): JSON, request ids, redaction list. No `console.*` in
    server code (enforced by `check:logging`). New secret or content keys go in `REDACT_KEYS`.
13. **Health endpoints are cheap, public and non-sensitive:** `/api/health` (liveness, touches nothing) and
    `/api/health/ready` (Postgres, Redis, Stalwart; statuses and latencies only).
14. **Every endpoint has a rate limit:** defaults plus tighter tiers for auth, signup, invites, DNS verify,
    exports and sending-related actions. Table in `docs/internal/rate-limits.md`. Redis failures fail open, except
    tiers marked fail-closed (send quotas, signup, password reset, alias creation).
15. **Every migration is logged in `docs/internal/migration.md`** with its rollback level. Never edit an applied
    migration. Destructive changes ship in three steps (add, move data, drop) after a backup.
16. **Third-party secrets** (Stripe, Stalwart API key, SMS/OTP provider, DNS provider) are encrypted at rest
    (key ring with key id, AES-256-GCM with AAD), write-only in UI and API, never logged or audited by value.
17. **Scheduled work runs in the worker/scheduler container**, never a host crontab.
18. **Ports — never use common ones** (43xxx for dev services, listed in the table above).
    - **Dev:** app dev servers listen on `DEV_HOST`; infra containers publish on `DEV_BIND_ADDRESS`.
      `.env.example` keeps the safe default `DEV_BIND_ADDRESS=127.0.0.1` (infra holds dev passwords and Stalwart's
      recovery admin); a local `.env` may set both to `0.0.0.0` to open everything on the LAN deliberately.
    - **Production:** no host ports for app, worker, Postgres, Redis or Stalwart HTTP — containers talk only over
      internal Docker networks. The only published ports are NGINX **80/443** and Stalwart's mail ports
      **25, 465, 587, 993, 995**, which must be the standard ones. ManageSieve (4190) is not published: customers
      can't write their own Sieve (it would be an open-relay vector); the managed script is written through the
      management API.

### Mail-specific rules

19. **Never send real mail to external addresses** from dev, tests or CI. Dev/test outbound goes to Mailpit.
    Tests that need "external" delivery use a second local Stalwart domain or a mock.
    - Dev Stalwart sits on the internal `mailnet` network with no internet route; every non-local recipient also
      routes to Mailpit (`infra/stalwart/dev-plan.ts`). `npm run stack:verify` proves both.
20. **Never weaken mail authentication or filtering** (SPF, DKIM, DMARC, ARC verification, MTA-STS, spam checks)
    to make something work — fix the root cause. Dev-only exceptions forced by the no-egress network (e.g. Pyzor
    off) live in the dev plan, are documented, and never reach production config.
21. **All Stalwart access goes through `packages/stalwart-client`; all JMAP through `packages/jmap-client`.** The
    management API is internal-network only and never reachable from the browser. The browser never holds a
    Stalwart token: the webmail talks to our same-origin proxy, which attaches the user's token server-side.
22. **Stalwart is pinned and never forked.** Tag **and** digest in `docker-compose.yml`. Upgrades are a deliberate
    change: read release notes and `UPGRADING/`, back up, test in dev/staging, re-verify management object shapes,
    record in handoff.
    - Stalwart v0.16 has no REST API or TOML: management is JMAP `x:*` objects at `POST /jmap` (see `AGENTS.md`).
23. **We never store mailbox passwords.** Stalwart owns mail credentials; IMAP import source credentials are
    encrypted and wiped when the job ends.
    - Passwords are stored only as **salted argon2id** hashes (OWASP baseline m=19 MiB, t=2, p=1): console
      passwords in Postgres, mailbox passwords sent to Stalwart as PHC strings (plaintext never crosses the
      management API). Never plaintext, reversible encryption or fast hashes (`07-security.md` "Password storage").
24. **Mail content never enters Postgres, logs, analytics, audit or error reports.** No subjects, bodies, previews
    or recipient lists in logs.
25. **Ownership isolation is correctness:** every query is scoped to the owning account; tests include cross-account
    access attempts that must return 404.
26. **Provisioning is a job, not an inline request:** write intent → worker applies to Stalwart → status
    `active`/`failed`. The reconciler reports drift and never deletes mail automatically.
27. **Outbound limits and trust tiers are enforced server-side** (Stalwart throttles + our checks), never only in
    the UI. Any change to sending limits, signup gating or abuse logic needs a `security-reviewer` pass.
28. **`anhourtec.com` is staff-only;** customer and free accounts live on `anhourmail.com` or customer domains.
29. **Privacy promises are product requirements:** no tracking pixels or third-party analytics anywhere; remote
    images blocked by default; HTML email rendered in a sandboxed iframe (no `allow-scripts`) with strict CSP and
    sanitising; zero third-party requests from the site, docs, console or webmail.
30. **Docs are part of done:** behaviour, config or architecture changes update the matching doc and, for
    non-trivial decisions, an ADR in `docs/internal/adr/`.

### Public docs

31. **Every user-facing change updates the public docs in the same change.** New or changed features, settings,
    limits, prices, DNS records, client setup steps or error messages → update `docs/public` (and screenshots if UI
    changed), plus a changelog entry. A user-facing change without docs is unfinished work.
32. **One source of truth for facts.** Hostnames, ports, plan limits, prices, sending limits and DNS templates live
    in `packages/shared` and are imported by the app, the marketing site and the docs. Never duplicate them by hand.
33. **Public docs never expose internals.** No internal hostnames, IPs, admin paths, abuse-detection thresholds or
    anything from `docs/internal`. Publish sending limits, not detection rules.
34. **The docs site is verified like the app:** `check:docs` passes, links work, Playwright check of changed pages
    in light/dark at 1440 and 390.

### Roles, testing and architecture

35. **Roles come from one matrix** (`packages/shared/src/rbac`). Any permission, route or nav change updates the
    matrix, `docs/internal/roles.md`, the RBAC harness and the e2e role journeys in the same change.
36. **Run the full RBAC harness and a Playwright MCP pass as every affected role** before calling UI, route or
    permission work done.
37. **Never break what already works:** run the full suite (lint, typecheck, unit, integration, RBAC, e2e) before
    finishing any task. If anything fails — even unrelated — fix it or report it. Never skip, delete or weaken a
    test to get green.
38. **Code is database-independent:** domain and services use repository interfaces only; only adapter folders
    (`packages/adapters`, `*/adapters/`) import the ORM, database driver or third-party SDKs (enforced by ESLint).
    Stalwart, Stripe, SMS/OTP and DNS each sit behind an interface with a fake for tests.
39. **Every change ships with unit tests** (success, failure, permission denial, edge cases). Coverage thresholds
    (≥ 90% core, services and RBAC; ≥ 80% overall) are enforced in CI.
40. **Zero TypeScript errors, zero ESLint warnings, Prettier-formatted,** in every workspace, at every commit.
41. **CI is the gate:** all required checks green before merge; never bypass hooks (`--no-verify`) or mark checks
    optional.
    - **Run the CI pipeline locally before every push** with `npm run ci:local` (the same `.cicd/*.sh` jobs as
      GitHub Actions, on a clean local clone of the commits being pushed, in its own Compose project and ports so
      the dev stack is untouched; `--apply <path>` tests uncommitted fixes). Push only when every job is green locally; after pushing, check the Actions run and
      fix any failure in the same session.
    - CI job and step names shown in GitHub Actions stay generic ("integration tests", "build apps + images"): they
      don't list the services behind them (maintainer preference, 2026-10-30). CI files themselves may name the
      open-source stack where a command needs it — the stack is public in the README — but never secrets, hostnames,
      IPs, server addresses or anything private (rule 44); secrets come only from the CI secret store.

### Open source and licensing

42. **Every new source file has the correct SPDX header:** `// SPDX-License-Identifier: AGPL-3.0-only` in apps and
    app-specific packages, `MIT` in reusable packages (`jmap-client`, `stalwart-client` and other generic
    libraries). Code brought in from HourMail keeps its MIT notice. Enforced by `check:spdx`.
43. **Every new dependency passes the licence allowlist** (`check:licenses`), and `THIRD_PARTY_NOTICES.md` plus
    `/credits` are regenerated in the same change (`check:notices` fails if stale).
44. **Nothing private ever lands in the public repo:** no IPs, secrets, tuned abuse thresholds or customer data.
    Abuse logic can be public; thresholds come from config.
    - `docker-compose.yml` is **dev/CI only**. Production compose, NGINX config, server addresses and deploy
      secrets live in the private ops repository (`docker-compose.prod.yml`, `deploy/nginx/`, `ops/` are
      gitignored as a backstop). This repo ships images (`deploy/Dockerfile.*`) and the self-hosting guide.
45. **Outside contributions are merged only after the contributor has signed the CLA.**

### Audit

46. **Every mutation writes an audit entry in the same transaction**, through the audit module
    (`packages/core/src/audit`) — including denied attempts and staff/act-as actions. New action names are added to
    the event catalogue in `docs/internal/audit.md`. `check:audit` fails on a service mutation without one.
47. **Audit is append-only and tamper-evident;** never add update/delete paths for audit rows or bypass the hash
    chain.
48. **Never put mail content, secrets, tokens or passwords in audit entries;** use the shared redaction list.
49. **Staff actions on an account are always visible to that account's admins.**

### Local data

50. **`credentials.md` is generated by the seed script, gitignored, and must never be committed or pasted into
    chat, commits, docs or logs** (`check:credentials` fails if it is staged). Any new role, account state or local
    service updates the demo seed and the `credentials.md` generator in the same change.
51. **At the end of every session, stop the dev stack:** stop `npm run dev` and run
    `docker compose --profile dev down` (keep volumes unless asked). Record in `docs/internal/handoff.md` that it
    was stopped and how to restart (`npm run dev`).
52. **Local-only files never reach the public repo:** `docs/internal/handoff.md`, `credentials.md`, `.env*`
    (except `.env.example`), `docs/internal/private/**`, `*.local.md`, `infra/stalwart/.generated/` and
    `.playwright-mcp/` are gitignored; `npm run check:credentials` (pre-commit + CI) fails if any of them is staged
    or tracked.
53. **Brand assets have one source: `packages/ui/assets/brand`** (Anhourtec logo for light and dark
    backgrounds, favicons, app icons, `site.webmanifest`). Edit only there, run `npm run brand:sync` to copy them
    into `apps/web/public` and `apps/site/public`; `npm run check:brand` (pre-commit + CI) fails on drift. Render
    the company logo with `AnhourtecLogo` from `@anhourmail/ui/anhourtec-logo` (it switches variant with the
    theme) and set icons with `BRAND_ICONS`. The repo-root `public/` is a local drop folder and is gitignored.
    **Never use third-party logos** (customer or partner marks) anywhere in the product, site or docs — no implied
    endorsement, no "trusted by" strips until a written agreement exists. The AnhourMail and Anhourtec names and
    logo are trademarks (TRADEMARKS.md); forks replace them. No 1 MB+ assets in pages (the embedded-raster
    `favicon.svg` is not used).
54. **Security review at the end of every session**, whether or not anything is committed: run `/security-review`
    on the session's changes, then the Cloudflare **`security-audit`** skill (installed user-wide at
    `~/.claude/skills/security-audit`) as a scoped run over the session diff (`git diff` of everything changed,
    staged or not) with the **`quick`** profile; a full `standard`/`deep` audit only when asked. Fix every
    `confirmed` finding before ending the session, report every `needs_validation` item to the maintainer, and
    record both reviews and their results in `docs/internal/handoff.md`. Audit output stays outside the repo
    (`~/security-audit-skill/anhourmail/run-<N>`); never probe deployed or production endpoints. The same two
    reviews also run before any commit (below).

55. **Checkpoint continuously; never let the usage limit end a session mid-change.** Sessions can stop without
    warning when the usage limit is reached, and the assistant can't see how close that is. So work in small,
    finished slices and checkpoint after each one: tests green → `docs/internal/handoff.md` updated (what changed,
    how it was verified, what's next, open items) → the pre-commit reviews (rule 54) → commit by topic. Never hold
    more than one slice of uncommitted work. When a session feels long, or the maintainer says the limit is near,
    stop starting new work: finish or revert the current slice, checkpoint it, then stop the stack (rule 51).
    Pushing still needs the maintainer's go-ahead (rule 2).

56. **Check GitHub security alerts every session** (start and end), so the repo stays current: Dependabot alerts,
    code scanning and secret scanning for `anhourtec/anhourmail` (repo → Security, or
    `gh api repos/anhourtec/anhourmail/dependabot/alerts`, `…/code-scanning/alerts`, `…/secret-scanning/alerts`),
    plus `npm audit`. Fix every open alert in the session (bump or pin the patched version — `overrides` in the root
    `package.json` for transitive dependencies — then re-run the full suite); if no patched version exists, record it
    in `docs/internal/handoff.md` open items with the advisory id, the dependency path and why it is acceptable
    (e.g. dev-only, input we control). Never dismiss an alert without that note. A leaked-secret alert is an incident:
    rotate first, then record it.

57. **No competitor names in the repo.** Never name other mail, productivity or admin-console products or their
    companies in committed files — Markdown/MDX docs (internal and public), code comments, identifiers, test names,
    commit messages or PR text — including as a design reference ("like X", "X parity", "X-compatible shortcuts").
    Describe the behaviour itself instead ("conventional webmail shortcuts", "familiar admin-centre layout").
    - Design references (screenshots, notes, walkthroughs of other products) live only in the gitignored
      `docs/internal/private/` folder, and are captured read-only: navigate and screenshot, never change settings,
      submit forms or create data in someone else's product.
    - The only exception is user-facing setup and compatibility text where a person must recognise a third-party
      product to act — e.g. a mail-app setup guide, importing mail from another provider, or a mailbox provider's
      published sender requirements. Name the product plainly there, never as a comparison or endorsement.

58. **No scratch files in the repository.** Probes, one-off scripts, debug dumps and test captures go in the
    session scratchpad or the OS temp directory, never in the repo tree (not even untracked). Repo checks and the
    editor's type-aware ESLint would pick them up ("was not found by the project service"). As a backstop `.probe/`,
    `.scratch/` and `.probe*` / `.scratch*` files are gitignored and ESLint-ignored, and `check:spdx` skips hidden
    files; delete any such file when done.

59. **Keep the README current with every push.** Before pushing, update `README.md` for what the pushed commits
    change for a reader: the project status and "Works today" list, features (never promise what isn't built),
    commands and local URLs. Commit it as its own small commit in the same push; if nothing reader-facing changed,
    say so in the session summary. Same rules as everything public: no secrets or private details (rule 44), no
    competitor names (rule 57).

60. **Sweep every Markdown doc against the code every session.** Before the session ends (and before any push),
    check every `.md`/`.mdx` the session's work could have made stale, not only the ones a commit touched:
    `docs/internal/*` (incl. `09-roadmap.md` phase status lines and "Path to production", `codemap.md`,
    `migration.md`, `audit.md`, `roles.md`, `rate-limits.md`), ADRs (add a dated "Update" note, never rewrite the
    decision), `docs/public/**` and the changelog, `README.md`, `AGENTS.md` (pinned versions), this file's "Where we
    are and what's next", and `docs/internal/handoff.md`. Verify claims against the code (statuses, names, limits,
    jobs, migrations, routes), fix what's wrong, and bump a doc's `Last updated:` line whenever its content changes.
    Record in the handoff that the sweep ran and what it changed; if nothing was stale, say so.

61. **Profile data has one source and shows the same everywhere.** A person's name, avatar, sender name and other
    profile details are stored once (the person's record, mirrored to the mail server where it needs them, e.g. the
    JMAP identity), and every place that shows or edits them reads and writes that one source: the console app bar,
    person menu, Profile and People pages, the webmail sidebar, Account settings, sender identities and contacts.
    Every change that adds code showing or editing such a field checks all the other places, keeps them in sync
    (an edit in one shows in the others without a manual refresh where the page is open), and adds an e2e step that
    edits it in one place and sees it in another. Avatars are images we host (never remote URLs), size-capped and
    re-encoded server-side.

62. **No marketing or bulk mail from our own domains, ever.** `anhourmail.com`, `anhourtec.com` and every other
    domain or hostname we own (including the MX/HELO name and the outbound IPs they sign and send from) carry only
    person-to-person mail and our own transactional mail (sign-in, invites, exports, alerts). Whenever we build
    newsletters, bulk or marketing sending (Phase 10), it sends only from the customer's **own verified domain**, with
    its own DKIM, on a separate sending path (its own IPs or subdomain and throttles) so a bulk sender's reputation can
    never touch the platform domains or the shared IPs people's personal mail goes out on. Free `@anhourmail.com`
    addresses are never allowed bulk sending. Any change near sending, limits or abuse logic is checked against this
    rule (with rule 27's `security-reviewer` pass).
    - **Our reputation is a product requirement:** keep the platform domains and IPs off spam blocklists. Monitor the
      major DNS blocklists, postmaster/feedback-loop dashboards and DMARC/TLS-RPT reports (Phase 6); stop abusive
      senders before their mail reaches the queue (rule 27).
    - **When a receiving server blocks us** (it happens occasionally with smaller or stricter mail servers): treat it
      as an incident — find the block from the bounce text, request delisting or contact that server's postmaster the
      same day, and record it in the runbook; the target is resolved within a day or two. Never work around a block by
      rotating domains or IPs.
    - **Designed never to be blocked:** every outbound path meets the large mailbox providers' published sender
      requirements (Gmail, Yahoo, Microsoft, Proton and others) at the bulk-sender level from day one: aligned SPF,
      DKIM and DMARC, forward-confirmed PTR matching the HELO name, TLS, RFC-valid messages, complaint rate below
      0.1 % (never 0.3 %), feedback loops registered, warmed IPs. A change that weakens any of them is a defect.
    - Details and status of each requirement live in `docs/internal/03-anti-spam-and-abuse.md` ("Platform
      reputation", "Designed never to be blocked") and the deliverability research; publish sending limits, never
      detection rules (rule 33).

## Project conventions

- **Services hold the logic; route handlers only parse, call and map errors.** Services take the actor and check
  permission and scope themselves, so a new caller can't forget.
- **Out of scope → 404, missing permission → 403, signed out → 401.** Never confirm another account's ids.
- Response envelope: `{ data }` on success, `{ error: { code, message } }` on failure.
- Redis is an optimisation: failures are swallowed (fail open) except the fail-closed tiers in rule 14.
- Tokens, not hex: colours come from `@anhourmail/ui` tokens (transactional email templates are the only
  exception). Sentence case, display headings weight 500, never bold. Lucide icons only.
- Mail ids, hostnames, numbers and DNS values render in mono.
- Before any commit the user asks for: run `/security-review`, then the `security-audit` skill (quick profile,
  scoped to the pending diff), address confirmed findings, and report both in the summary.

## Document history

| When (UTC) | Who                       | What                                                                                                                               |
| ---------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-21 | Nishchayjeet Singh (Nish) | Created                                                                                                                            |
| 2026-10-21 | Nishchayjeet Singh (Nish) | Rule 53: brand assets single source, Anhourtec logo, no third-party logos; rule 44: production config only in the private ops repo |
| 2026-10-21 | Nishchayjeet Singh (Nish) | Rule 54: /security-review + Cloudflare security-audit skill (quick, scoped) at the end of every session                            |
| 2026-10-21 | Nishchayjeet Singh (Nish) | Rule 23: passwords stored only as salted argon2id hashes (console + mailbox)                                                       |
| 2026-10-21 | Nishchayjeet Singh (Nish) | Rule 55: checkpoint after every slice (handoff + reviews + commit) so a usage-limit stop loses nothing                             |
| 2026-10-22 | Nishchayjeet Singh (Nish) | Rule 56: check GitHub Dependabot, code scanning and secret scanning alerts every session; fix or record                            |
| 2026-10-22 | Nishchayjeet Singh (Nish) | Rule 57: no competitor names in committed files; design references only in docs/internal/private                                   |
| 2026-10-22 | Nishchayjeet Singh (Nish) | Rule 3: small, granular commits (8–20 per slice), one concern each                                                                 |
| 2026-10-22 | Nishchayjeet Singh (Nish) | Rules 6 and 41: Playwright MCP is local-only, never in CI; run the CI pipeline locally (`npm run ci:local`) before every push      |
| 2026-10-22 | Nishchayjeet Singh (Nish) | Rule 58: no scratch or probe files in the repository                                                                               |
| 2026-10-22 | Nishchayjeet Singh (Nish) | Rule 59: update the README with every push                                                                                         |
| 2026-10-22 | Nishchayjeet Singh (Nish) | Waitlist removed from the product (maintainer decision); sign-up is open (firewalled) or closed                                    |
| 2026-10-23 | Nishchayjeet Singh (Nish) | "Where we are and what's next": development pauses for pre-staging; next phases to production                                      |
| 2026-10-29 | Nishchayjeet Singh (Nish) | "Where we are and what's next": pre-staging running; the work since waits for the next deploy                                      |
| 2026-10-29 | Nishchayjeet Singh (Nish) | Rule 60: sweep every Markdown doc against the code every session; bump `Last updated` on change                                    |
| 2026-10-29 | Nishchayjeet Singh (Nish) | Rule 61: profile data (name, avatar, sender name) has one source and stays in sync across console and webmail                      |
| 2026-10-30 | Nishchayjeet Singh (Nish) | "Where we are and what's next": pre-staging redeployed at 300440a; delegation's webmail side waits for the next deploy             |
| 2026-10-30 | Nishchayjeet Singh (Nish) | Rule 62: no marketing or bulk mail from our own domains; bulk only from customers' verified domains; blocklist response            |
| 2026-10-31 | Nishchayjeet Singh (Nish) | "Where we are and what's next": 3c74f23 pushed for pre-staging; names as one source built                                          |
