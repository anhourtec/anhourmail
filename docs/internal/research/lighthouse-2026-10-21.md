# Lighthouse — marketing site (2026-10-21)

Production build (`npm run build -w @anhourmail/site`, `next start` on 127.0.0.1:43110), Lighthouse 12.6.1 with
Playwright's Chromium, headless. Desktop = `--preset=desktop`; mobile = Lighthouse default (simulated slow 4G,
4× CPU). Categories: performance, accessibility, best practices, SEO.

## Final scores

| Page | Desktop P / A / BP / SEO | Mobile P / A / BP / SEO |
| --- | --- | --- |
| `/` | 99 / 100 / 100 / 100 | 88 / 100 / 100 / 100 |
| `/pricing` | 100 / 100 / 100 / 100 | 88 / 100 / 100 / 100 |
| `/features` | 99 / 100 / 100 / 100 | 88 / 100 / 100 / 100 |
| `/security` | 100 / 100 / 100 / 100 | 88 / 100 / 100 / 100 |
| `/docs` | 99 / 100 / 100 / 100 | 85 / 100 / 100 / 100 |
| `/blog` | 98 / 100 / 100 / 100 | 90 / 100 / 100 / 100 |

Desktop meets the Phase 2 bar (≥ 95) in every category. Mobile meets it for accessibility, best practices and SEO;
**mobile performance (85–90) does not yet** — see below.

## Fixed in this pass

- **Mobile LCP 4.5 s → 3.8 s:** above-the-fold (`onLoad`) reveals no longer start at `opacity: 0`; they keep the
  rise motion but the hero text paints immediately (`.am-site-reveal--visible`).
- **SEO `link-text`:** "Learn more" links carry a screen-reader suffix naming the feature.
- **Accessibility `heading-order`:** visually hidden section headings before the home highlights and the pricing
  cards, so card titles (h3) follow an h2.

## Remaining: mobile performance

Unthrottled LCP render delay is ~90 ms; the simulated mobile LCP (3.8–4.3 s) is driven by **web fonts**. Five font
files (~230 KB) are preloaded at high priority and compete with the CSS; when Geist swaps in, the text re-renders and
Chrome records a later LCP. Fonts are configured in `packages/ui/src/fonts.ts` (shared with the console), so the fix
belongs there:

1. `GeistMono`: `preload: false` (only used below the fold: numbers, DNS values).
2. General Sans: preload only Medium (weight 500 — headings); `preload: false` for Regular and Semibold.
3. Geist (body): consider `display: "optional"` with the size-adjusted fallback next/font generates, so a slow
   first visit keeps the fallback instead of swapping (no late LCP; cached visits get Geist).
4. Optional: the docs search dialog chunk (~32 KB, unused on first paint) can be loaded on first open.

Re-run with `scratchpad`-style script: build, `next start --port 43110`, then Lighthouse per page/form factor.

## Re-run after the fixes (same day)

Applied: only General Sans Medium is shipped and preloaded (Regular/Semibold dropped); Geist is self-hosted in
`packages/ui/src/fonts`, `display: optional`, not preloaded; Geist Mono not preloaded; the docs framework provider
(search, docs UI) now mounts only under `/docs` (a small `next-themes` provider covers the rest); the waitlist form
imports `KNOWN_SOURCES` from the zod-free `@anhourmail/shared/sources`.

| Page (mobile) | Perf | A11y | BP | SEO | LCP | JS |
| --- | --- | --- | --- | --- | --- | --- |
| / | 92 | 100 | 100 | 100 | 3.2 s | 153 KB |
| /pricing | 94 | 100 | 100 | 100 | 2.9 s | 153 KB |
| /security | 90 | 100 | 100 | 100 | 3.4 s | 153 KB |
| /docs | 87 | 100 | 100 | 100 | 3.8 s | 258 KB |

Observed (unthrottled) LCP is ~110 ms; the simulated figure is now dominated by React hydration (~72 KB of the
153 KB). Remaining options, not done: lazy-load the docs search dialog; replace the client `Reveal` wrapper on
the hero with CSS-only animation.
