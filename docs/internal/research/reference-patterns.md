# Reference patterns for AnhourMail

Date: 2026-10-21

Sources (read only; nothing in either repo was changed):

- `/Users/nish/Development/Websites/iotkinect-portal`: the root contributor-rules file and the Next.js rules block it imports, `docs/branding.md`, `docs/typography.md`, `docs/architecture.md`, `docs/codemap.md`, `docs/rate-limits.md`, `docs/migration.md`, `docs/handoff.md` (structure only), `src/server/http/{route,access-log,rate-limit,errors,page,request-meta,client-ip}.ts`, `src/server/{log,request-context,health,redis,env}.ts`, `src/server/crypto/secrets.ts`, `src/server/auth/actor.ts`, `src/app/api/health/route.ts`, `src/app/api/health/ready/route.ts`, `src/app/api/v1/audit/route.ts`, `src/components/portal/skeletons.tsx`, `src/styles/ik.css`, `src/app/globals.css`, `src/lib/fonts/brand.ts`, `src/lib/preferences/theme-utils.ts`, `docker-compose.yml`, `deploy/{Dockerfile,build.sh,docker-compose.prod.yml}`, `deploy/nginx/{cloudflare.conf,snippets/*.conf}`, `deploy/certbot/*` (listing), `scripts/{check-skeletons.mjs,check-logging.mjs,scheduler.ts,docker-entrypoint.mjs,rate-limit-check.ts}`, `.husky/pre-commit`, `biome.json`, `package.json`, `tsconfig.json`, `next.config.mjs`, `drizzle.config.ts`, `components.json`, `.gitignore`, `bitbucket-pipelines.yml`, installed versions from `node_modules/*/package.json`. (`docker/` is empty.)
- `/Users/nish/Development/Websites/BookYourPTO-Frontend`: `package.json`, `nuxt.config.ts`, `content.config.ts`, `netlify.toml`, `app.vue`, `pages/index.vue`, `pages/contact/index.vue`, `pages/blog/*`, `components/{Header,Footer}.vue`, `components/sb/*`, `assets/css/shotbase.css`, `plugins/posthog.client.ts`, `composables/useCookieConsent.ts`, `content/blog/*.md`, `content/announcements/*.md`, installed versions from `node_modules`.

---

## Summary

- **iotkinect-portal** is the engineering template: Next.js 16.3.8 App Router, React 19.2.7, TypeScript 5.9.3 strict, Tailwind 4.3.1 + shadcn (CLI 4.21.2, `radix-nova` style), better-auth 1.6.22, drizzle-orm 0.45.2 / drizzle-kit 0.31.10 on Postgres 17, ioredis 6.0.0 on Redis 7, zod 4.4.3, Biome 2.5.1, husky 9.1.7 + lint-staged 16.4.0, Node 22 Alpine images.
- Its best reusable parts are small and self-contained: the `route()` API wrapper (rate limit, CSRF origin check, error mapping, request id, access log), the redacting JSON logger, the Redis fixed-window rate limiter with named tiers, AES-256-GCM secret storage, cheap liveness and readiness endpoints, a single scheduler container, the `loading.tsx` skeleton rule enforced by a pre-commit script, the migration log with rollback levels, and the handoff session log.
- Some things need changing before AnhourMail uses them. The secrets scheme has no key id, so a key cannot be rotated. The rate limiter reads `X-Forwarded-For` without checking that the request came through the proxy. The CSP is too thin for a webmail that renders untrusted HTML. NGINX only covers HTTP; Stalwart has to own the mail ports and their TLS.
- **BookYourPTO-Frontend** is the visual template for marketing: Nuxt 4.2.2, Vue 3.5.25, @nuxt/content 3.9.0, @nuxt/ui 4.2.1, Tailwind 4.1.18, statically generated to Netlify. It follows a Shotbase-style look: General Sans display at weight 500, a single blue accent, big soft cards, dark "night" bands and scroll reveals. It pulls in third-party fonts, analytics (PostHog, a third-party web-analytics service), a third-party form vendor and image CDNs. A privacy-focused mail product must drop all of these.
- **Recommendation:** option (c). Build the marketing site as a Next.js app (`apps/site`) in the same monorepo, statically exported, re-creating the BookYourPTO style as tokens in a shared package. The waitlist goes through a public endpoint in the console app that uses the shared zod schema.

---

## iotkinect-portal

### Stack versions

| Package | Declared | Installed | Notes |
| --- | --- | --- | --- |
| next | ^16.3.8 | 16.3.8 | App Router; `middleware` is `src/proxy.ts` in Next 16; `reactCompiler: true` |
| react / react-dom | ^19.2.7 | 19.2.7 | `babel-plugin-react-compiler` ^1.0.0 |
| typescript | ^5.9.3 | 5.9.3 | strict, `moduleResolution: bundler`, alias `@/*` → `./src/*` |
| tailwindcss | ^4.1.5 | 4.3.1 | via `@tailwindcss/postcss` ^4.3.1, `tw-animate-css` ^1.4.0 |
| shadcn (CLI) | ^4.21.2 | 4.21.2 | `components.json`: style `radix-nova`, baseColor `neutral`, cssVariables, icon lib lucide; `radix-ui` ^1.6.0, `@base-ui/react` ^1.6.0 |
| better-auth | ^1.6.22 | 1.6.22 | email + password, `twoFactor` plugin, Redis secondary storage |
| drizzle-orm / drizzle-kit | ^0.45.2 / ^0.31.10 | 0.45.2 / 0.31.10 | `pg` ^8.22.0 pool |
| ioredis | ^6.0.0 | 6.0.0 | |
| zod | ^4.4.3 | 4.4.3 | env + request bodies (`z.iso.datetime()`, `z.uuid()` v4 API) |
| @biomejs/biome | ^2.5.1 | 2.5.1 | lint + format, no ESLint/Prettier |
| husky / lint-staged | ^9.1.7 / ^16.4.0 | 9.1.7 / 16.4.0 | |
| Others | | | lucide-react ^1.21.0, sonner ^2.0.7, react-hook-form ^7.80.0 + @hookform/resolvers ^5.4.0, @tanstack/react-table ^8.21.3, zustand ^5.0.14, nodemailer ^10.0.15, geist ^1.7.2, marked ^18.1.0, gray-matter ^4.0.3, tsx ^4.22.4, @playwright/test ^1.63.0, @types/node ^22.20.0 |
| Runtime images | | | `node:22-alpine`, `postgres:17-alpine`, `redis:7-alpine`, `nginx:stable-alpine`, `axllent/mailpit:latest` (dev) |

### Patterns

Each pattern is marked **ADOPT VERBATIM** (copy the shape as is), **ADAPT** (keep the idea, change specifics) or **SKIP**.

#### 1. `route()` API wrapper: ADAPT (mostly verbatim)

File: `src/server/http/route.ts`.

```ts
type Handler<C> = (req: Request, ctx: C) => Promise<Response>;
export function route<C>(handler: Handler<C>, opts: { limit?: RateLimit } = {}): Handler<C>;
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>>; // 400 "Request body must be JSON." / ZodError
export const ok = (data: unknown, status = 200) => NextResponse.json({ data }, { status });
```

What `route()` enforces, in order:

1. `logged()` wrapper: request context in AsyncLocalStorage, the request id, and one access-log line.
2. Rate limit. The default is `LIMITS.read` for GET/HEAD/OPTIONS and `LIMITS.write` for everything else; `opts.limit` overrides it. Over the limit: 429. Under it: `RateLimit-*` headers on the response.
3. Same-origin check on non-safe methods. `Origin` must equal `originForHost(host)`; otherwise it throws `forbidden("Cross-origin request blocked.")`. This is the CSRF defence for cookie auth.
4. Error mapping:
   - `HttpError` → `{ error: { code, message } }` with its status.
   - `ZodError` → 400 `bad_request` with the first issue's message.
   - Anything else → logged with its stack, and the client gets 500 `{ code: "server_error", message: "Something went wrong." }`.
   - In every case `noteErrorCode()` records the code for the access log.

What `route()` does **not** do: authentication, permission and ownership checks. Handlers call them explicitly and services re-check them:

- `requireActor()` → 401 `unauthorized`.
- `requirePermission(p)` → 403.
- `requireOrgAccess(actor, orgId)` → **404, never 403**, so another tenant's ids are never confirmed.

These guards live in `src/server/auth/actor.ts`. Errors come from `src/server/http/errors.ts`:

```ts
class HttpError extends Error { constructor(readonly status: number, message: string, readonly code = "error") }
unauthorized() // 401 "Sign in to continue."
notFound(what?) // 404, also for out-of-scope
forbidden(msg?) // 403
badRequest(msg) // 400
conflict(msg) // 409
```

Pages use `guardPage(fn)` (`src/server/http/page.ts`). It sends 401 to `/login` and 403/404 to the not-found page, passes Next control flow through with `unstable_rethrow`, and logs anything else with the `x-request-id` header.

A typical handler:

```ts
export const GET = route(async (req) => {
  const actor = await requireActor();
  return ok(await listAudit(actor));
});
```

Business logic lives in `src/server/services/*`. Services take the `Actor` and check permission and scope themselves, so a new caller can't forget.

**For AnhourMail, adapt as follows:**

- Keep the signature, the envelope (`{ data }` / `{ error: { code, message } }`) and the 404-for-out-of-scope rule. Mailbox, domain and alias ids must never be confirmed across accounts.
- Consider adding optional `auth: "required" | "public"` and `permission` options, so the guard can't be forgotten. Keep the service-level re-check.
- The codemap says `route()` also refuses EULA acceptance while acting as someone. The current `route.ts` has no such code. Treat that as doc drift and don't copy it.

#### 2. Access log + request id: ADOPT VERBATIM

Files: `src/server/http/access-log.ts`, `src/server/request-context.ts`, `src/server/http/request-meta.ts`.

`logged<C>(handler)` wraps a handler:

- It sets up a `RequestContext { requestId, userId?, orgId?, orgKind?, leaf?, actingAs?, errorCode? }` in AsyncLocalStorage. Nested calls log once.
- The request id comes from `requestIdFrom(headers)`: a valid `X-Request-Id` (`/^[A-Za-z0-9._-]{8,128}$/`, NGINX sends a 32-hex `$request_id`) or else `randomUUID()`.
- It writes one line: `msg: "request"` with `method`, `path` (no query string, token path segments replaced by `[redacted]`, max 512 characters), `status`, `durationMs`, `ip`, `host`, `userId`, `orgId`, `orgKind`, `leaf`, `actingAs`, `userAgent` (200 characters), `errorCode`.
- Level comes from the status: 5xx error; 401/404 info; other 4xx warn; `/api/health*` debug.
- It always sets `X-Request-Id` on the response, cloning the response when its headers are immutable.
- Unhandled throws become a generic 500.

`getActor()` calls `noteActor()` to record who made the request; `route()` calls `noteErrorCode()`.

Public handlers that can't use `route()` (the auth library, webhooks, health, branding assets) use `logged(rateLimited(LIMITS.x, handler))`.

For AnhourMail, change `TOKEN_PATHS` to fit its own routes (invite, reset, unsubscribe and waitlist-confirm links).

#### 3. Logger: ADOPT VERBATIM (rename service)

File: `src/server/log.ts`. It has no dependencies and deliberately does not import `server-only` or env, so the proxy and edge code can use it.

```ts
export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Logger = {
  trace|debug|info|warn|error|fatal(msg: string, ctx?: Record<string, unknown>): void;
  at(level, msg, ctx?): void;
  child(bindings): Logger;
  enabled(level): boolean;
};
export const log: Logger;           // usage: log.child({ component: "domains" }).warn("…", { err })
export function redact(value, withStack?, depth?, seen?): unknown;
export function setLogContextProvider(fn); // request-context registers { requestId }
export function setLogSinkForTests(fn | null);
```

Output and behaviour:

- One JSON line per call on stdout: `{ time (ISO), level, msg, service: "portal", env, requestId?, ...bindings, ...ctx }`.
- `LOG_LEVEL` is one of trace / debug / info (default) / warn / error / fatal / silent.
- `LOG_PRETTY=true` prints a short human line, outside production only.

Redaction:

- By key, at any depth. Keys are compared lower-cased with `-` and `_` removed. Matches are replaced with `"[redacted]"`.
- `Bearer|Basic <token>` inside strings is masked.
- Strings are truncated at 2000 characters, depth is capped at 6, arrays at 50 items, and cycles become `"[circular]"`.
- Errors become `{ type, message, code?, stack? }`; the stack is kept only at error and fatal.
- `Headers` objects are redacted per header.

`REDACT_KEYS` as shipped:

```
authorization proxyauthorization cookie cookies setcookie password newpassword currentpassword
passwordencrypted smtppassword token apitoken accesstoken refreshtoken idtoken sessiontoken
verificationtoken invitetoken resettoken tokenhash secret otp totpuri backupcodes backupcode
twofactorsecret clientsecret webhooksecret betterauthsecret apikey xapikey privatekey keypem
customkeyenc csrkeyenc netlifysecret netlifysecretencrypted netlifywebhooksecret cloudflaretoken
cloudflareapitoken cloudflaretokenencrypted tokenencrypted encryptionkey smtpencryptionkey
xhubsignature xhubsignature256 requestbody responsebody reqbody resbody
```

For AnhourMail, add these keys: `dkimprivatekey`, `appPassword`, `jmapToken`, `stalwartAdminPassword`, `masterPassword`, `recoveryCode`, `subject`, `body`, `htmlBody`, `textBody`, `attachments`, `raw`, `mime`, `headers`. Message content and subjects must never reach logs. Also consider redacting recipient addresses (`to`, `cc`, `bcc`, `from`) or hashing them.

Enforcement: `scripts/check-logging.mjs` (`npm run check:logging`) fails on `/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/` in `src/server`, `src/app/api` and `src/proxy.ts`. CLI scripts may print. It runs in the pre-commit hook. `scripts/logging-check.ts` (`test:logging`) runs offline tests of fields, redaction and request ids.

#### 4. Rate limiting: ADAPT

File: `src/server/http/rate-limit.ts`; documented in `docs/rate-limits.md`.

```ts
type RateLimit = { limit: number; windowSec: number; by?: "caller" | "ip" };
export const LIMITS = {
  read:        { limit: 600, windowSec: 60 },              // GET default, per session else IP, per endpoint
  write:       { limit: 120, windowSec: 60 },              // non-GET default
  publicForm:  { limit: 30,  windowSec: 900,  by: "ip" },  // signed-out forms
  invite:      { limit: 60,  windowSec: 900,  by: "ip" },
  publicAsset: { limit: 600, windowSec: 60,   by: "ip" },
  webhook:     { limit: 60,  windowSec: 60,   by: "ip" },
  auth:        { limit: 300, windowSec: 60,   by: "ip" },  // outer guard on /api/auth/*
  sensitive:   { limit: 30,  windowSec: 3600 },            // exports, test emails, imports, syncs
  admin:       { limit: 120, windowSec: 3600 },            // invitations, new accounts, hostnames
} as const satisfies Record<string, RateLimit>;
export function checkRateLimit(req, limit, name = endpointKey(req)): Promise<{ allowed: boolean; headers: Record<string, string> }>;
export function rateLimited<C>(limit, handler): Handler<C>;
export function tooManyRequests(headers): Response; // 429 { code: "rate_limited", message: "Too many requests. Wait a moment and try again." }
export function withRateLimitHeaders(res, headers): Response;
export function endpointKey(req): string; // "POST /api/v1/users/:id/invite": uuid / 20+ char segments fold to :id
export function setRateLimitCounterForTests(fn | null): void;
```

How it works:

- The algorithm is a **fixed window** in Redis: `INCR`, plus `EXPIRE windowSec+1` on the first hit.
- The key is `portal:rl:<METHOD path>:<caller>:<windowSec>:<windowIndex>`.
- The caller is `s:<sha256(session cookie) base64url first 22 chars>`, or else `ip:<first X-Forwarded-For>`.
- Response headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus `Retry-After` when over.
- **It fails open.** Any Redis error is logged at warn and the request is allowed.
- `/api/health*` is exempt.
- The auth library's own per-endpoint rules sit inside: sign-in 20/min, OTP send 10/min, verify 30/min, and 10 failed codes lock the account for 15 minutes.
- Tests: `scripts/rate-limit-check.ts` covers keys, headers, 429 and fail-open.

**What to change for AnhourMail:**

- In `rate-limit.ts`, `clientIp()` takes the first `X-Forwarded-For` value without checking anything. The separate `src/server/http/client-ip.ts` only trusts that header when `PORTAL_TRUST_PROXY=true`. Use the trust-gated version for limiter keys too, otherwise anyone who reaches the app without going through the proxy can spoof the header and dodge per-IP limits.
- Keep fail-open for ordinary reads and writes. Use **fail-closed** (or a local in-memory fallback) for anything that costs money or reputation:
  - outbound send quotas
  - sign-up and waitlist submissions
  - password reset
  - alias creation

  A Redis outage must never let a spammer send unlimited mail.
- Consider sliding-window or token-bucket counters for per-account send quotas, for example messages per hour and per day, and recipients per message.
- Change the key prefix to `am:rl:`.

#### 5. Secrets at rest: ADAPT

File: `src/server/crypto/secrets.ts`.

```ts
export function encryptSecret(plain: string): string;        // "v1:<iv>:<tag>:<ciphertext>" all base64url
export function decryptSecret(stored: string): string | null; // null on wrong key / tamper / bad format
```

How it works:

- AES-256-GCM with a 12-byte random IV and the 16-byte auth tag stored separately.
- The key is `sha256(SMTP_ENCRYPTION_KEY)`, or, when that is unset, `sha256(BETTER_AUTH_SECRET + ":smtp-password")`. The entrypoint only warns when the dedicated key is missing.
- The `v1` prefix is a format version only. There is **no key id**, so rotating the key makes every stored secret unreadable.

The surrounding policy (rule 28) is good and worth adopting:

- Secrets are write-only in the API and UI. The UI shows `hasX` and at most the last 4 characters, with the placeholder "Saved (ends in abcd) — leave blank to keep".
- Secrets are never logged or audited. The audit entry records `tokenChanged: true/false` instead.
- Precedence is database over environment per field, with a 15-second cache.
- Managing secrets is an admin-only critical permission.
- Each integration has a "Test connection" action that reports plain error categories, plus a stored, periodic health check.

**For AnhourMail:**

- Write the format as `v1:<kid>:<iv>:<tag>:<ct>` and keep a key ring (`AM_SECRETS_KEYS=kid1:base64,kid2:…` plus `AM_SECRETS_ACTIVE_KID`). Encrypt with the active key, decrypt with any key in the ring, and add a re-encrypt job to the scheduler.
- Derive the key with HKDF from 32 random bytes rather than a bare SHA-256 of a passphrase.
- Make the key **required** in production. Never derive it from the auth secret.
- Pass AAD such as `table:column:rowId` so a ciphertext can't be moved to another row.
- This covers stored DKIM private keys, Stalwart admin credentials and third-party tokens. Message bodies are Stalwart's concern and get separate storage encryption.

#### 6. Health endpoints: ADOPT VERBATIM

Files: `src/server/health.ts`, `src/app/api/health/route.ts`, `src/app/api/health/ready/route.ts`.

- `GET /api/health` is liveness. It returns `{ status: "ok", uptimeSeconds, version }`. `version` is `GIT_SHA` when it matches `/^[0-9a-zA-Z._-]{1,64}$/`, else the `package.json` version. It touches no database, Redis or network, is wrapped in `logged()`, and sends `Cache-Control: no-store`.
- `GET /api/health/ready` is readiness. It returns `{ status: "ok" | "unavailable", checks: { database: { ok, latencyMs }, redis: {…}, <optional informational>… } }`: 200 when Postgres (`select 1`, 2000 ms timeout) and Redis (`PING`, 1000 ms) both answer, otherwise 503.
- Each probe is a `Promise.race` with a timeout and swallows late rejections. Results are memoised for 2 seconds.
- Optional dependencies are reported but do not affect the status.
- Both endpoints are public on any hostname and contain no secrets, hostnames, error text or stacks. NGINX does not log them. They are not rate-limited.
- Rule 27: every new external dependency joins readiness, marked critical or optional.

For AnhourMail, readiness should include:

- **critical:** Postgres and Redis
- **critical for webmail, optional for the console:** Stalwart's JMAP session endpoint or management API
- **optional:** the worker heartbeat

Give the worker container the same heartbeat-file healthcheck as the scheduler.

#### 7. Loading skeletons + enforcement script: ADOPT VERBATIM

Files: `src/components/portal/skeletons.tsx`, `.ik-skeleton` in `src/styles/ik.css`, `scripts/check-skeletons.mjs`.

The rule (24): every route that fetches data has a `loading.tsx` next to its `page.tsx`, mirroring the real layout. Client components that are waiting show a skeleton or an in-place pending state of the same size. There are no whole-page spinners and nothing jumps when data arrives.

Skeleton pieces (server components, safe in `loading.tsx`):

| Component | Props | What it renders |
| --- | --- | --- |
| `Bone` | `{ className }` | `<div aria-hidden className="ik-skeleton …">` |
| `SkeletonPage` | `{ label, children }` | `role="status" aria-live="polite" aria-busy="true"` and an `sr-only` label |
| `PageHeaderSkeleton` | `{ actions = 0, lead = true }` | eyebrow `h-3 w-28`, title `h-8 w-64`, lead `h-4 w-96`, action bones `h-7 w-24` |
| `KpiSkeleton` | `{ count = 4 }` | card grid `rounded-xl border bg-card p-5` |
| `ChartSkeleton` | `{ height = "h-72", className }` | |
| `TableSkeleton` | `{ rows = 6, columns = 5, title = true }` | toolbar, header row `h-11`, body rows `h-14` with avatar, pagination |
| `TabsSkeleton` | `{ tabs = 4 }` | |
| `TextBlockSkeleton` | `{ lines = 14, boxed = true }` | cycling widths |

The shimmer CSS:

```css
.ik-skeleton { border-radius: .375rem; background: linear-gradient(90deg, var(--muted) 0%, var(--accent) 50%, var(--muted) 100%);
  background-size: 200% 100%; animation: ik-shimmer 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ik-skeleton { animation: none; } }
@keyframes ik-shimmer { from { background-position: 100% 0 } to { background-position: -100% 0 } }
```

`check-skeletons.mjs` walks `ROOTS = ["src/app/(portal)", "src/app/(auth)"]` and exits 1 listing every directory that has a `page.tsx` without a `loading.tsx`. It runs in the pre-commit hook.

For AnhourMail:

- Set `ROOTS` to the console and webmail route groups, e.g. `apps/console/src/app/(console)`, `(auth)`, `(mail)`.
- Add mail-specific skeletons: message list rows, a reading pane, the folder tree and the composer.

#### 8. Pre-commit hook: ADAPT

`.husky/pre-commit` runs:

1. `npm run generate:presets && git add src/lib/preferences/theme.ts`. This is template-specific: **SKIP**.
2. `npm run check:skeletons`
3. `npm run check:logging`
4. `npm exec -- lint-staged`, where `lint-staged` runs `"*.{js,ts,jsx,tsx}": ["biome check --write --no-errors-on-unmatched"]`.

`package.json` has `"prepare": "husky"`.

Typecheck is not in the hook; it runs by hand. For AnhourMail, add `tsc --noEmit` to the hook through turbo or the workspace filter, scoped to changed workspaces, if it is fast enough.

#### 9. Biome config: ADOPT VERBATIM

File: `biome.json` (schema 2.5.1).

Formatter:

- 2 spaces, LF, line width **120**
- double quotes (JS and JSX), semicolons always, trailing commas all, arrow parentheses always
- `useEditorconfig: true`

Import groups, separated by blank lines: `react`, `react/**`, then `next/**`, then `:PACKAGE:`, then `:ALIAS:`, then `:PATH:`.

Ignored: `.next`, `dist`, `out`, `node_modules`, `.husky`, `src/components/ui` (generated shadcn components) and one vendored component directory.

Linter is `recommended` plus:

- **correctness:** `noUndeclaredVariables`, `noNestedComponentDefinitions`, `noUndeclaredDependencies`
- **nursery:** `useSortedClasses` on; `useNullishCoalescing`, `noFloatingPromises`, `noMisusedPromises` as errors
- **style:** `noCommonJs`, `noNamespace`, `useAsConstAssertion`, `useSelfClosingElements`, `noParameterAssign`, `noInferrableTypes`, `noUselessElse`, `useFilenamingConvention` as errors; `noNestedTernary`, `noHeadElement` as warnings
- **suspicious:** `noImportCycles` and `noEmptyBlockStatements` as errors; `noArrayIndexKey` and `noUnnecessaryConditions` as warnings; `noUnknownAtRules` off (for Tailwind)
- **performance:** `noImgElement` warn
- **domains:** `next` and `react` recommended
- **CSS parser:** `tailwindDirectives: true`

Code rule (15): zero `any`, no `@ts-ignore`, and a `biome-ignore` only with a specific rule and a real reason.

#### 10. TypeScript / Next / drizzle config: ADOPT VERBATIM / ADAPT

**`tsconfig.json`:** target ES2017, `strict`, `noEmit`, `module: esnext`, `moduleResolution: bundler`, `resolveJsonModule`, `isolatedModules`, `jsx: react-jsx`, `incremental`, the `next` plugin, `paths { "@/*": ["./src/*"] }`.

In a monorepo, put a `tsconfig.base.json` in `packages/config` and consider adding `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

**`next.config.mjs`:**

- `logging.incomingRequests: false`, because Next's dev log prints raw token paths.
- `reactCompiler: true`
- `turbopack.root`
- `allowedDevOrigins`: `*.localhost` plus the primary hosts
- `compiler.removeConsole` in production, except error and warn

Security headers on `/:path*`:

```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
```

HSTS (`max-age=63072000; includeSubDomains`) is added only when `PORTAL_PROTOCOL=https` at build time.

**ADAPT for webmail:** use a full nonce-based CSP: `default-src 'self'`, `script-src 'self' 'nonce-…' 'strict-dynamic'`, `img-src` limited to `self`, `data:` and the image proxy only, `connect-src` to the JMAP origin, `frame-src` limited to the sandboxed message frame. Render email HTML in a `sandbox` iframe (no `allow-scripts`) after server-side sanitising, and route remote images through a proxy with images blocked by default. Use `Referrer-Policy: no-referrer` for webmail.

**`drizzle.config.ts`:** `{ schema: "./src/server/db/schema.ts", out: "./drizzle", dialect: "postgresql", dbCredentials: { url: process.env.DATABASE_URL ?? "" }, strict: true }`.

Scripts:

- `db:generate` = `drizzle-kit generate` (with `-- --name <what>`)
- `db:migrate` = `node --env-file-if-exists=.env node_modules/.bin/drizzle-kit migrate`
- custom data migrations: `drizzle-kit generate --custom --name <what>`

**Env:** `src/server/env.ts` is a zod schema read lazily through `env()`. Comma lists are transformed to arrays and `"true"`/`"false"` enums to booleans. Optional secrets use `z.preprocess(v => v === "" ? undefined : v, z.string().optional())`.

#### 11. Container entrypoint: ADOPT VERBATIM (adapt `checkConfig`)

File: `scripts/docker-entrypoint.mjs`. `node scripts/docker-entrypoint.mjs [migrate]`:

1. `checkConfig()` lists required settings, giving name, reason and an example, never values. Missing settings are logged as JSON errors and the container refuses to start. Risky settings get warnings.
2. It waits for Postgres (`select 1`) and Redis (`PING`), retrying every 2 seconds until `STARTUP_WAIT_SECONDS` (default 60). Connection strings are logged with the password masked.
3. It runs migrations unless `SKIP_MIGRATIONS=true`. The `migrate` mode migrates and exits, for one-off jobs.
4. It starts the app.

Rule: a new required setting is added to `checkConfig()`.

#### 12. Scheduler container: ADAPT

File: `scripts/scheduler.ts`.

```ts
type Job = { name: string; script: string /* npm script */; every: number /* ms */; timeout: number; okCodes: number[]; enabled: boolean };
export const JOBS: Job[];
```

How it works:

- One loop runs jobs **one at a time**. Each job is spawned as `npm run --silent <script>` with the same environment; its last 2 KB of output is kept for the log only.
- Timeouts send SIGTERM, then SIGKILL 10 seconds later.
- The first runs happen 30 seconds after start, and each job's next run counts from when it last started.
- A heartbeat file (`/tmp/scheduler-heartbeat`) is written every 30 seconds. The container healthcheck is `find /tmp/scheduler-heartbeat -mmin -2 | grep -q .`.
- Failure notifications go out once per failure streak, plus a "recovered" message.
- SIGTERM waits for the running job. `SCHEDULER_DRY_RUN=true` is for tests.

Rule 29: periodic work is a `JOBS` entry plus a check in `npm run test:scheduler`. Never a host crontab.

For AnhourMail:

- Keep this for periodic jobs: DNS and DKIM checks for customer domains, secret re-encryption, waitlist cleanup, quota roll-ups, certificate expiry.
- Run the separate **worker** container on a real queue: Redis streams or BullMQ, or Postgres `SKIP LOCKED`. It handles event-driven work such as provisioning Stalwart accounts, sending transactional mail and processing Stalwart webhooks.
- The worker uses the same heartbeat healthcheck.

#### 13. Redis cache helpers: ADOPT VERBATIM

File: `src/server/redis.ts`.

- `redis()` is a singleton on `globalThis` with `maxRetriesPerRequest: 2`.
- `cacheKeys` is one object listing every key builder.
- `cacheGet<T>` / `cacheSet(key, value, ttl)` swallow every failure: "Redis is an optimisation".
- Invalidation sits next to the write.

#### 14. Migration log: ADOPT VERBATIM

File: `docs/migration.md` (rule 31). Newest first. Its parts:

- **How migrations run:** they run automatically on container start, and there are no down migrations.
- **When did a migration run on a server?** `select id, to_timestamp(created_at/1000) from drizzle.__drizzle_migrations order by id`.
- **Back up before a destructive release:** `pg_dump -Fc` through `docker compose exec -T postgres`, and `pg_restore --clean --if-exists` to restore.
- **Rollback levels:**
  - **Safe**: additive only.
  - **Caution**: additive, but older code may meet data it doesn't understand, such as a new enum value.
  - **Not recommended**: drops or renames; restore a backup instead of rolling back.
- **Summary table:** `| # | Migration | Commit | Date | Change | Rollback |`.
- **Details:** one `### 0025_name · \`<sha>\` · YYYY-MM-DD · <level>` section each, with **Added / Changed / Removed / Data / Rollback** bullets.

Destructive changes use three steps: add, move the data, then finish and drop. They are called out in the handoff and in the commit message. Never edit an applied migration.

#### 15. Handoff log: ADOPT VERBATIM

`docs/handoff.md` (rule 25) is **gitignored** and lives on the working machine only. Its structure:

1. A one-paragraph purpose statement, with links to architecture, roles, codemap and domains docs.
2. **"Current state (date)"**: branch and remote; the check results at the last commit (biome, typecheck, each `test:*` harness with pass counts such as `1014/1014`, browser coverage); how to run locally; "What it has" (feature bullets).
3. **"Sessions"**: newest first, `### YYYY-MM-DD — <what shipped>`, covering what changed, how it was verified, and any local data or `.env` changes.
4. **"Open items and decisions"**: add new ones, remove resolved ones.

Read it at the start of every session and update it before every commit.

#### 16. Codemap + architecture docs: ADOPT

- `docs/codemap.md` (rule 16) has a "Where do I change…?" task-to-files table, then per-file rows with what the file does, what it imports and what uses it. It is updated in the same change as any file add, remove or rename.
- `docs/architecture.md` has a stack table, a mermaid request-flow diagram plus an ASCII summary, then a section per subsystem.

#### 17. Contributor rules file: ADAPT

These are the numbered rules worth carrying over. The numbering has gaps in the source.

| # | Rule |
| --- | --- |
| 1 | Commit messages are written as a human author, with no tool attribution. |
| 2 | Never commit or push without explicit permission in that message. |
| 3 | Group commits by topic (infra, schema, auth, RBAC, UI, docs); never one mega-commit. |
| 4 | Verify before declaring done: real browser flow plus the access-control harness, not just typecheck. Commands: `biome check <files>`, `npm run typecheck`, `test:*` harnesses, `check:skeletons`, `check:logging`. |
| 5 | Run a security review on everything written. Every route enforces both permission and org scope; out-of-scope ids return 404. |
| 6 / 9 | Browser-check UI changes in light and dark, at 1440 and 390 wide, on the default host and a tenant host, and read the console. Drive finished features end to end as each affected role. |
| 7 | Stay narrow and ship complete work: no scope creep, no TODOs. |
| 8 | Docs reflect the working state before a commit. |
| 14 | Browser screenshots go only in gitignored `.playwright-mcp/`. |
| 15 | biome + tsc clean on every changed file: zero `any`, no blanket ignores. |
| 16 | Keep the codemap current. |
| 18 / 20 / 21 / 22 | Full RBAC CRUD verification for every role leaf. Every feature is org-scoped and role-gated: permission in `permissions.ts`, granted in `ROLE_PERMISSIONS`, enforced in the service, hidden in the UI, checked in `scripts/rbac-e2e.ts`. The harness must pass before commit. `docs/roles.md` stays current. |
| 24 | Every page and every waiting component has a loading skeleton (enforced). |
| 25 | Keep the handoff current every session. |
| 26 | Logging only through `log.ts`; every API handler goes through `route()` or `logged()`; never log secrets or bodies; new secret keys go in `REDACT_KEYS`. |
| 27 | Health endpoints stay cheap, public and non-sensitive. |
| 28 | Third-party secrets follow the certificate-service pattern (see pattern 5). |
| 29 | Deployment rules: `nginx -t` in `nginx:stable-alpine` for both modes, `docker compose -f deploy/docker-compose.prod.yml config --quiet`, the request-id chain, scheduled work only in the scheduler, new required settings in `checkConfig()`, CI scripts pass `bash -n` and ShellCheck. |
| 30 | Every endpoint has a rate limit. |
| 31 | Every migration is logged with its rollback level. |

Other carry-overs:

- **Ports:** never use common ones.
- **Document history:** a table at the bottom of the rules file, `| When (UTC) | Who | What |`, append-only.
- **Project rules:** services hold the logic and route handlers only parse and call; never trust the client for scope; Redis failures are swallowed; tokens only, no hex in components.

#### 18. Things to SKIP

- The white-label and tenant hostname machinery: per-host auth instances, Cloudflare for SaaS, partner certificates. AnhourMail customer domains are mail domains, a different problem.
- EULA versioning, roadmap and calendar.
- Template leftovers: theme presets, the font registry, `generate:presets` in the hook.
- The docs-sync webhook.
- Mailpit **SKIP for prod, ADOPT for dev**. In AnhourMail, local Stalwart can play this role, but Mailpit is still useful as a sink for outbound transactional mail tests.

---

## Design system

### Principles

From `docs/branding.md`:

- Say what it does, fast: a title that names the task, no welcome copy.
- **Light is light, dark is navy (never pure black).**
- Open, not boxy: hairlines and whitespace; cards only for real objects; never cards inside cards.
- Calm motion: 150–200 ms ease-out only; no loops except skeletons; no glows, parallax or gradient text; respect `prefers-reduced-motion`.
- Truthful: no invented stats or testimonials.
- Sentence case everywhere.
- One primary button per view.
- Lucide icons only: 16 px inline, 20 px in nav.
- No emoji, no stock photos.

### Colour tokens

In `src/app/globals.css`, raw tokens are space-separated RGB so alpha works: `rgb(var(--ik-ink) / .5)`.

| Token | RGB | Use |
| --- | --- | --- |
| `--ik-ink` | 15 20 30 | headings, primary text |
| `--ik-ink-soft` | 71 80 96 | secondary text |
| `--ik-ink-mute` | 100 110 128 | muted text (the minimum for readable text) |
| `--ik-ink-accent` | 3 105 161 (#0369A1) | accent text in light mode, 5.9:1 |
| `--ik-line` | 226 230 236 | hairlines, borders, inputs |
| `--ik-surface` | 246 248 251 | muted surface |
| `--ik-surface-2` | 238 241 246 | hover / accent surface |
| `--ik-cyan` | 5 189 255 | decorative only (2.3:1 on white) |
| `--ik-cyan-hi` | 56 206 255 | accent text in dark mode |
| `--ik-btn` | 0 119 200 | primary button, white text 4.7:1 |
| `--ik-btn-hi` | 0 101 172 | button hover |
| chart-3 / chart-4 | 29 185 122 / 155 69 176 | green / violet series only |

Semantic shadcn tokens:

| Token | Light | Dark (navy) |
| --- | --- | --- |
| background | 255 255 255 | 7 13 24 |
| card / popover | 255 255 255 | 12 26 46 |
| foreground | ink | white |
| muted / secondary | surface | 17 34 58 |
| accent | surface-2 | 22 42 70 |
| muted-foreground | ink-mute | white / .66 |
| border | line | white / .10 |
| input | line | white / .14 |
| primary | `--brand` (= btn) | `--brand-dark` (= cyan-hi, with ink text) |
| ring | brand / .55 | brand-dark / .60 |
| destructive | 200 38 38 | 248 113 113 |
| sidebar | 248 250 252 | 8 20 38 |

Dark-mode text never goes below white / 60.

Status pill tokens:

| Tone | Text | Tint |
| --- | --- | --- |
| success | 21 115 71 | 29 185 122 |
| warning | 146 84 6 | 245 158 11 |
| danger | 185 28 28 | 220 38 38 |

Pills use tone text on a light tint of the same tone, a hairline ring and a 6 px radius, with **no dot**.

Rules:

- Never use hex in components; email templates are the only exception.
- AnhourMail has no tenants, so drop the `--brand*` indirection or keep it as a single alias.

### Radius

`--radius: 0.5rem` (8 px), with `sm = r−4`, `md = r−2`, `lg = r`, `xl = r+6` (14 px), `2xl = r+8` (16 px).

| Element | Radius |
| --- | --- |
| buttons, inputs | 8 px |
| status badges | 6 px |
| other pills | 999 px |
| framed images | 12 px |
| cards, dialogs, sheets | 14–16 px |

Nothing is ever larger than 16 px in the app.

### Dark mode

- A class-based `.dark` on `<html>`, with Tailwind `@custom-variant dark (&:is(.dark *))`.
- The toggle is a small preferences store (`src/lib/preferences/theme-utils.ts`). It resolves `system` through `matchMedia`, toggles `dark` on `documentElement`, and adds a `disable-transitions` class during the switch. `next-themes` is only a dependency of the toast component.
- **For AnhourMail:** use `next-themes` (attribute `class`, default `system`) or copy the tiny util. Either works.

### Fonts

From `src/lib/fonts/brand.ts`, all self-hosted with no third-party font requests:

| Family | Role | Source | Variables |
| --- | --- | --- | --- |
| General Sans 400/500/600 | display, weight 500 | `next/font/local` from `src/assets/fonts/GeneralSans-*.woff2` (Fontshare, ITF Free Font License) | `--font-general-sans` → `--font-display` / `font-heading` |
| Geist | UI and body | the `geist` package | `--font-sans` |
| Geist Mono | labels, numbers, ids, code | the `geist` package | `--font-mono` |

- A metric-matched fallback is declared: `@font-face { font-family: "General Sans Fallback"; src: local("Arial"); size-adjust: 102%; }`.
- `brandFontVars` goes on `<body>`.
- **For AnhourMail, ADOPT VERBATIM.** Self-hosting is a privacy requirement.

### Type scale

Classes are in `src/styles/ik.css`. For AnhourMail, rename the prefix (for example `am-`).

| Class | Font | Size | Weight | Line-height | Tracking | Use |
| --- | --- | --- | --- | --- | --- | --- |
| `h1` | General Sans | `clamp(1.625rem, 1.3rem + 1vw, 2.125rem)` (26→34 px) | 500 | 1.12 | −0.025em | page title (one per page), `text-wrap: balance` |
| `h2` | General Sans | `clamp(1.25rem, 1.1rem + .5vw, 1.5rem)` (20→24 px) | 500 | 1.2 | −0.02em | section, balance |
| `h3` | General Sans | 1.125rem (18 px) | 500 | 1.3 | −0.01em | card / panel title |
| `h4` | Geist | 0.9375rem (15 px) | 500 | 1.4 | — | item title |
| `lead` | Geist | 1rem | 400 | 1.6 | — | muted, max 68ch |
| `body` | Geist | 0.9375rem | 400 | 1.6 | — | |
| `small` | Geist | 0.8125rem (13 px) | 400 | 1.5 | — | muted |
| `micro` | Geist | 0.75rem (12 px, the minimum) | 400 | 1.4 | — | muted |
| `eyebrow` | Geist Mono | 0.71875rem (11.5 px), uppercase | 500 | — | 0.08em | accent colour; `::before` is a 7 px brand square with 1 px radius |
| `mono` | Geist Mono | 0.6875rem (11 px), uppercase | 500 | — | 0.06em | column labels, muted |
| `num` | Geist Mono | inherit | inherit | — | — | `tabular-nums` |
| `code` | Geist Mono | 0.85em | inherit | — | — | |

Rules:

- Headings are never bold.
- Sentence case. CSS does the uppercasing, so eyebrow text is written in sentence case.
- Numbers, ids and hostnames use mono.
- Light-mode text is never lighter than `ink-mute`.

### Components and conventions worth keeping

- **Page header:** eyebrow, then h1 with actions on the right, then a lead line. No card around the page.
- **Action buttons:** `size="sm"` with a leading Lucide icon (`data-icon="inline-start"`). Only full-page auth submits use `size="lg"` at full width.
- **Destructive actions:** confirmed through `ConfirmButton` (an AlertDialog) that names the thing.
- **Lists:** one shared `DataTable`:
  - title with count
  - search
  - column visibility
  - sortable headers with `aria-sort`
  - bulk select bar
  - row click opens the detail
  - numbered pagination with 10/15/25/50 rows per page
- **Cells:** `StatusBadge`; `DateCell` (mono, `en-CA` "Oct 05, 2026", "Never" when empty); `EntityCell` (initials avatar, name, muted second line); icon-only `RowAction` (32 px, `label` required, which becomes the `aria-label`).
- **Empty states** say what is missing plus one action; no illustrations.
- **Toasts** (sonner) confirm completed actions. Errors that need a decision stay inline.
- **Scrollbars** are transparent until scrolling. A `ScrollbarActivity` component sets `data-scrolling`, which shows the thumb at 28% foreground tint.
- **Responsive checks** at 1440 / 1024 / 390, with no horizontal scroll at 390, tap targets ≥ 40 px and a 16 px gutter.
- **Transactional email:** one plain 570 px layout using tables and inline styles, a VML fallback button for desktop clients that ignore CSS buttons, system fonts, a hidden preheader, a `prefers-color-scheme` dark block and a plain-text part. Hex is allowed only here. **ADOPT** for AnhourMail's own system mail.

---

## Infra and deploy

### Local compose

`docker-compose.yml` sets `name: iotkinect-portal`.

| Service | Image | Host binding | Notes |
| --- | --- | --- | --- |
| postgres | `postgres:17-alpine` | `127.0.0.1:${POSTGRES_HOST_PORT:-47432}:5432` | `pg_isready` healthcheck at 5 s intervals |
| redis | `redis:7-alpine` | `127.0.0.1:${REDIS_HOST_PORT:-47379}:6379` | `--appendonly yes --requirepass`; healthcheck `redis-cli -a … ping | grep PONG` |
| mailpit | `axllent/mailpit` | `127.0.0.1:47025` (SMTP), `127.0.0.1:47026` (UI) | dev only |

The Next.js dev server runs on the host at **3210**.

The port rule: never 3000/5432/6379/1025/8025. Every new service gets a 4xxxx host port, bound to 127.0.0.1, overridable through `.env`, and listed in a table in the rules file. Check a port is free with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.

Suggested AnhourMail ports:

| Service | Port |
| --- | --- |
| console | 3230 |
| webmail | 3231 |
| site | 3232 |
| Postgres | 48432 |
| Redis | 48379 |
| Stalwart HTTP / JMAP / admin | 48080 |
| Stalwart SMTP | 48025 |
| Stalwart submission | 48587 |
| Stalwart IMAPS | 48993 |
| Mailpit | 48026 / 48027 |

Pick a different range from the portal (474xx) so both stacks can run at once.

### Production compose

`deploy/docker-compose.prod.yml` sets `name: iotkinect-portal-prod`.

**nginx** (`nginx:stable-alpine`):

- The only published ports are 80 and 443.
- It depends on `app` being healthy.
- Volumes come from a YAML anchor: `nginx.conf`, `${NGINX_CONF:-cloudflare}.conf` mounted as `conf.d/portal.conf`, snippets, certs, sites, letsencrypt, the certbot webroot, and a shared `/run`.

**certbot** (`profiles: [letsencrypt]`, so it only starts when `COMPOSE_PROFILES=letsencrypt`):

- Shares the PID namespace with nginx (`pid: "service:nginx"`) so it can run `nginx -s reload`.
- Issues certificates every 15 minutes and renews twice a day.

**app** (image `<name>/app:${GIT_SHA:-latest}`, built from `deploy/Dockerfile`):

- `env_file: .env`, plus `DATABASE_URL` and `REDIS_URL` assembled with `${…:?set …}` guards.
- `PORTAL_PROTOCOL=https`, `PORTAL_TRUST_PROXY=true`.
- Healthcheck: `wget -q -O /dev/null http://localhost:3210/api/health`, interval 10 s, start period 40 s.

**scheduler** (same image):

- Command `npm run --silent scheduler`.
- Depends on `app` being healthy, because the app runs the migrations.
- Heartbeat healthcheck.

**postgres** and **redis** have no published ports and use named volumes.

### Image

`deploy/Dockerfile` has two stages:

1. Build: `node:22-alpine`, `npm ci`, `next build` with `NEXT_TELEMETRY_DISABLED=1` and `PORTAL_PROTOCOL=https` (HSTS is decided at build time).
2. Runtime: `node:22-alpine`, `ARG GIT_SHA`, copies the whole `/app`, `EXPOSE 3210`, `CMD ["node","scripts/docker-entrypoint.mjs"]`.

**ADAPT:** use `output: "standalone"` and copy only `.next/standalone`, `.next/static`, `public`, the migrations and the entrypoint. Run as a non-root user and use `npm ci --omit=dev` where possible. The image will be much smaller.

### TLS and proxy

TLS is terminated by **NGINX, not Caddy**. There are two modes.

**Cloudflare mode** (`deploy/nginx/cloudflare.conf`):

- A Cloudflare Origin CA certificate in `deploy/certs/` (never committed), SSL mode Full (strict).
- Optional Authenticated Origin Pulls (mTLS).
- Real client IP restored from `CF-Connecting-IP` (`snippets/cloudflare-real-ip.conf` with an update script).
- Port 80 redirects to 443; `http2 on`.

**Let's Encrypt mode** (`letsencrypt.conf`):

- The certbot container plus `sync-certs.sh`, which reads the hostnames to certify from Postgres.

The proxy snippet (`snippets/proxy-pass.conf`):

- `set $portal_app http://app:3210; proxy_pass $portal_app;`. Using a variable forces per-request DNS through Docker's resolver, so NGINX survives the app container being recreated.
- `X-Forwarded-For`, `-Proto` and `-Host` are **overwritten**, never appended. This is what makes `TRUST_PROXY=true` safe.
- `X-Request-Id $request_id` goes upstream, and the same id goes back to the client: `proxy_hide_header X-Request-Id; add_header X-Request-Id $request_id always`.
- Buffers: `proxy_buffer_size 16k; proxy_buffers 8 16k; proxy_busy_buffers_size 32k`, for large Link and cookie headers.
- Timeouts: connect 5 s, send and read 60 s. WebSocket upgrade headers are set.
- `location ^~ /api/health { access_log off; }`.

Logging (`snippets/logging.conf`):

- A `json_combined` log format to stdout: time, request_id, remote_addr, x_forwarded_for, host, method, uri, args_present, status, bytes, request_time, upstream timing and status, user agent, referer, ssl_protocol, server_name.
- `uri` is the path only. `$args` is replaced by a boolean `args_present`. Token path segments and the referer are redacted with `map` regexes.

### CI/CD

- `bitbucket-pipelines.yml` is thin: it calls `.cicd/build.sh` (on Bitbucket's cloud, which saves the image as an `app-image.tar.gz` artifact; no registry) and `.cicd/deploy.sh` (on a self-hosted runner on the server, so no inbound SSH).
- Markdown-only pushes don't deploy.
- `deploy/build.sh` is the manual equivalent:
  1. `down --remove-orphans`
  2. remove this project's images
  3. `build --no-cache --pull`
  4. `up -d`
  5. poll `compose ps` for `app` health (60 tries, 5 s apart); on failure, print the last 50 log lines.
- **For AnhourMail, ADAPT** this to GitHub Actions, or whichever forge is chosen, keeping the "scripts do the work, YAML stays thin" rule.

### What changes for a mail stack

NGINX can stay the HTTPS front for the console, webmail, the site (if not static-hosted) and Stalwart's JMAP and admin HTTP endpoints. **Stalwart must publish 25, 465, 587 and 993 itself**, and needs its own certificates for the MX and submission hostnames. Either:

- use Stalwart's built-in ACME (simplest), or
- share the certbot volume read-only with a reload hook.

Cloudflare cannot proxy SMTP or IMAP: the mail hostnames are DNS-only, so the origin's IP is exposed there anyway.

Port 25 egress, reverse DNS (PTR), SPF, DKIM, DMARC, MTA-STS and TLS-RPT are deploy prerequisites. Add them to the readiness checks and to the operations doc.

### .gitignore conventions

Worth copying:

- all `.env*` except `.env.example`
- `*.pem`
- `*.sh` except listed deploy and CI scripts
- `.playwright-mcp/`, `/playwright-report/`, `/test-results/`
- `credentials.md` (local demo accounts)
- `docs/handoff.md` and other local-only operations docs
- generated content
- `*.tsbuildinfo`, `next-env.d.ts`

---

## BookYourPTO-Frontend

### Stack

| Package | Version |
| --- | --- |
| nuxt | 4.2.2 |
| vue / vue-router | 3.5.25 / ^4.6.4 |
| @nuxt/content | 3.9.0 (SQLite-backed, `better-sqlite3` ^12.6.2) |
| @nuxt/ui | 4.2.1 |
| tailwindcss | 4.1.18, via `@tailwindcss/vite` |
| @nuxtjs/seo | 3.3.0 (sitemap, robots, schema.org, og-image disabled, link checker in dev) |
| @nuxtjs/color-mode | ^4.0.0 (class-based, default **light**, storage key `nuxt-color-mode`) |
| @vueuse/motion | ^3.0.3 |
| lenis | ^1.3.17 (smooth scroll, client plugin) |
| @nuxt/image | ^2.0.0 |
| @nuxt/scripts | ^0.13.1 |
| posthog-js | ^1.341.0 |
| icons | `@iconify-json/{lucide,logos,simple-icons,vscode-icons}` |

Build and hosting:

- `nuxt generate` with Nitro preset `netlify-static`, `prerender.crawlLinks: true`, plus an explicit list of SEO landing routes.
- `netlify.toml`: `command = "npm run generate"`, `publish = "dist"`, `NODE_VERSION = "20"`, `NPM_FLAGS = "--legacy-peer-deps"`, `pretty_urls = false`.
- There is no linter or formatter config beyond `@nuxt/eslint`, and no tests are wired up.

### Structure

```
app.vue                     AnnouncementBar · ScrollProgressIndicator · Header (floating pill nav) · <main><NuxtLayout><NuxtPage/></main> · Footer · ScrollToTop · CookieBanner
pages/                      index.vue (1,124 lines, data arrays in <script setup>), pricing, features, contact, support, blog/{index,[...slug]},
                            ~10 SEO landing pages (pto-tracking-software, absence-management, …), legal (privacy, terms, cookie-policy, subprocessors, refund-policy, account-deletion), vs/, switch-from/
components/sb/              design-system pieces: HeroSky, Reveal, SectionHead, FeatureRow, MediaStage, Shot, PhoneShot, AppFrame, LogoStrip, SplitCompare, Stepper, TestimonialWall, Faq, Mark
components/common/          AnnouncementBar, CookieBanner, ScrollProgressIndicator, ScrollToTop, StoreButtons, PhoneFrame, …
components/animations/      older animation pieces (FadeInUp, CountUpNumber, MarqueeStrip, GradientText, …)
composables/                useRevealObserver (one shared IntersectionObserver), useCookieConsent, useAnnouncements, useCountUp, useScrollProgress, …
content/blog/*.md           frontmatter: title, description, date (string), author, image?, tags[], readTime?
content/announcements/*.md  frontmatter: title, link?, linkText?, active (default true), order (default 0); NNN.slug.md naming
content.config.ts           defineCollection({ type: "page", source: "blog/*.md", schema: z.object(…) }) per collection
server/api/__sitemap__/urls.ts  dynamic sitemap URLs (blog)
assets/css/shotbase.css     the "sb" design system (tokens + classes, un-layered so they beat utilities); main.css for the rest
utils/cdn.ts                cdn(path) prefixes runtimeConfig.public.assetsBase
```

Changelog: there is no in-repo changelog page. The hero chip links to an external `changelog.` subdomain, and in-repo "announcements" feed the announcement bar. Blog posts are rendered with `queryCollection('blog')` and `<ContentRenderer>`, plus `useSeoMeta` and a schema.org article per post.

### Landing page sections, in order (`pages/index.vue`)

1. **Hero**, full-bleed photo (`SbHeroSky`, duotone to brand blue, slow camera push):
   - a pill chip linking to the changelog, with a pinging green dot
   - h1 at max 16ch, a lead at max 46ch
   - primary "Start free" and glass "See pricing" buttons
   - a meta row of three icon facts (trial, setup time, managed cloud)
   - a product screenshot card overlapping the seam into the next section
2. **Logo strip** on a white panel with a 40 px rounded top (`rounded-t-[40px]`), which takes the overlap.
3. **"Everything after" night band:** a rounded 36 px dark panel with an h3 statement and a five-step icon lifecycle (Request → Approve → Track → Claim → Sign).
4. **Platform** (`#platform`): `SbSectionHead` (eyebrow and title), then six alternating `SbFeatureRow`s (eyebrow with icon, title, bullets, and art on a tinted `SbMediaStage` in emerald / blue / amber / violet / neutral).
5. **Home cards** (`#home-cards`): grouped icon chips.
6. **Policies** (`#policies`): a split-compare screenshot, then a four-card capability grid.
7. **Automation** (`#automation`): two screenshots and a list of automations.
8. **Mobile** (`#mobile`): a split layout with copy, bullets and phone shots.
9. **Integrations** (`#integrations`).
10. A CTA band.
11. **Security** (`#security`): a 40 px rounded night-gradient panel (deep purple to teal), an on-dark eyebrow, and a statement on encryption, rate limiting and audit logging.
12. **Workflow** (`#workflow`): a three-step stepper.
13. **Testimonials** (`#testimonials`, a wall).
14. **Pricing** (`#pricing`).
15. **Contact** (`#contact`): two cards (support and sales) plus five social channel tiles.
16. **FAQ** (`#faq`, `SbFaq`).
17. **Final CTA:** a `sb-night-fade` band (night to black) with the mark, an h2 and two buttons, running straight into the footer.

The footer has four link columns (Product, Company, Resources, Legal) and social icons.

### Visual style

Tokens are in `assets/css/shotbase.css`. The file describes the look as "medium-weight geometric display, tight tracking, one electric blue, 8 px buttons with an inset highlight, 22 px floating nav pill, big soft cards (20–30 px), pill eyebrows, 80 px section rhythm".

| Token | Value | Note |
| --- | --- | --- |
| `--sb-blue` | 0 167 245 (#00A7F5) | decorative only (2.68:1) |
| `--sb-blue-hi` / `--sb-blue-deep` | 0 188 255 / 0 139 232 | |
| `--sb-blue-ink` | 3 105 161 (#0369A1) | **same as the portal's `--ik-ink-accent`** |
| `--sb-btn` / `--sb-btn-hi` | 0 119 200 / 0 105 176 | **same button blue as the portal** |
| `--sb-ink` / `-soft` / `-mute` | 24 24 27 / 82 82 91 / 113 113 122 | zinc scale |
| `--sb-line` | 228 228 231 | |
| `--sb-surface` / `-2` | 250 250 250 / 244 244 245 | |
| `--sb-night` / `-night-deep` / `-teal-deep` | 30 30 31 / 15 7 28 / 8 90 122 | dark bands |
| Display font | "General Sans", "DM Sans", system | |
| Body font | "DM Sans", system | |
| Radii | `--sb-r-btn` 8 px, `--sb-r-card` 20 px, `--sb-r-card-lg` 30 px, `--sb-r-nav` 22 px; panels 36–40 px | |
| Easing | `--sb-ease: cubic-bezier(.16,1,.3,1)`, `--sb-ease-io: cubic-bezier(.65,0,.35,1)` | |
| Shadows | `--sb-sh-btn: inset 0 3px 0 rgb(255 255 255/.2), 0 2px 4px rgb(6 147 255/.25)`; `--sb-sh-card: 0 1px 2px rgb(0 0 0/.04), 0 12px 32px -12px rgb(24 24 27/.12)`; `--sb-sh-float: 0 24px 70px -20px rgb(24 24 27/.28)`; `--sb-sh-nav: 0 2px 40px rgb(0 0 0/.25)` | |
| Spacing | `--sb-pad-x: clamp(1.25rem,3.2vw,2.5rem)`; `--sb-pad-y: clamp(3.5rem,7vw,6.5rem)`; `--sb-gutter: clamp(2.5rem,6vw,7rem)` | |
| Containers | `.sb-wrap` max 1000 px; `.sb-wrap-wide` max 1240 px; panels max 1360 px | |

Type scale. The display font is General Sans, and the scale is much larger than the app's:

| Class | Size | Weight | Line-height | Tracking |
| --- | --- | --- | --- | --- |
| `sb-h1` | `clamp(2.25rem, 1.35rem + 3.6vw, 3.5rem)` (36→56 px) | 500 | 1.14 | −0.028em |
| `sb-h2` | `clamp(2rem, 1.35rem + 2.6vw, 3rem)` (32→48 px) | 500 | 1.18 | −0.028em |
| `sb-h3` | `clamp(1.375rem, 1.05rem + 1.3vw, 1.75rem)` (22→28 px) | **400** | 1.2 | −0.03em |
| `sb-h4` | `clamp(1.0625rem, .98rem + .35vw, 1.25rem)` | 500 | 1.3 | −0.024em |
| `sb-lead` | `clamp(1rem, .96rem + .18vw, 1.0625rem)` | | 1.55 | |
| `sb-body` | 1rem, ink-mute | | 1.55 | −0.018em |
| `sb-small` | .875rem | | | |

Components:

- **Eyebrow:** a pill with 300 px radius, padding `.5rem .875rem`, 13 px weight 500 on `surface-2`. Variants `--onDark`, `--blue`, `--amber`, `--violet`, each with a dark-mode text colour.
- **Buttons** (`.sb-btn`): 45 px tall (`-lg` 52, `-sm` 38), 8 px radius, 15 px weight 500, `:active translateY(1px)`. Variants:
  - `-primary`: btn blue, white text, inset highlight shadow
  - `-secondary`: surface background, soft shadow
  - `-dark`
  - `-glass`: white/10 with `backdrop-filter: blur(12px)`, for use on photos
- **Cards** (`.sb-card`): `surface-2/.75`, 20 px radius, a hairline border, and a hover lift of −3 px with the card shadow. `.sb-card-plain` is white. The tinted "stage" behind product art (`.sb-stage`, 30 px radius) uses a blue gradient from 7% to 3%.
- **Section rhythm:** `.sb-section` padding `var(--sb-pad-y) var(--sb-pad-x)`. `.sb-split` is a two-column grid at 0.88fr / 1.12fr from 1024 px. Seams between sections are 40 px rounded corners.
- **Night bands:** `.sb-night` (flat), `.sb-night-gradient` (`night-deep` to `teal-deep`), `.sb-night-fade` (`night-deep` to black by 22%).
- **Dark mode:** class-based, `dark:bg-zinc-950`, cards at white/4 with white/8 borders. Default is light.
- **Motion:** `SbReveal` with props `index`, `step` (default 100 ms), `delay`, `variant: 'slide' | 'scale'`, `as` and `onLoad`. It moves y from +20 px to 0 and opacity from 0 to 1 over 0.8 s on `--sb-ease`. Hero reveals use a 130 ms stagger. Product art uses the `scale` variant (1.06 → 1). A single shared IntersectionObserver drives all reveals, and `will-change` is set only while animating. Lenis smooth scroll runs on top.

### Tone of copy

The copy is short, confident, concrete and a little warm. It describes outcomes rather than features, uses curly apostrophes, and avoids exclamation marks. Examples:

- Hero h1: "Request, approve, track, and sign in one place"
- Night band: "BookYourPTO isn’t just for booking time off, it’s for everything after."
- Section titles:
  - "Whatever your team runs on, it lives here"
  - "One platform. Every policy. No spreadsheets."
  - "Let the admin run itself."
  - "Book it from the departure lounge."
  - "Your team’s data stays your team’s."
  - "Start free. Scale when you’re ready."
- Final CTA: "Give your team their afternoons back."

Section titles are a short h2, followed by one sentence of lead at max 44–52ch.

### Forms

- **Contact** (`pages/contact/index.vue`) is client-side only. Validation:
  - a honeypot field
  - a minimum fill time of 3 s
  - a 30 s cooldown and a cap of 5 submissions per session (both in memory, client-side)
  - regex checks per field and a `sanitize()` that strips characters
  - a consent checkbox

  It then builds a hidden `<form>` and posts it to a third-party form vendor's public endpoint through a hidden iframe, to avoid CORS. There is no server of its own and no server-side validation or rate limit.
- **Support** uses `mailto:` links.
- There is no waitlist form.
- **For AnhourMail: SKIP** the vendor and iframe approach. **ADOPT** the honeypot and minimum-fill-time ideas, but enforce them **on the server**.

### SEO, meta and OG

- `@nuxtjs/seo` with `site { url, name, description, defaultLocale }` and `automaticDefaults: false`.
- Every page calls `useSeoMeta({ title, description, ogTitle, ogDescription, ogType, twitterCard: "summary_large_image", … })` and `useSchemaOrg([defineWebPage(…), { "@type": "SoftwareApplication", offers: AggregateOffer … }])`.
- `app.vue` sets one **canonical** and `og:url` per route: absolute, no query string, no trailing slash.
- Global head:
  - static `og:image` / `twitter:image` hosted on an image CDN
  - `theme-color`
  - hreflang `en-ca`, `en-us`, `x-default`
  - geo meta tags
  - SVG and ICO favicons plus an apple-touch-icon
- Schema.org `Organization` identity: name, logo, `sameAs` social links, address, `areaServed`.
- Sitemap with xsl columns and a dynamic source; robots.txt allows everything.
- The OG image generator is disabled; a static image is used instead.

### Analytics and third parties

All of these are **SKIP** for AnhourMail:

- PostHog (opt-out by default, opted in from the cookie-consent `analytics` flag, manual `$pageview` on route change, suppressed inside the native app's web view)
- a third-party analytics id in the consent composable
- a cookie banner with essential, analytics, functional and marketing categories
- third-party font CDNs
- Cloudinary and Unsplash images
- a third-party maps API key
- a third-party form vendor

AnhourMail's site should make **zero third-party requests**:

- self-hosted fonts
- no cookies, so no cookie banner is needed
- at most privacy-preserving server-side counts from NGINX logs, or a self-hosted, cookieless counter

---

## Marketing-site recommendation

**Recommendation: (c). Build a Next.js app at `apps/site` in the AnhourMail monorepo, statically exported, re-creating the BookYourPTO visual style.**

| Criterion | (a) Nuxt app in monorepo | (b) Separate repo (Nuxt clone) | (c) Next.js `apps/site` |
| --- | --- | --- | --- |
| One stack / toolchain | No: Vue, Nuxt, ESLint and Vite alongside React, Next and Biome; two sets of upgrades | No, and no sharing at all | **Yes**: one framework, one Biome config, one tsconfig base, one lockfile, one CI |
| Shared packages (waitlist zod schema, design tokens, UI primitives, brand fonts) | Schemas yes (zod is framework-free); tokens only as raw CSS; components no | Only by publishing packages | **Yes**: `packages/schemas`, `packages/tokens` (CSS variables + type classes), `packages/ui` (shadcn primitives), `packages/fonts` |
| Static export | `nuxt generate` (proven in BookYourPTO) | same | `output: "export"` gives a fully static site. Blog and changelog come from Markdown at build time (gray-matter + marked, already in the portal stack) with zod-validated frontmatter mirroring `content.config.ts` |
| Contributor overhead | Two mental models and two sets of rules (skeletons, logging, Biome) | Separate issues, CI and secrets; style drift | **Lowest**: same rules file, same hooks, same review |
| Re-use of BookYourPTO code | High (copy `.vue` components) | Highest | Medium. The CSS (`shotbase.css`) ports almost verbatim. The roughly 15 `sb/*` components are simple markup plus one IntersectionObserver composable, about 1–2 days to port to React. |
| Privacy posture | Nuxt SEO and Content modules pull in more dependencies; must strip PostHog and font CDNs | same | Clean start: nothing third-party to strip |

Why (c) wins:

- The waitlist is the one dynamic piece. With (c), its zod schema, its rate-limit tier and its `route()`/`logged()` wrapper are all the same code as the product.
- Design tokens converge naturally. Both reference repos already share the button blue (0 119 200), the accent ink (#0369A1) and General Sans display at weight 500. One `packages/tokens` can hold:
  - the shared raw palette
  - an `app` scale (the portal's `ik-*` sizes)
  - a `marketing` scale (the `sb-*` sizes and radii, night bands, reveal easing)
- Nuxt's main advantage, Content plus the SEO module, is cheap to replace in Next:
  - the Metadata API (`generateMetadata`, canonical, OG)
  - `app/sitemap.ts` and `app/robots.ts`, which work with static export
  - a static OG image
  - JSON-LD written inline

How to build it:

- **Layout:** `apps/site` with Next `output: "export"`, `trailingSlash: false`, `images: { unoptimized: true }`, served as static files. Options:
  - by the same NGINX, as a `site` server block on the apex and `www`
  - by any static host
- **Fonts:** self-hosted General Sans plus Geist (or DM Sans, self-hosted, if the marketing body font should stay closer to BookYourPTO). No third-party requests.
- **Waitlist endpoint:** `POST /api/public/waitlist`, hosted in the console app. A static export can't serve route handlers, and the console already has `route()`, Redis and Postgres. How it works:
  - `logged(rateLimited(LIMITS.publicForm, handler))` with the per-IP key gated on trusted proxies, **fail-closed**, plus a per-email limit
  - no cookies, so no CSRF surface; validate `Origin` against the site origin anyway
  - honeypot and minimum fill time checked server-side
  - zod schema from `packages/schemas` (`WaitlistSignup = { email, referral?, consent: true, hp: "" , startedAt }`)
  - double opt-in by email, sent from AnhourMail's own system mail through the worker
  - the same generic response whether or not the address is already listed, so the list can't be enumerated
  - addresses stored, with the token hash, in a `waitlist` table, logged in `docs/migration.md`
  - logs redact the email (store a hash in the logs)
- **Preferred routing:** NGINX serves the static site and routes `anhourmail.com/api/public/*` to the console container. The form then posts same-origin and CORS is not needed. Only fall back to a CORS allowlist if the site ends up on a separate static host.
- **Content:**
  - `apps/site/content/blog/*.md`: frontmatter `title, description, date (ISO), author, tags[], image?, readTime?`
  - `apps/site/content/changelog/*.md`: `title, date, version?, link?, linkText?, active, order`, mirroring BookYourPTO's announcements so the same file can drive an announcement bar
  - both validated with zod at build time; the build fails on bad frontmatter
- **Landing structure to mirror:**
  1. photo or gradient hero with a changelog chip, h1, lead, and two CTAs (join waitlist, how it works)
  2. a product shot overlapping the seam
  3. a night-band statement
  4. alternating feature rows on tinted stages (private by default, your domain, JMAP webmail, aliases, no tracking)
  5. a security night-gradient panel
  6. a three-step stepper
  7. pricing ("planned")
  8. FAQ
  9. a final CTA night-fade with the waitlist form

  Drop testimonials and logo strips until they are real. This follows the portal's "truthful" rule.
- **Motion:** port `SbReveal` as a React component with one shared observer, and make it honour `prefers-reduced-motion`, which the source does not clearly guarantee. Drop Lenis smooth scrolling.

---

## Adopt / Adapt / Skip master table

| # | Pattern | Source | Verdict | Why / change |
| --- | --- | --- | --- | --- |
| 1 | `route(handler, { limit })` + `readJson` + `ok` + `HttpError` helpers | `src/server/http/route.ts`, `errors.ts` | ADAPT | Keep the envelope, CSRF origin check and error mapping; optionally add `auth` / `permission` options; 404 for out of scope |
| 2 | `logged()` access log + AsyncLocalStorage request context + `X-Request-Id` | `src/server/http/access-log.ts`, `src/server/request-context.ts`, `request-meta.ts` | ADOPT VERBATIM | Change `TOKEN_PATHS` |
| 3 | JSON logger with key-based redaction | `src/server/log.ts` | ADOPT VERBATIM | Add mail keys (subject, body, mime, attachments, dkim keys, app passwords); service name `anhourmail` |
| 4 | `check:logging` script + pre-commit | `scripts/check-logging.mjs` | ADOPT VERBATIM | Roots per app in the monorepo |
| 5 | Redis fixed-window rate limiter with `LIMITS` tiers | `src/server/http/rate-limit.ts`, `docs/rate-limits.md` | ADAPT | Trust-gated client IP; fail-closed for send quotas, sign-up and waitlist; per-account send quotas; `am:rl:` prefix |
| 6 | AES-256-GCM `encryptSecret` / `decryptSecret`, write-only secrets policy | `src/server/crypto/secrets.ts`, rule 28 | ADAPT | Add key id + key ring, HKDF, AAD, key required in production, re-encrypt job |
| 7 | Liveness / readiness endpoints | `src/server/health.ts`, `src/app/api/health/**` | ADOPT VERBATIM | Add Stalwart (JMAP / management) and the worker heartbeat |
| 8 | Skeleton pieces + `loading.tsx` rule + `check:skeletons` | `src/components/portal/skeletons.tsx`, `scripts/check-skeletons.mjs`, `ik.css` | ADOPT VERBATIM | Add mail-list / reading-pane / composer skeletons; set ROOTS per app |
| 9 | husky + lint-staged hook | `.husky/pre-commit`, `package.json` | ADAPT | Drop `generate:presets`; add a scoped typecheck |
| 10 | Biome config | `biome.json` | ADOPT VERBATIM | Hoist to the repo root |
| 11 | tsconfig / next.config security headers | `tsconfig.json`, `next.config.mjs` | ADAPT | Base tsconfig in `packages/config`; strict nonce CSP + sandboxed message iframe for webmail; `output: "standalone"` |
| 12 | drizzle config + migrate on container start | `drizzle.config.ts`, `scripts/docker-entrypoint.mjs` | ADOPT VERBATIM | `checkConfig()` lists AnhourMail's required settings |
| 13 | Migration log with rollback levels | `docs/migration.md` | ADOPT VERBATIM | |
| 14 | Handoff session log (gitignored) | `docs/handoff.md` | ADOPT VERBATIM | |
| 15 | Codemap + architecture docs | `docs/codemap.md`, `docs/architecture.md` | ADOPT | |
| 16 | Numbered contributor rules + document-history table | root rules file | ADAPT | Keep rules 2–8, 14–16, 24–31; replace the tenancy and EULA rules with mailbox / domain scope rules |
| 17 | Scheduler container (`JOBS` table, heartbeat) | `scripts/scheduler.ts` | ADAPT | Periodic jobs only; the event-driven worker runs on a real queue |
| 18 | Redis cache helpers (failures swallowed) | `src/server/redis.ts` | ADOPT VERBATIM | |
| 19 | Uncommon ports, 127.0.0.1 binds, ports table | `docker-compose.yml`, rules file | ADOPT VERBATIM | Use a 48xxx range to coexist with the portal |
| 20 | NGINX front with JSON logs, overwritten forwarding headers, request id, health not logged | `deploy/nginx/**` | ADOPT for HTTP | Stalwart owns 25/465/587/993 and their TLS; mail hostnames are DNS-only |
| 21 | Cloudflare origin-cert mode / certbot profile | `deploy/nginx/cloudflare.conf`, `deploy/certbot/*` | ADAPT | HTTP hosts only; mail certificates via Stalwart ACME or a shared volume |
| 22 | Two-stage Node 22 Alpine image, `GIT_SHA` build arg | `deploy/Dockerfile` | ADAPT | Standalone output, non-root user, slimmer copy |
| 23 | Thin CI YAML calling scripts; `build.sh` health wait | `bitbucket-pipelines.yml`, `.cicd/*`, `deploy/build.sh` | ADAPT | Port to the chosen forge |
| 24 | Design tokens (ik palette, navy dark mode, 8 px radius scale) | `src/app/globals.css`, `docs/branding.md` | ADAPT | Drop tenant `--brand` indirection; move into `packages/tokens` |
| 25 | Three self-hosted fonts + app type scale | `src/lib/fonts/brand.ts`, `src/styles/ik.css`, `docs/typography.md` | ADOPT VERBATIM | Rename the class prefix |
| 26 | DataTable, StatusBadge (no dot), ConfirmButton, compact icon buttons | `docs/branding.md` §6 | ADOPT | |
| 27 | Transactional email layout (570 px, tables, VML button, dark block, text part) | `src/server/mail/templates.ts` per `docs/branding.md` | ADOPT | System mail sent through AnhourMail's own Stalwart |
| 28 | White-label, tenant hostnames, EULA, roadmap, calendar, docs sync | various | SKIP | Not relevant |
| 29 | Marketing "sb" visual system (tokens, type scale, cards, night bands, eyebrows, buttons) | `BookYourPTO-Frontend/assets/css/shotbase.css`, `components/sb/*` | ADAPT | Re-create in React and Tailwind v4 in `apps/site` with an `am-` prefix |
| 30 | Landing section order and copy tone | `BookYourPTO-Frontend/pages/index.vue` | ADAPT | Waitlist CTA; no testimonials or logos until real |
| 31 | Content collections (blog, announcements) with zod frontmatter | `BookYourPTO-Frontend/content.config.ts`, `content/**` | ADAPT | Markdown + gray-matter + zod at build; add `changelog/` |
| 32 | Canonical / OG / schema.org per page, sitemap, robots | `BookYourPTO-Frontend/app.vue`, `nuxt.config.ts` | ADAPT | Next Metadata API, `sitemap.ts`, `robots.ts`, static OG image, JSON-LD |
| 33 | Scroll reveal (shared observer, `will-change` only while animating) | `components/sb/Reveal.vue`, `composables/useRevealObserver.ts` | ADAPT | React port; respect reduced motion |
| 34 | Contact form via hidden iframe to a form vendor; client-only throttling | `pages/contact/index.vue` | SKIP | Server-side waitlist endpoint instead; keep honeypot + minimum fill time, enforced server-side |
| 35 | PostHog, GA, cookie banner, font CDNs, image CDNs, Maps, Lenis | `plugins/posthog.client.ts`, `composables/useCookieConsent.ts`, `nuxt.config.ts` | SKIP | Zero third-party requests on a privacy product |
| 36 | Nuxt / Netlify static build | `nuxt.config.ts`, `netlify.toml` | SKIP | Replaced by Next `output: "export"` |
