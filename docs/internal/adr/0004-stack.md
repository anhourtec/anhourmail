# ADR-0004: Stack mirrors iotkinect-portal, with ESLint + Prettier, Vitest and Playwright

Status: Accepted, 2026-10-21

## Context

iotkinect-portal is the reference for engineering patterns and design (`research/reference-patterns.md`). The owner's quality-gate requirements (section 9.6) ask for typescript-eslint strict-type-checked, import boundary rules, React hooks, and Playwright/Vitest lint plugins, zero warnings, and Prettier. Biome, which the portal uses, cannot express type-aware rules or the boundary rules we need.

## Decision

- Next.js 16 App Router, React 19, TypeScript 5.9 strict (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`), Tailwind v4 + shadcn/ui, better-auth, Postgres 17 via drizzle-orm, Redis 8 via ioredis, zod 4.
- **ESLint (flat config, typescript-eslint strict-type-checked + stylistic) + Prettier** replace Biome. `--max-warnings=0`. `no-restricted-imports` enforces ADR-0008.
- Vitest for unit, contract and integration tests (coverage: ≥ 90% core/services/RBAC, ≥ 80% overall). Playwright for e2e (CI) and Playwright MCP for interactive checks.
- husky + lint-staged pre-commit. GitHub Actions CI with thin YAML calling `.cicd/*.sh`.
- Patterns adopted from the portal: logger and redaction, `route()` wrapper, rate-limit tiers (with fixes: trusted-proxy IP, fail-closed tiers), secrets (with key ids), health endpoints, skeleton rule + check, migration log, handoff log, scheduler container.

## Consequences

- The ESLint config is slower than Biome, which is acceptable for type-aware safety.
- Contributors moving between repos see a different linter. The rules file documents it.

## Alternatives

- Biome only: rejected (no type-aware rules, no boundary enforcement).
- Biome + ESLint for the few rules Biome lacks: rejected (two configs, conflicting formatters).
