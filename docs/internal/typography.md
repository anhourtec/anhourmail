# Typography

Last updated: 2026-10-21. Classes: `packages/ui/src/styles/type.css` (`am-*`, app scale). Marketing scale (`am-site-*`) lives in `apps/site`. Rules: `branding.md`.

## Fonts (all self-hosted; no third-party font requests)

| Family                         | Role                                              | Source                                                                                                                                       | CSS variable                             |
| ------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| General Sans 500 (Medium only) | Display and headings, weight **500**              | `packages/ui/src/fonts/GeneralSans-*.woff2`, copied from iotkinect-portal (Fontshare, ITF Free Font License, ADR-0012) via `next/font/local` | `--font-general-sans` → `--font-display` |
| Geist                          | UI and body                                       | `geist` npm package                                                                                                                          | `--font-sans`                            |
| Geist Mono                     | Labels, numbers, ids, hostnames, DNS values, code | `geist` npm package                                                                                                                          | `--font-mono`                            |

`brandFontVars` (from `@anhourmail/ui/fonts`) goes on `<html>`. Only General Sans Medium (23 KB) is preloaded; Geist (`display: optional`) and Geist Mono load on demand (Lighthouse mobile, 2026-10-21). A metric-matched fallback (`"General Sans Fallback"`: Arial with `size-adjust: 102%`) prevents layout shift.

## App scale (console + webmail)

| Class        | Font         | Size                                                 | Weight  | Line-height | Tracking | Use                                                                          |
| ------------ | ------------ | ---------------------------------------------------- | ------- | ----------- | -------- | ---------------------------------------------------------------------------- |
| `am-h1`      | General Sans | `clamp(1.625rem, 1.3rem + 1vw, 2.125rem)` (26→34 px) | 500     | 1.12        | −0.025em | Page title, one per page, balanced                                           |
| `am-h2`      | General Sans | `clamp(1.25rem, 1.1rem + .5vw, 1.5rem)` (20→24 px)   | 500     | 1.2         | −0.02em  | Section                                                                      |
| `am-h3`      | General Sans | 1.125rem (18 px)                                     | 500     | 1.3         | −0.01em  | Card / panel title                                                           |
| `am-h4`      | Geist        | 0.9375rem (15 px)                                    | 500     | 1.4         | —        | Item title (lists, dialogs, message subject in list)                         |
| `am-lead`    | Geist        | 1rem                                                 | 400     | 1.6         | —        | Muted intro                                                                  |
| `am-body`    | Geist        | 0.9375rem                                            | 400     | 1.6         | —        | Body, message list preview                                                   |
| `am-small`   | Geist        | 0.8125rem (13 px)                                    | 400     | 1.5         | —        | Helper text                                                                  |
| `am-micro`   | Geist        | 0.75rem (12 px, the minimum)                         | 400     | 1.4         | —        | Timestamps, fine print                                                       |
| `am-eyebrow` | Geist        | 0.875rem (14 px), sentence case                      | 500     | 1.4         | —        | Accent colour; rare marketing kicker only — never on app pages (branding.md) |
| Wordmark     | General Sans | 14 px, uppercase                                     | 500     | 1           | 0.18em   | `Wordmark` component; text only, no square                                   |
| `am-mono`    | Geist Mono   | 0.6875rem, uppercase                                 | 500     | —           | 0.06em   | Column labels                                                                |
| `am-num`     | Geist Mono   | inherit                                              | inherit | —           | —        | `tabular-nums` (counts, quotas, sizes)                                       |
| `am-code`    | Geist Mono   | 0.85em                                               | inherit | —           | —        | Inline code, DNS values, hostnames                                           |

Webmail reading pane: message HTML renders inside the sandboxed iframe with its own neutral base styles (system UI font, 15 px, 1.6). We don't force our fonts on senders' HTML. Plain-text messages use Geist at `am-body` size with `white-space: pre-wrap` and wrap long lines.

## Marketing scale (`apps/site`, from BookYourPTO `sb-*`)

| Class          | Size                                                   | Weight | Line-height | Tracking |
| -------------- | ------------------------------------------------------ | ------ | ----------- | -------- |
| `am-site-h1`   | `clamp(2.25rem, 1.35rem + 3.6vw, 3.5rem)` (36→56 px)   | 500    | 1.14        | −0.028em |
| `am-site-h2`   | `clamp(2rem, 1.35rem + 2.6vw, 3rem)` (32→48 px)        | 500    | 1.18        | −0.028em |
| `am-site-h3`   | `clamp(1.375rem, 1.05rem + 1.3vw, 1.75rem)` (22→28 px) | 400    | 1.2         | −0.03em  |
| `am-site-h4`   | `clamp(1.0625rem, .98rem + .35vw, 1.25rem)`            | 500    | 1.3         | −0.024em |
| `am-site-lead` | `clamp(1rem, .96rem + .18vw, 1.0625rem)`               | 400    | 1.55        | —        |
| `am-site-body` | 1rem, ink-mute                                         | 400    | 1.55        | −0.018em |

The site uses Geist for body (BookYourPTO uses DM Sans; Geist keeps one family across products). Section titles are a short h2 plus one lead sentence at max 44–52ch.

## Rules

- Headings are never bold (500 max).
- Sentence case. CSS uppercases mono labels and the wordmark, so source text stays sentence case.
- Numbers, ids, hostnames, ports and DNS values use mono.
- Light-mode text is never lighter than `--am-ink-mute`. Dark-mode text is never below white/60.
- 12 px is the minimum size anywhere.
