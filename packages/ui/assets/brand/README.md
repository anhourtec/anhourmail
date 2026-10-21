# Brand assets (single source)

Anhourtec company logo and the icon set used by every AnhourMail app. Edit files **here only**, then run
`npm run brand:sync` — it copies them into `apps/web/public` and `apps/site/public`; `npm run check:brand`
(pre-commit + CI) fails if the copies drift. Rules: CLAUDE.md rule 53, docs/internal/branding.md.

| File                                                       | Use                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `anhourtec-logo-light-bg.svg`                              | Anhourtec logo on light backgrounds                         |
| `anhourtec-logo-dark-bg.svg`                               | Anhourtec logo on dark backgrounds (dark mode, night bands) |
| `favicon.ico`, `favicon-96x96.png`, `apple-touch-icon.png` | Browser and home-screen icons                               |
| `icon-192.png`, `icon-512.png`, `site.webmanifest`         | Web app manifest                                            |

The Anhourtec name and logo are trademarks (TRADEMARKS.md): forks must replace them.
Third-party logos are never used (no implied endorsement).
