# Public docs site

Last updated: 2026-10-30. Decision: ADR-0007.

## What and where

- `anhourmail.com/docs` is served by `apps/site` with **Fumadocs** (`fumadocs-core`/`fumadocs-ui` 16.17.7, `fumadocs-mdx` 15.4.9, pinned exactly; ui and core upgrade together).
- **Sources:**
  - `docs/public/`: user-facing MDX guides plus `meta.json` files for sidebar order.
  - `docs/shared/`: shared prose snippets (`.mdx`). The fact components themselves (`Value`, `ClientSettingsTable`, `DnsRecordTable`, `PlanTable`, `SendLimitsTable`, `SuspensionReasonList`) live in `apps/site/src/components/facts.tsx`, read `@anhourmail/shared`, and are registered for every page in `apps/site/src/components/mdx.tsx` (no imports in MDX).
  - `docs/internal/`: **never** published or referenced from the site.
- Shared header and footer with the marketing pages (one layout in `apps/site`), light/dark, the `packages/ui` tokens and self-hosted fonts.
- `/changelog` and `/credits` live in the same app. The changelog reads `apps/site/content/changelog/<yyyy-mm-dd>-<slug>.md` entries with zod-validated frontmatter (`title`, `date`, optional `version`, `summary` ≤ 400 chars; `apps/site/src/lib/changelog.ts`), newest first; a bad entry fails the build. `/credits` reads the data that `scripts/third-party-notices.mjs` generates.

## Facts come from code (rule 32)

Hostnames, ports, plan limits, prices, sending limits and DNS templates are rendered by components that import `@anhourmail/shared` (`HOSTS`, `CLIENT_ENDPOINTS`, `PLANS`, `TRUST_TIERS`, `customerDomainRecords()`, plus the other facts `<Value of="…" />` knows: `FactKey` in `facts.tsx`, e.g. webmail attachment and HTML limits, invite, step-up, recovery-code, grace-period and suspension-reason facts). Every record and server setting has a copy button. If a value changes in `packages/shared`, the docs, the pricing table and the console all change in the same build.

## Features

- Search runs on our own server: `apps/site/src/app/api/search/route.ts` (`createFromSource`, Orama in memory); the browser queries `/api/search` same-origin. No SaaS, no third-party request.
- One strict nonce-based CSP for the site and docs (`apps/site/src/lib/csp.ts`: `'strict-dynamic'`, `connect-src 'self'`, `frame-ancestors 'none'`; the search API gets a data-only policy), set in the site proxy (2026-10-23).
- Sidebar from `meta.json`, breadcrumbs, table of contents.
- "Last updated" from git history. "Edit this page" links to `github.com/anhourtec/anhourmail/edit/main/docs/public/...`.
- Copy buttons on code blocks and on custom components (DNS rows, server settings).
- `NEXT_TELEMETRY_DISABLED=1` everywhere. No analytics.

## Checks — `scripts/check-docs.mjs`

Runs in pre-commit and CI over `docs/public` (`.md`, `.mdx`) and `docs/shared` (`.mdx`). It fails when:

1. A link in `docs/public` points to a missing docs page, or to a site route outside `/docs` that isn't in the script's `SITE_ROUTES` list. Anchors (`#…`) are not checked: check them by hand.
2. A doc **hard-codes a fact** read from `packages/shared` with a regex scan: a known hostname, a client port (high ports anywhere; low ones next to "port" or after a colon), a plan price, a storage figure, a sending limit next to its unit, the refund window or the mailbox deletion grace period.
3. A doc references `docs/internal`.

Not checked by the script (review by hand): frontmatter `title` / `description` (Fumadocs needs them), the changelog entries in `apps/site/content/changelog` (dated history; they may state the facts of their day), and MDX that puts a `<Value />` at the start of a wrapped line: Prettier then makes it its own paragraph, so keep inline components mid-line.

Plus the usual verification for UI (rule 34): Playwright MCP check of changed pages in light and dark at 1440 and 390, with no console errors.

## Writing guidelines (owned by the `docs-writer` agent)

- Plain language for non-experts. Short sentences, a task-first title ("Connect a mail app"), steps numbered, one action per step.
- Per-DNS-provider guides (Cloudflare, Namecheap, GoDaddy, Porkbun, …) use the shared DNS component plus provider-specific screenshots, with no repeated values.
- Never expose internals (rule 33): no internal hostnames, IPs, admin paths or detection thresholds. Publish sending limits, not detection rules.
- Every user-facing change updates `docs/public` and adds a changelog entry in the same change (rule 31).

## SEO

What's in place (2026-10-30):

- **Metadata from one helper.** Every page builds its metadata with `pageMetadata` (`apps/site/src/lib/seo.ts`):
  title (the root layout's template adds ` · AnhourMail`; docs pages use ` · AnhourMail docs`), a description under
  160 characters, a canonical URL against `metadataBase` (`SITE_URL`, from `PRODUCT_DOMAIN` in `packages/shared`),
  and full Open Graph and Twitter card tags with `og-image.png`. Next merges metadata shallowly, so a page that set
  only `openGraph.title` used to lose the image; the helper always sends the complete set. The root layout has no
  canonical of its own, so a page without one never claims to be the home page. Feature pages have a search-worded
  `seoTitle` next to their visible H1 (`lib/feature-content.tsx`). Docs titles and descriptions come from the MDX
  frontmatter; write the description as a sentence a searcher would recognise.
- **Structured data**, inline JSON-LD only (`src/components/json-ld.tsx`, escaped by `serializeJsonLd`; data blocks
  aren't executed, so the nonce CSP is unaffected): Organization (Anhourtec, no address or location), WebSite,
  WebApplication with one Offer per plan and currency (prices from `PLANS`, yearly `UnitPriceSpecification`, the
  Supporter minimum as `minPrice`) and FAQPage on the home page; the WebApplication and a BreadcrumbList on
  `/pricing`; BreadcrumbList on feature pages and every docs page. No ratings, reviews or availability we can't show.
  Unit tests: `src/lib/seo.test.ts`.
- **FAQPage answers are the visible text.** The home FAQ is plain strings for that reason; a question with a link
  (pricing's "Where are the full terms?") keeps that page out of FAQPage.
- **Sitemap** (`src/app/sitemap.ts`): every marketing route (`SITE_ROUTES` in `lib/ia.ts`), blog post and docs page,
  on the site's own origin only (console and webmail are other hosts, and set `noindex` themselves). `lastModified`
  is deterministic: the newest changelog entry or blog post for those indexes, the post date for posts, git history
  for docs and marketing pages, and nothing when there is no git (image builds) rather than a made-up date.
  Changelog entries have no pages of their own. `changeFrequency` and `priority` come from `routePriority`.
- **robots.txt** allows everything except `/api/` (the docs search endpoint) and points at the sitemap.
- **Feature list:** `docs/public/features.mdx` (`/docs/features`) lists what works today, grouped by what people
  search for, with facts as `<Value />` components and a "Not built yet" section. It's linked from the home page, the
  Features menu and `/features`. Add a line there when a feature ships.
- **Share images:** `og-image.png` (1200 × 630) for the site; the GitHub social preview (1280 × 640) is
  `packages/ui/assets/brand/github/social-preview.png`, rendered by `scripts/render-social-preview.mjs`.

Rules:

- **Truthful claims only.** Describe what works today (README "What works today", the docs); planned features are
  labelled as planned. Prices and limits come from `packages/shared`, never typed by hand. No superlatives we can't
  prove ("cheapest", "fastest"): say "low-cost" or "affordable", or show the price.
- **No competitor or other product names**, no comparisons, no "alternative to X" pages (rule 57).
- **No third-party requests** for SEO: no tag managers, analytics, verification scripts, remote fonts or images
  (rule 29). Search-console verification, if ever needed, uses a DNS TXT record, not a meta tag or script.
- **No location.** Structured data and copy never state or imply where the company or the servers are.
- One H1 per page; headings in sentence case; descriptive link text and alt text.

## Deploy

The docs ship with `apps/site` (same image, same release). No separate deploy and no separate domain.
