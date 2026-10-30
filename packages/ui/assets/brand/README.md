# Brand assets (single source)

The AnhourMail logo and icon set, and the Anhourtec company logo, used by every AnhourMail app. Edit files **here
only**, then run `npm run brand:sync` — it copies every file in this folder (not sub-folders, not this README) into
`apps/web/public` and `apps/site/public`; `npm run check:brand` (pre-commit + CI) fails if the copies drift or an app
still holds a retired file. Rules: CLAUDE.md rule 53, docs/internal/branding.md.

The email logo PNGs in `email/` are rendered from the logo SVGs with `node scripts/render-email-logo.mjs` (Playwright
Chromium, already installed for the e2e suite); `npm run brand:sync` then regenerates the embedded copy in
`packages/adapters/src/mail/logo.generated.ts` (branding.md "Transactional email").

Logo: the Anhourtec glyphs spelling ANHOURMAIL, with the O drawn as an envelope.

## Browser and app icons

| File                                     | Use                                                              |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `favicon.svg`                            | Modern browsers; switches blue ↔ cyan with the OS theme          |
| `favicon.ico`                            | Fallback (16, 32, 48 px)                                         |
| `favicon-16x16.png`, `favicon-32x32.png` | PNG fallbacks                                                    |
| `apple-touch-icon.png`                   | iOS home screen, 180 px, full-bleed (iOS rounds it)              |
| `icon-192.png`, `icon-512.png`           | Web app / Android icons                                          |
| `icon-maskable-512.png`                  | Android adaptive icon (glyph inside the safe zone)               |
| `site.webmanifest`                       | Web app manifest                                                 |
| `og-image.png`                           | Social share card, 1200 × 630, navy (the marketing site's image) |

`github/social-preview.png` (1280 × 640, navy, logo and tagline) is the repository's GitHub social preview, rendered
with `node scripts/render-social-preview.mjs` and uploaded by hand in GitHub → Settings → General → Social preview.
It sits in a sub-folder, so it isn't copied into the apps.

`BRAND_ICONS` in `packages/ui/src/anhourtec-logo.tsx` wires the icons and manifest into each app's metadata.

## Logos

| File                                                                 | Use                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| `anhourmail-logo-light.svg`                                          | On white and light surfaces: ink with a blue envelope  |
| `anhourmail-logo-dark.svg`                                           | On navy and dark surfaces: white with a cyan envelope  |
| `anhourmail-logo-black.svg`, `anhourmail-logo-white.svg`             | One colour (print, embossing, overlays on photos)      |
| `anhourmail-icon-light.svg`, `-dark.svg`, `-black.svg`, `-white.svg` | The envelope-O on its own, transparent                 |
| `anhourmail-app-icon.svg`                                            | Blue rounded tile with a white envelope                |
| `print/anhourmail-logo-{light,dark}.png`, `@2x.png`                  | Raster logos for documents (not copied into the apps)  |
| `email/anhourmail-logo-email-{light,dark}.png`                       | Logo embedded in system emails, 2x (not copied)        |
| `anhourtec-logo-light-bg.svg`, `anhourtec-logo-dark-bg.svg`          | The Anhourtec company logo on light / dark backgrounds |

In the UI, render the logo with `Wordmark` (`@anhourmail/ui/wordmark`): `tone="auto"` follows the theme with the
`dark` class; `tone="onDark"` is for surfaces that stay dark in both themes (the site's nav pill and footer, the
console app bar) and always shows the dark-surface logo.

## Colours

| Role                 | Light                            | Dark                                  |
| -------------------- | -------------------------------- | ------------------------------------- |
| Letters              | `--am-ink` 15 20 30 (`#0F141E`)  | white                                 |
| Envelope             | `--am-btn` 0 119 200 (`#0077C8`) | `--am-cyan-hi` 56 206 255 (`#38CEFF`) |
| Background (OG card) | none                             | navy 7 13 24 (`#070D18`)              |

## Rules

- Leave clear space around the logo at least the height of the envelope-O on every side.
- Minimum size: 96 px wide for the wordmark, 16 px for the icon.
- Don't recolour individual letters, stretch the logo, add effects, or put the light logo on navy.
- The AnhourMail and Anhourtec names and logos are trademarks (TRADEMARKS.md): forks must replace them.
- Third-party logos are never used (no implied endorsement).
