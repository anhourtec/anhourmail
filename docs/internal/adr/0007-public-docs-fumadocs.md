# ADR-0007: Public docs inside apps/site at /docs with Fumadocs

Status: Accepted, 2026-10-21

## Context

Public docs must share the marketing header, footer and design, live at `anhourmail.com/docs`, be built from `docs/public` + `docs/shared` (outside the app), import facts from `packages/shared`, have local search with no SaaS, show last-updated and edit links, and copy buttons on code and DNS rows (`research/docs-framework.md`).

## Decision

- **Fumadocs** in `apps/site`: `fumadocs-core` / `fumadocs-ui` **16.17.7** (upgrade together; ui pins core) and `fumadocs-mdx` **15.4.9**, all pinned exactly.
- The content dir is `../../docs/public`. MDX pages import components that read `@anhourmail/shared` (hostnames, ports, plans, DNS templates), so values are never typed in Markdown (rule 32).
- Built-in static search (Orama, client-side). Next telemetry is disabled (`NEXT_TELEMETRY_DISABLED=1`).
- `scripts/check-docs.mjs` fails on broken internal links, hard-coded facts in `docs/public`, and references to `docs/internal` (`docs-site.md`).

## Consequences

- Docs deploy with the site. One header and footer, one design system.
- Fumadocs releases often. Pinned versions are upgraded deliberately.

## Alternatives

- Nextra 4: rejected (no release since Dec 2025; the content folder can't live outside the app).
- Starlight / Docusaurus: rejected (second toolchain, duplicated layout; Docusaurus lacks local search).
- Separate `apps/docs` on `docs.anhourmail.com`: rejected by the owner in favour of `/docs` on the main site.
