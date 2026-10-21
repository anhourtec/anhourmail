# Code map

Where things live and what to change for a task. Update in the same change as any file add, remove or rename
(CLAUDE.md rule 10). Architecture: `01-architecture.md`.

## Where do I change…?

| Task                                                                                           | Files                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A plan limit, price, hostname, port, DNS record, published sending limit                       | `packages/shared/src/{plans,platform,dns,sending}.ts` (one source; docs, site and console import it)                              |
| A role or permission                                                                           | `packages/shared/src/rbac/index.ts` + `docs/internal/roles.md` + `apps/web/src/server/console-nav.ts` (nav) — harness picks it up |
| An audit action name                                                                           | `packages/core/src/audit/catalogue.ts`, then `node scripts/check-audit.mjs --write` (regenerates the table in `audit.md`)         |
| A business rule / service                                                                      | `packages/core/src/<area>/` (domain + repository port + service; writes only via `mutation()`)                                    |
| A database table                                                                               | `packages/adapters/src/db-postgres/schema.ts` → `npm run db:generate -- --name <what>` → log in `migration.md`                    |
| A repository implementation                                                                    | `packages/adapters/src/{memory,db-postgres}/` + contract test in `packages/adapters/src/contract/`                                |
| An API route                                                                                   | `apps/web/src/app/api/**/route.ts` (via `route()`) + `apps/web/src/server/routes.ts` registry                                     |
| Console UI                                                                                     | `apps/web/src/app/(console)/**` (every page has `loading.tsx`)                                                                    |
| Webmail UI                                                                                     | `apps/web/src/app/webmail/**` (served on `mail.*` / dev port 43300)                                                               |
| Marketing site, public docs, changelog, credits                                                | `apps/site/**`, content in `docs/public/**` and `apps/site/content/changelog/`                                                    |
| Stalwart management                                                                            | `packages/stalwart-client/src/management.ts` (JMAP `x:*` objects); dev config in `infra/stalwart/dev-plan.ts`                     |
| Mailbox data (JMAP)                                                                            | `packages/jmap-client/src/index.ts`                                                                                               |
| A periodic job                                                                                 | `apps/worker/src/scheduler.ts` `JOBS` + `apps/worker/src/jobs/*`                                                                  |
| Design tokens, fonts, skeletons, theme switch, wordmark, page header/breadcrumbs, brand assets | `packages/ui/src/**`, `packages/ui/assets/brand/**` (`npm run brand:sync`)                                                        |
| Rate-limit tiers                                                                               | `packages/server/src/rate-limit.ts` + `rate-limits.md`                                                                            |
| Demo data / credentials.md                                                                     | `scripts/seed/{index,people,credentials}.ts`                                                                                      |
| Dev ports                                                                                      | `.env.example` + `docker-compose.yml` + CLAUDE.md table (`npm run ports:check`)                                                   |

## Apps

| Path                                                                                    | What                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/proxy.ts`                                                                 | Host/port routing (console vs webmail) via `server/host-routing.ts`                                                                                                     |
| `apps/web/src/server/http/route.ts`                                                     | `route()` wrapper: request id, rate limit, origin check, error mapping, access log                                                                                      |
| `apps/web/src/server/routes.ts`                                                         | API route registry (guard per route) used by the RBAC harness                                                                                                           |
| `apps/web/src/server/container.ts`                                                      | Composition root: Postgres unit of work + Redis counter (memory in tests)                                                                                               |
| `apps/web/src/server/auth/{instance,actor}.ts`                                          | better-auth instance (via adapter) and session → `Actor`                                                                                                                |
| `apps/web/src/server/health.ts`                                                         | `/api/health` (liveness) and `/api/health/ready` (Postgres, Redis, Stalwart)                                                                                            |
| `apps/web/src/server/console-nav.ts`                                                    | Console navigation derived from the permission matrix                                                                                                                   |
| `apps/web/src/server/adapters/stalwart.ts`                                              | Stalwart readiness probe (only web file importing the client)                                                                                                           |
| `apps/web/src/app/api/public/waitlist/route.ts`                                         | Waitlist join (example vertical slice)                                                                                                                                  |
| `apps/web/src/app/api/{me,platform/waitlist,platform/audit,accounts/[accountId]/audit}` | Read routes for the slice                                                                                                                                               |
| `apps/web/src/app/(console)/`                                                           | Sign-in, sign-up (first/last/display name), forgot/reset password, the access-aware home; shared `components/auth-split.tsx`, `password-input.tsx`, `console-shell.tsx` |
| `apps/web/src/server/mail/system-email.ts`                                              | System emails (waitlist confirmation, invite, password reset): text + minimal HTML, sent to Mailpit in dev                                                              |
| `apps/web/src/app/api/public/waitlist/confirm/route.ts`                                 | Double opt-in confirmation (token by POST, generic 400 on bad/expired)                                                                                                  |
| `apps/web/src/app/api/platform/waitlist/[entryId]/invite/route.ts`                      | Staff invite from the waitlist (`waitlist.manage`); emails the sign-up link, never returns the token                                                                    |
| `apps/web/src/components/invite-button.tsx`                                             | Console waitlist row action                                                                                                                                             |
| `apps/site/`                                                                            | Next.js marketing site + Fumadocs `/docs` (content `docs/public`), `/changelog`, `/credits`                                                                             |
| `apps/worker/src/scheduler.ts`                                                          | Scheduler loop + heartbeat; job `audit-verify` checks every audit hash chain                                                                                            |

## Packages

| Path                       | What                                                                                                                                                                | Imports                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/shared`          | Facts, RBAC matrix, request schemas, generated credits                                                                                                              | zod                                                         |
| `packages/core`            | Domain: actor/authorize, errors, ports, `mutation()`, audit (hash chain), waitlist (double opt-in), invite, tokens, account (sign-up provisioning), security events | shared, server/log                                          |
| `packages/adapters`        | memory + Postgres (Drizzle) repositories, migrations, contract tests, better-auth adapter (argon2id, sign-up names, reset hooks), mail adapter (nodemailer)         | core, drizzle, pg, better-auth, @node-rs/argon2, nodemailer |
| `packages/server`          | Logger (redaction), request context, client IP, rate limiter, health probe, Redis client                                                                            | ioredis                                                     |
| `packages/stalwart-client` | Stalwart JMAP management client (MIT)                                                                                                                               | —                                                           |
| `packages/jmap-client`     | JMAP mail client (MIT, browser-safe)                                                                                                                                | —                                                           |
| `packages/ui`              | Tokens, type scale, fonts, skeletons, theme switch, Anhourtec logo, brand assets                                                                                    | next, next-themes, lucide                                   |
| `packages/config`          | tsconfig bases                                                                                                                                                      | —                                                           |

## Scripts and checks

| Script                                                   | Purpose                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `scripts/dev.mjs`, `dev-mail-proxy.mjs`, `dev-reset.mjs` | `npm run dev` / webmail dev port / `npm run dev:reset`                                 |
| `scripts/seed/`                                          | `npm run db:seed [-- --demo]`, writes `credentials.md`                                 |
| `scripts/dev-verify.ts`                                  | `npm run stack:verify`: JMAP delivery, Mailpit capture, no egress                      |
| `scripts/rbac-e2e.ts`                                    | `npm run test:rbac`                                                                    |
| `scripts/e2e-fixtures.ts` + `tests/e2e/`                 | `npm run test:e2e` (Playwright)                                                        |
| `scripts/check-*.mjs`                                    | skeletons, logging, docs, spdx, audit, credentials, licences, ports, brand             |
| `scripts/third-party-notices.mjs`                        | `THIRD_PARTY_NOTICES.md` + `packages/shared/src/credits.generated.ts`                  |
| `infra/stalwart/dev-plan.ts`                             | Dev Stalwart: relay to Mailpit, Pyzor off, 587 listener, pinned WebUI bundle, dev.test |
