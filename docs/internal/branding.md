# Branding

Last updated: 2026-10-21. Adapted from iotkinect-portal's design system (app) and BookYourPTO's marketing style (site): see `research/reference-patterns.md` "Design system" and "BookYourPTO-Frontend". Tokens: `packages/ui/src/styles/tokens.css`. Type: `typography.md`.

## Principles

- **Say what it does, fast.** Titles name the task. No welcome copy, no hype.
- **Light is light, dark is navy**, never pure black.
- **Open, not boxy:** hairlines and whitespace. Cards only for real objects, never cards inside cards.
- **Calm motion:** 150–200 ms ease-out. No loops except skeletons. No glows, parallax or gradient text. Respect `prefers-reduced-motion`.
- **Truthful:** no invented stats, testimonials or logos. Pricing and limits come from `packages/shared`.
- **Private by construction:** zero third-party requests on any page (fonts self-hosted, no analytics, no CDNs, no embeds).
- Sentence case everywhere. One primary button per view. Lucide icons only (16 px inline, 20 px nav). No emoji, no stock photos.

## Colour

One Anhourtec blue across products (the portal and BookYourPTO share it). Raw tokens are space-separated RGB so alpha works (`rgb(var(--am-ink) / .5)`). **Never use hex in components**; transactional email templates are the only exception.

| Token                             | RGB                       | Use                                                   |
| --------------------------------- | ------------------------- | ----------------------------------------------------- |
| `--am-ink`                        | 15 20 30                  | Headings, primary text                                |
| `--am-ink-soft`                   | 71 80 96                  | Secondary text                                        |
| `--am-ink-mute`                   | 100 110 128               | Muted text (the lightest readable text in light mode) |
| `--am-ink-accent`                 | 3 105 161                 | Accent text in light mode (5.9:1)                     |
| `--am-line`                       | 226 230 236               | Hairlines, borders, inputs                            |
| `--am-surface` / `--am-surface-2` | 246 248 251 / 238 241 246 | Muted / hover surfaces                                |
| `--am-cyan`                       | 5 189 255                 | Decorative only (2.3:1)                               |
| `--am-cyan-hi`                    | 56 206 255                | Accent text and primary in dark mode                  |
| `--am-btn` / `--am-btn-hi`        | 0 119 200 / 0 101 172     | Primary button (white text 4.7:1) / hover             |
| `--brand`                         | = `--am-btn`              | A single alias (no tenants)                           |

Dark mode (`.dark` on `<html>`, `next-themes`, default `system`): background 7 13 24, cards 12 26 46, muted 17 34 58, borders white/10, and text never below white/60.

**Status pills** (`.am-status--success|warning|danger|neutral|info`): tone text on a light tint of the same tone, a hairline ring and a 6 px radius, with no dot.

## Radius and spacing

`--radius: 0.5rem`. Buttons and inputs 8 px, status badges 6 px, other pills 999 px, framed images 12 px, cards/dialogs/sheets 14–16 px. Nothing in the app is larger than 16 px. Responsive checks at 1440 / 1024 / 390: no horizontal scroll at 390, tap targets ≥ 40 px, 16 px gutter.

## App components (console + webmail)

- **Page header:** `PageHeader` from `@anhourmail/ui/page-header` — optional breadcrumb, h1 with actions on the right,
  one lead line. **No eyebrow label above the title** (decision 2026-10-21). Context comes from breadcrumbs, shown only
  when the page is at least two levels deep (e.g. `Demo Family › Domains › example.com`). No card around the page.
- **Buttons:** actions use `size="sm"` with a leading Lucide icon. Full-width `lg` only for auth submits. Destructive actions go through a confirm dialog that names the thing.
- **Lists:** one shared DataTable (title + count, search, column visibility, sortable headers with `aria-sort`, bulk bar, row click opens detail, numbered pagination). Cells: StatusBadge, DateCell (mono, `en-CA`, "Never"), EntityCell, icon-only RowAction with a required label.
- **Mail-specific:** DNS record rows (mono values, per-row copy button, live status pill), alias chips (`.am-tag`), the three-pane webmail with resizable panes.
- **Empty states** say what is missing plus one action. No illustrations.
- **Toasts** confirm completed actions. Errors that need a decision stay inline.
- **Skeletons** on every page and waiting component, mirroring the real layout (rule 11). Mail skeletons are folder tree, message list and reader.
- **Scrollbars** stay transparent until scrolling.

## Marketing site and docs (`apps/site`)

The BookYourPTO look, rebuilt in React and Tailwind v4 with an `am-site-*` prefix:

- A medium-weight geometric display (General Sans 500, tight tracking) and the single Anhourtec blue.
- 8 px buttons with an inset highlight. A floating rounded nav pill. Big soft cards (20–30 px radius), pill eyebrows, an ~80 px section rhythm, and dark "night" bands (`night`, `night-gradient` navy → teal, `night-fade`) for statements and the final CTA.
- Scroll reveals use one shared IntersectionObserver, are disabled under reduced motion, and there is no smooth-scroll library.
- **Sections:** hero (changelog chip, h1, lead, waitlist CTA + "How it works"), product shot, night-band statement, alternating feature rows (private by default, your domain, fast webmail, aliases and masked aliases, no tracking), security/trust panel, three-step "how it works", pricing (from `packages/shared`), FAQ, final CTA with the waitlist form. **No testimonials or logo strips until they are real.**
- The docs use the same header, footer, tokens and fonts, with Fumadocs layout primitives restyled to the tokens.

## Voice

Short, confident, concrete, a little warm. Outcomes over features. No exclamation marks. Curly apostrophes.

- "Email that's yours. Open source."
- "Your domain, your aliases, one bill a year."
- "Remote images stay blocked until you say so."

Never claim "unhackable", "military-grade" or "immune to government requests". Say exactly what we do.

## Transactional email

One plain 570 px layout: tables, inline styles, an Outlook VML button, system fonts, a hidden preheader, a `prefers-color-scheme` dark block and a plain-text part. Sent from `anhourmail.com` addresses through our own Stalwart. No tracking pixels or click tracking.

## Brand assets

Single source: `packages/ui/assets/brand` (CLAUDE.md rule 53). The Anhourtec logo appears in the site footer
("Made by Anhourtec") and on the console sign-in page, via `AnhourtecLogo` (light/dark variants). Third-party
logos are never used.

## No floating callout pills

Decision 2026-10-21 (maintainer): **no floating callout pills or badges** on illustrations, product mocks, heroes
or brand panels — e.g. an icon + "Tracker blocked" chip (`am-site-callout`) hovering over a card. They read as
marketing decoration and clutter the composition. Show the state _inside_ the illustration instead (a blocked-image
placeholder in the message, an alias toggling in the list). Status pills (`am-status`) remain for real data in
tables and lists.

## No pill clouds for feature lists

Decision 2026-10-21 (maintainer): feature or benefit lists are **never** rendered as a row/cloud of pills or
eyebrow chips ("No ads · No tracking pixels · …"). Use a structured grid instead — small icon, short title, one
plain sentence, hairline separators. The eyebrow style labels a single section; it is not a list format.

## Wordmark

Decision 2026-10-21 (maintainer): the AnhourMail wordmark is **uppercase and wide-tracked** (General Sans, weight
500, tracking 0.18em) so it sits naturally beside the Anhourtec logo, and it is **text only — no brand square or
dot** before it. Use `Wordmark` from `@anhourmail/ui/wordmark` everywhere (console, webmail, site, docs); the
accessible name stays "AnhourMail" (CSS uppercases it). A product area may follow after a hairline in quiet
sentence case (`Wordmark suffix="Webmail"`).

## Eyebrows and kickers

Decision 2026-10-21 (maintainer): no eyebrow labels as default decoration.

- **App (console, webmail):** never. Page context = breadcrumbs (`PageHeader`).
- **Marketing site:** a kicker (`.am-eyebrow`: sentence case, 14 px, weight 500, accent colour, no uppercase mono,
  no square, no pill) only where it adds information — e.g. "Coming later" above an add-on, a step number. Most
  sections need only a title and a lead. Never on legal, docs or blog pages; never in brand panels; never as a
  list of pills.
