# @anhourmail/jmap-client

The only JMAP client for mailbox data (CLAUDE.md rule 21). RFC 8620 (core) + RFC 8621 (mail, submission).

- Browser-safe: `fetch` only, no Node APIs. The auth header is injected by the caller.
- In production it runs behind our same-origin proxy (`mail.anhourmail.com/jmap`), which attaches the user's
  Stalwart token server-side; the browser never holds a Stalwart credential (docs/internal/01-architecture.md).
- Phase 0 has the primitives used by the dev-stack check. The webmail sync engine (`*/changes`, push,
  IndexedDB cache) builds on these in Phase 4 (docs/internal/05-webmail.md).
