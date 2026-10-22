# Public docs site

Last updated: 2026-10-21. Decision: ADR-0007.

## What and where

- `anhourmail.com/docs` is served by `apps/site` with **Fumadocs** (`fumadocs-core`/`fumadocs-ui` 16.17.7, `fumadocs-mdx` 15.4.9, pinned exactly; ui and core upgrade together).
- **Sources:**
  - `docs/public/`: user-facing MDX guides plus `meta.json` files for sidebar order.
  - `docs/shared/`: snippets used by both the docs and the app (client settings tables, DNS record tables, plan tables, as MDX components that read `@anhourmail/shared`).
  - `docs/internal/`: **never** published or referenced from the site.
- Shared header and footer with the marketing pages (one layout in `apps/site`), light/dark, the `packages/ui` tokens and self-hosted fonts.
- `/changelog` and `/credits` live in the same app. The changelog reads Markdown entries with zod-validated frontmatter. `/credits` reads the data that `scripts/third-party-notices.mjs` generates.

## Facts come from code (rule 32)

Hostnames, ports, plan limits, prices, sending limits and DNS templates are rendered by components that import `@anhourmail/shared` (`HOSTS`, `CLIENT_ENDPOINTS`, `PLANS`, `TRUST_TIERS`, `customerDomainRecords()`). Every record and server setting has a copy button. If a value changes in `packages/shared`, the docs, the pricing table and the console all change in the same build.

## Features

- Local static search (Orama, built at build time, queried in the browser): no SaaS, no third-party request.
- Sidebar from `meta.json`, breadcrumbs, table of contents.
- "Last updated" from git history. "Edit this page" links to `github.com/anhourtec/anhourmail/edit/main/docs/public/...`.
- Copy buttons on code blocks and on custom components (DNS rows, server settings).
- `NEXT_TELEMETRY_DISABLED=1` everywhere. No analytics.

## Checks — `scripts/check-docs.mjs`

Runs in pre-commit and CI. It fails when:

1. A link in `docs/public` points to a missing page or anchor.
2. A public doc **hard-codes a fact**: a known hostname (`*.anhourmail.com` mail hosts), a client port (25/465/587/993/4190 in a settings context), a plan price, a storage figure or a sending limit appears as literal text instead of a component or import.
3. Anything in `docs/public` or `apps/site` references `docs/internal`.
4. A page lacks a `title` or `description` in its frontmatter.

Plus the usual verification for UI (rule 34): Playwright MCP check of changed pages in light and dark at 1440 and 390, with no console errors.

## Writing guidelines (owned by the `docs-writer` agent)

- Plain language for non-experts. Short sentences, a task-first title ("Connect a mail app"), steps numbered, one action per step.
- Per-DNS-provider guides (Cloudflare, Namecheap, GoDaddy, Porkbun, …) use the shared DNS component plus provider-specific screenshots, with no repeated values.
- Never expose internals (rule 33): no internal hostnames, IPs, admin paths or detection thresholds. Publish sending limits, not detection rules.
- Every user-facing change updates `docs/public` and adds a changelog entry in the same change (rule 31).

## Deploy

The docs ship with `apps/site` (same image, same release). No separate deploy and no separate domain.
