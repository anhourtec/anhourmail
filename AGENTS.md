<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Stack versions

Pinned exactly in `package.json` files and `docker-compose.yml`. Upgrades are deliberate changes with notes in
`docs/internal/handoff.md`. When an API looks unfamiliar, read the installed package's docs, not memory.

| Area           | Package / image                            | Version                                                                              | Notes                                                                                          |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Runtime        | Node                                       | 22 (`.nvmrc`, `engines >=22.12 <23`)                                                 | npm 10.9.4, npm workspaces (`apps/*`, `packages/*`)                                            |
| Framework      | next                                       | 16.4.2                                                                               | App Router; `proxy.ts` replaces `middleware.ts`; `reactCompiler: true`; `output: "standalone"` |
| UI             | react / react-dom                          | 19.3.1                                                                               |                                                                                                |
| Language       | typescript                                 | 5.9.3                                                                                | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`       |
| Styling        | tailwindcss / @tailwindcss/postcss         | 4.3.3                                                                                | tokens in `packages/ui/src/styles/tokens.css`; shadcn/ui generated per app in `components/ui`  |
| Auth           | better-auth                                | 1.7.12                                                                               | console identity only; mailbox credentials belong to Stalwart                                  |
| Database       | drizzle-orm / drizzle-kit                  | 0.45.4 / 0.31.11                                                                     | only inside `packages/adapters/src/db-postgres`                                                |
| Cache / queues | ioredis                                    | 6.0.0                                                                                |                                                                                                |
| Validation     | zod                                        | 4.6.7                                                                                | v4 API (`z.email()`, `z.uuid()`, `z.iso.datetime()`)                                           |
| Lint / format  | eslint + typescript-eslint / prettier      | 10.13.0 + 8.72.0 / 3.9.10                                                            | flat config, `strict-type-checked`, `--max-warnings=0`                                         |
| Unit tests     | vitest / @vitest/coverage-v8               | 5.0.5                                                                                | coverage thresholds enforced                                                                   |
| Browser tests  | @playwright/test                           | 1.64.1                                                                               | `tests/e2e/`; Playwright MCP for interactive checks                                            |
| Docs site      | fumadocs-core / fumadocs-ui / fumadocs-mdx | 16.17.7 / 16.17.7 / 15.4.9                                                           | inside `apps/site` at `/docs`; core and ui upgrade together                                    |
| Mail server    | `stalwartlabs/stalwart`                    | v0.16.27 @ `sha256:c429b311c93db5606598abc1c68225a85a6953183848ae01bee9c6a98885836c` | AGPL-3.0, run unmodified                                                                       |
| Database       | `postgres`                                 | 17.11-alpine                                                                         | control plane only                                                                             |
| Cache          | `redis`                                    | 8.8.3-alpine                                                                         |                                                                                                |
| Dev mail sink  | `axllent/mailpit`                          | v1.31.6                                                                              | dev and CI only                                                                                |

## Stalwart v0.16 is not the Stalwart in most examples online

- **There is no REST management API and no TOML config.** `/api/principal`, `/api/settings`, `/api/dns/records/…`,
  `/api/spam-filter/train` and `config.toml` were removed in v0.16.0.
- All management is JMAP at `POST /jmap` with the `urn:stalwart:jmap` capability: `x:Domain/set`,
  `x:Account/set`, `x:MtaRoute/set`, `x:MtaOutboundStrategy/set`, `x:Action/set { "@type": "ReloadSettings" }`, …
- The only file is `config.json` (the data store). Everything else lives in the data store.
- Collections use Stalwart's encoding: `List<T>` is `{ "0": …, "1": … }`, `Set<T>` is `{ "member": true }`,
  durations are milliseconds, sizes are bytes.
- Account names are email addresses. DNS records come from `x:Domain/get` → `dnsZoneFile`.
- Masked email, undelete and multi-tenancy are Enterprise-only; we build masked aliases in our control plane.
- The full research is `docs/internal/research/stalwart.md`. Verify shapes against the running pinned server
  (`GET /api/schema` or `x:<Object>/get`) before adding a new management call to `packages/stalwart-client`.
