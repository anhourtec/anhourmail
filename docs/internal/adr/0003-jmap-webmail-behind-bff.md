# ADR-0003: JMAP webmail behind a same-origin BFF, with an app./mail. host split

Status: Accepted, 2026-10-21

## Context

HourMail was slow because it used IMAP per request from the server (`research/legacy-audit.md`). The browser must never hold Stalwart credentials. Email HTML is untrusted content.

## Decision

- The webmail talks **JMAP only**, through a **same-origin BFF proxy** in `apps/web`. The BFF holds the user's Stalwart OAuth tokens (headless code flow with PKCE, encrypted at rest) and attaches them server-side. It rewrites session URLs, refreshes tokens, and fans push events out over SSE.
- **Host split:** `app.anhourmail.com` (console) and `mail.anhourmail.com` (webmail) are served by the **same** Next.js app via host routing. Each has its own host-only `__Host-` cookie, and a one-time 60-second handoff code moves the user from console to webmail. Dev keeps everything on `localhost` with one port per origin: console `localhost:43200`, webmail `localhost:43300` (`scripts/dev-mail-proxy.mjs` forwards into the same app; routing by port). Browsers don't scope cookies by port, so the webmail session uses its own cookie name to avoid collisions in dev.
- HTML renders in a sandboxed iframe without scripts or same-origin, with remote images blocked and proxied (`05-webmail.md`).

## Consequences

- A rendering bug on `mail.` cannot read console cookies or call console APIs (billing, deletion, staff tools).
- One codebase and one deployable. Shared session store, two cookies.
- The BFF is on the hot path. It must stream bodies and blobs without buffering and respect Stalwart's `maxConcurrentRequests`.

## Alternatives

- Browser talks to Stalwart directly with its OAuth token: rejected (token in the browser, CORS, no control).
- Separate webmail app: rejected for v1 (two deployables, duplicated auth). The host split gives the isolation without it.
- Same origin for console and webmail: rejected (blast radius of an HTML-rendering bug).
