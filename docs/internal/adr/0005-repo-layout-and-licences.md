# ADR-0005: Monorepo layout and licences

Status: Accepted, 2026-10-21

## Context

Console, webmail, marketing site, docs and worker share types, schemas, design tokens and public facts. Research recommended one stack and one repo for the marketing site (`research/reference-patterns.md`). The owner chose AGPL for apps and MIT for reusable libraries (section 10).

## Decision

npm workspaces:

| Path                                          | What                                                                                        | Licence       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------- |
| `apps/web`                                    | Console (`app.`) + webmail (`mail.`) + BFF + public API                                     | AGPL-3.0-only |
| `apps/site`                                   | Marketing, waitlist, `/docs` (Fumadocs), `/changelog`, `/credits`                           | AGPL-3.0-only |
| `apps/worker`                                 | Queue worker + scheduler                                                                    | AGPL-3.0-only |
| `packages/core`                               | Domain, services, ports, audit                                                              | AGPL-3.0-only |
| `packages/adapters`                           | Postgres + in-memory adapters, contract tests, migrations                                   | AGPL-3.0-only |
| `packages/shared`                             | Public facts, RBAC matrix, zod schemas                                                      | AGPL-3.0-only |
| `packages/ui`                                 | Tokens, fonts, skeletons                                                                    | AGPL-3.0-only |
| `packages/stalwart-client`                    | Stalwart management client                                                                  | MIT           |
| `packages/jmap-client`                        | JMAP client                                                                                 | MIT           |
| `packages/server`                             | Logger, health probes, Redis                                                                | MIT           |
| `packages/config`                             | tsconfig bases                                                                              | MIT           |
| `infra/`                                      | Stalwart dev plan, Postgres init                                                            | AGPL-3.0-only |
| `deploy/`                                     | Container images only (`Dockerfile.*`); no production compose, NGINX config, IPs or secrets | AGPL-3.0-only |
| `scripts/`                                    | Checks, seed, verification                                                                  | AGPL-3.0-only |
| `docs/internal`, `docs/public`, `docs/shared` | Never published / docs site source / snippets                                               | —             |

Packages are consumed as TypeScript source (Next `transpilePackages`, tsx for scripts). Every source file has an SPDX header, checked by a script.

Private ops repo (not public): production compose, NGINX config, server IPs, deploy secrets, tuned abuse thresholds. The public `docker-compose.yml` is dev/CI only. Self-hosters follow `/docs/self-hosting`, built on the public images.

## Consequences

- One lockfile, one CI, shared rules.
- The marketing site runs as a Next server with prerendered pages (not static export) so `/api/public/*` can be rewritten same-origin to `apps/web`.

## Alternatives

- Separate repo for marketing (Nuxt, like BookYourPTO): rejected (second toolchain, no shared schemas).
- Separate `apps/docs`: superseded by ADR-0007.
