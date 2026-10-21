# 05 — Webmail

Last updated: 2026-10-21. Research: `research/legacy-audit.md`, `research/ui-references.md`, `research/stalwart.md` §5.

## Why HourMail was slow, and what we do instead

HourMail opened a new IMAP connection and logged in on every API call, ran one STATUS per folder serially, re-polled every 30 s, preloaded every folder, autosaved drafts every 2 s with 2–3 IMAP sessions each, and downloaded and re-parsed whole raw messages for each view and attachment (`research/legacy-audit.md`, with file references).

AnhourMail: **browser → same-origin BFF (`mail.anhourmail.com`) → Stalwart JMAP.** There is no IMAP in the browser path. We sync incrementally, push changes, cache locally and fetch only what is on screen.

## Client architecture

```
React UI (virtualized lists, reader iframe, composer)
   │  hooks / selectors
Sync engine (packages/jmap-client + webmail store)
   │  IndexedDB cache: mailboxes, thread/email summaries, state strings, bodies (LRU, size-capped)
   │  outbox queue (optimistic actions with rollback)
Same-origin BFF  /jmap (proxy) · /jmap/push (SSE) · /jmap/upload · /jmap/download · /img (image proxy)
   │  attaches the user's Stalwart Bearer token server-side; rewrites session URLs
   │  (token from the headless OAuth code flow — see "Session acquisition")
Stalwart JMAP (Core, Mail, Submission, Blob, Quota, Sieve, WebSocket push)
```

### Sync

- On load: render from IndexedDB immediately, then `Mailbox/changes`, `Email/changes`, `Thread/changes` from the stored `state` strings. Fall back to `/query` + `/get` on `cannotCalculateChanges`.
- Lists use `Email/query` with `collapseThreads`, windowed (`position`/`limit` around the viewport), and `Email/queryChanges` to patch the open list without refetching.
- List rows fetch summary properties only (from, subject, preview, receivedAt, keywords, size, hasAttachment). Bodies load on open (`bodyValues` for the chosen part, `maxBodyValueBytes`), with the next/previous message prefetched.
- Batch method calls with back-references (≤ 16 per request, the server's `maxCallsInRequest`).
- **Concurrency (answered in Phase 1, ADR-0018):** `maxConcurrentRequests` = 4 per user is enforced — a burst of 40
  heavy requests got 16–20 × 200 and the rest `400 urn:ietf:params:jmap:error:limit`. The BFF keeps a **per-user
  queue with ≤ 4 in flight** and retries `limit` errors with jittered backoff; we may raise the server value to 8
  once measured, but the queue stays (the browser never fans out directly).

### Session acquisition (answered in Phase 1, ADR-0018)

The BFF gets a per-user Stalwart token with the **headless OAuth authorization-code flow + PKCE**, verified end to end
on v0.16.27 (2026-10-21):

1. One-time setup: `x:OAuthClient/set create {clientId:"anhourmail-webmail", redirectUris:{"https://mail.anhourmail.com/oauth/callback":true}}`
   (discovery: `/.well-known/oauth-authorization-server` → `token_endpoint /auth/token`, grants `authorization_code`,
   `refresh_token`, device code; PKCE `S256` only).
2. Webmail sign-in form (mailbox address + mailbox password, + TOTP if enabled) posts to the BFF, which calls
   `POST /api/auth` `{"type":"authCode","accountName","accountSecret","clientId","redirectUri","codeChallenge",
"codeChallengeMethod":"S256"}` → `{"type":"authenticated","client_code":"…"}` (wrong password →
   `{"type":"failure"}`, still HTTP 200 — map it to our generic error).
3. `POST /auth/token` (form-encoded) `grant_type=authorization_code&code&client_id&redirect_uri&code_verifier` →
   `{access_token, token_type:"Bearer", expires_in:3600, refresh_token, id_token}`; a wrong verifier →
   `400 invalid_grant`.
4. The BFF stores both tokens **encrypted server-side** (rule 16), keyed to the webmail session cookie; the browser
   never sees them. `Bearer` works on `/jmap/session`, `/jmap` and the push channels.
5. Refresh: `grant_type=refresh_token&refresh_token&client_id` → new `access_token` (same refresh token until its
   renewal window).
6. **A mailbox password change revokes every token** (access → 401, refresh → `invalid_grant`): the BFF treats both
   as "signed out" and shows the sign-in form.

The mailbox secret therefore comes from the user at webmail sign-in; it is used once and never stored (mailbox
passwords are argon2id PHC strings in Stalwart, so we cannot derive tokens without the user). The console → webmail
handoff (ADR-0003) pre-fills the address only.

### Push

- The BFF holds **one upstream push channel per active user**: the JMAP WebSocket with `WebSocketPushEnable` (preferred) or EventSource. It fans `StateChange` events out to every open tab over **our own SSE** endpoint. Tabs share one connection via `BroadcastChannel` and leader election.
- A state change triggers `*/changes` for the affected types only. There is no polling (except a 5-min safety resync when push is down).
- **Answered (Phase 1, ADR-0018):** long-lived channels do **not** count against `maxConcurrentRequests`. With one
  WebSocket (`/jmap/ws`, subprotocol `jmap`, `WebSocketPushEnable`) and five EventSource streams open for the same
  user, bursts of 4 and 8 requests still all succeeded, and the 40-request overload test produced the same share of
  `limit` errors as with no channels. Sizing: one upstream WebSocket per active user (EventSource as fallback),
  plus the ≤ 4 in-flight request queue above.

### Rendering safety

- Server-side sanitising (allow-list sanitizer; HourMail's DOMPurify config is the starting point, hardened per `research/legacy-audit.md`) plus a client-side defence in depth.
- Message HTML renders in an `<iframe sandbox>` **without `allow-scripts` and without `allow-same-origin`**, `srcdoc`, with its own CSP: `default-src 'none'; img-src data: https://mail.anhourmail.com/img/; style-src 'unsafe-inline'; font-src data:`. Links open via `target=_blank rel=noopener noreferrer` through a click interstitial for lookalike domains.
- **Remote images are blocked by default.** "Load images" fetches them through our image proxy (`/img/<signed-url>`): no cookies, no referrer, a size cap, and content-type checks. Senders never see the user's IP. The choice can be remembered per sender.
- Print, forward and "view original" run through the same sanitiser and sandbox. Attachments download with `Content-Disposition: attachment` and are never rendered inline on the app origin (all three of HourMail's XSS paths are closed).
- The app CSP is nonce-based with `'strict-dynamic'`, `connect-src 'self'`, `frame-src 'self'` (srcdoc), `object-src 'none'`, `base-uri 'none'`, and `Referrer-Policy: no-referrer`. There are no third-party scripts, fonts, analytics or error reporters (rule 29).

### Zero-access mailboxes (opt-in, `12-encryption-and-security-posture.md` §4)

- Stored bodies arrive as OpenPGP/S/MIME (`application/pkcs7-mime` or PGP/MIME); headers stay readable, so lists,
  threads and subject search work as usual.
- The private key is generated in the browser (OpenPGP.js), stored in IndexedDB wrapped by a passphrase-derived key
  (argon2id in WASM), unlocked per session and **never sent to the server**. Decryption happens in a worker; the
  decrypted HTML then goes through the same sanitiser and sandbox.
- Body search is local: decrypted bodies are indexed on the device (encrypted at rest with the device key); the
  search UI says "searching this device" for encrypted mail.
- Locked state: messages show a "Unlock to read" row instead of a preview; no plaintext is cached unencrypted.
- Recovery: passphrase-protected key backup download + printed recovery sheet during setup; clear warning that a
  lost key means lost mail.

### UI

- Layout skeleton from `next-shadcn-admin-dashboard`'s `/mail` page (MIT): resizable 3-pane (folders · list · reader), cookie-saved split, mobile drawer. We add virtualisation (TanStack Virtual), shortcuts and the composer ourselves; Mail-0/Zero (MIT) is a pattern reference only. Nothing is copied from AGPL webmails into MIT packages (`research/ui-references.md`).
- Design tokens and skeletons come from `packages/ui` (`branding.md`). Mail skeletons: `FolderTreeSkeleton`, `MessageListSkeleton`, `ReaderSkeleton`.
- Optimistic actions (archive, delete, flag, read, move) are applied instantly with rollback on failure (an idea kept from HourMail). An outbox queue handles send with undo-send (5–30 s, user setting).

### Keyboard shortcuts (Gmail-compatible defaults, rebindable later)

| Key                   | Action                      | Key                   | Action                      |
| --------------------- | --------------------------- | --------------------- | --------------------------- |
| `j` / `k`             | next / previous message     | `c`                   | compose                     |
| `o` / `Enter`         | open                        | `r` / `a` / `f`       | reply / reply all / forward |
| `u`                   | back to list                | `e`                   | archive                     |
| `#`                   | delete                      | `!`                   | report junk                 |
| `s`                   | star                        | `Shift+i` / `Shift+u` | mark read / unread          |
| `x`                   | select                      | `/`                   | search                      |
| `g i` / `g s` / `g d` | go to inbox / sent / drafts | `?`                   | shortcut help               |
| `⌘/Ctrl+Enter`        | send                        | `Esc`                 | close composer / dialog     |

## Folders (Outlook parity, ADR-0014)

| Capability                                                                           | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Plan                        | Phase                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------ |
| System folders: Inbox, Drafts, Sent, Archive, Junk, Trash                            | JMAP `role`s; Archive created at provisioning (verified: a new account has inbox, drafts, sent, junk, trash only; `Mailbox/set create {name:"Archive", role:"archive"}` works); Inbox/Junk/Trash can't be deleted (server rule)                                                                                                                                                                                                                                       | All                         | 4                              |
| Custom and nested folders: create, rename, move, delete                              | `Mailbox/set` via the BFF; depth ≤ 6, name ≤ 120 chars, count ≤ plan limit enforced by the BFF (re-verified in Phase 1, 2026-10-21: `x:Email.maxMailboxDepth` = 10 is enforced for single creates — level 11 fails `invalidProperties` "too deep" — but a 14-level batched chain of `#back-references` was accepted); delete refuses folders with subfolders (`mailboxHasChild`) — UI offers "delete with subfolders" which removes children first after confirmation | All                         | 4                              |
| Unread / total counts, unread-only view                                              | `unreadEmails` / `totalEmails` from `Mailbox/get` + `Mailbox/changes`                                                                                                                                                                                                                                                                                                                                                                                                 | All                         | 4                              |
| Favourites (pinned to top), colours, collapsed state                                 | `folder_preference` in the control plane (JMAP has no such property)                                                                                                                                                                                                                                                                                                                                                                                                  | All                         | 4 (favourites) · 4.1 (colours) |
| Drag-and-drop move of messages and folders                                           | `Email/set mailboxIds` / `Mailbox/set parentId`                                                                                                                                                                                                                                                                                                                                                                                                                       | All                         | 4                              |
| "Move to folder…" picker with type-ahead, recent folders                             | client                                                                                                                                                                                                                                                                                                                                                                                                                                                                | All                         | 4                              |
| Archive (one key: `e`), archive by year (`Archive/2026`)                             | client action; optional account `folder_policy`                                                                                                                                                                                                                                                                                                                                                                                                                       | All                         | 4 (archive) · 4.1 (by year)    |
| Rules: "always move messages from X to folder"                                       | Sieve `fileinto` compiled from the rule builder (no raw Sieve in v1)                                                                                                                                                                                                                                                                                                                                                                                                  | All                         | 4.1                            |
| Search folders (saved searches, e.g. "unread from family", "has attachments > 5 MB") | `saved_search` = stored JMAP `Email/query` filter, run by the client                                                                                                                                                                                                                                                                                                                                                                                                  | All                         | 4.1                            |
| Junk / Trash clean-up                                                                | server-wide 30-day auto-expunge; optional shorter account policy run by the worker (Trash/Junk only)                                                                                                                                                                                                                                                                                                                                                                  | All · policy Plus/Supporter | 4 · 6                          |
| Empty Trash / Junk now                                                               | `Email/set destroy` in batches, with confirmation                                                                                                                                                                                                                                                                                                                                                                                                                     | All                         | 4                              |
| Folder sharing, shared-mailbox folders                                               | `shareWith` (ADR-0013); shared mailboxes appear as their own trees                                                                                                                                                                                                                                                                                                                                                                                                    | All (own) · Plus (shared)   | 4                              |
| IMAP/POP visibility                                                                  | IMAP shows every subscribed folder (`isSubscribed`); POP3 shows Inbox only (protocol limit) — "Show in mail apps" toggle maps to `isSubscribed`                                                                                                                                                                                                                                                                                                                       | All                         | 4                              |

Folder changes are mail data in Stalwart and are not written to our audit log (they never pass through the
control plane); sharing changes and account folder policies are audited (`audit.md`).

## Signatures (Outlook parity, ADR-0014)

| Capability                                                                                                                          | How                                                                                                                                      | Plan                    | Phase                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------- |
| Rich-text and plain-text signature per identity                                                                                     | editor with the same sanitiser as message HTML; mirrored to `Identity.htmlSignature/textSignature`                                       | All                     | 4 (one per identity) |
| Several signatures; default for new mail vs replies/forwards; pick per message                                                      | `signature` + `signature_default` in the control plane                                                                                   | All                     | 4.1                  |
| Images in signatures                                                                                                                | uploaded, embedded as `cid:` at send; **remote image URLs are refused** (tracking risk); caps 64 KB HTML, 3 images, 200 KB               | All                     | 4.1                  |
| Signatures for shared mailboxes and aliases                                                                                         | each identity has its own set; members of a shared mailbox edit its signatures                                                           | Plus/Supporter (shared) | 4.1                  |
| Admin signature templates with placeholders (`{{name}}`, `{{title}}`, `{{phone}}`, `{{email}}`, `{{account}}`), optionally enforced | `signature_template`; rendered per member by the worker                                                                                  | Plus/Supporter          | 4.1                  |
| Account disclaimer appended to outgoing mail (optionally external recipients only)                                                  | inserted by the composer/submission path we control, before DKIM; **not** applied to mail sent from IMAP/SMTP clients in v1 (documented) | Plus/Supporter          | 4.1                  |
| Signatures in desktop/phone mail apps                                                                                               | set in the app itself (IMAP/SMTP clients keep their own) — docs page explains                                                            | All                     | 4 (docs)             |

## Performance budgets

| Metric                                                         | Budget (p75, mid-range laptop / 4G phone) |
| -------------------------------------------------------------- | ----------------------------------------- |
| JS shipped for the mail route (gzip)                           | ≤ 180 KB initial, composer lazy           |
| Cold load to interactive inbox (no cache)                      | ≤ 2.0 s laptop / 3.0 s phone              |
| Warm load (IndexedDB) to list painted                          | ≤ 300 ms                                  |
| Folder switch, cached                                          | ≤ 100 ms                                  |
| Folder tree with counts painted (≤ 250 folders, cached / cold) | ≤ 50 ms / ≤ 300 ms                        |
| Create / rename / move a folder (optimistic)                   | ≤ 50 ms feedback, server confirm ≤ 500 ms |
| Insert a signature on compose / switch signature               | ≤ 30 ms                                   |
| Open message, cached / uncached                                | ≤ 150 ms / ≤ 400 ms                       |
| Scroll a 10k-message folder                                    | 60 fps, ≤ 50 DOM rows                     |
| Action feedback (archive, flag)                                | ≤ 50 ms (optimistic)                      |
| New mail visible after delivery                                | ≤ 2 s (push)                              |
| Search results first page                                      | ≤ 800 ms                                  |

Budgets are checked by Playwright performance tests with seeded mailboxes (Phase 4 exit criteria).

## Scope

### Shared and delegated mailboxes (`10-collaboration.md`)

- The folder sidebar lists the personal mailbox first, then each shared mailbox and each delegated mailbox (from the JMAP session's non-personal accounts), each collapsible, with unread counts.
- The composer's **From** picker lists only identities the BFF says the actor may use: own addresses and aliases, shared mailboxes they belong to (send as), and send-on-behalf grants. The BFF re-checks on submit and audits send as / on behalf; it never trusts the picker.
- Folder sharing: "Share folder…" on a folder opens a dialog with people from the same account only (no directory search across accounts), presets (read, read + organise, full), optional expiry; applies per folder ("include subfolders" applies to each child).
- Lists: sending to a list the actor can't post to shows an inline error before send.

| v1 (Phase 4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | v1.1                                                                                                                                                                                                                                                                                                                                                                           | v2                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Shared mailboxes and folder sharing in the sidebar, send as from shared mailboxes, auto-reply; folders, threads, read/compose/reply/forward (plain + basic rich text), attachments upload/download, drafts, undo send, search (server FTS), flags, move/archive/junk with training, remote-image proxy, shortcuts, light/dark, mobile layout, identities/aliases as From, masked-alias quick create from composer, settings basics (one signature per identity, vacation responder), nested folders with favourites, archive, Archive created at provisioning, empty Trash/Junk | Multiple signatures + defaults, admin signature templates, account disclaimer, search folders, folder colours, archive by year, folder rules, Send on behalf, personal send-as delegation, mail flow rules UI (admins), filters on shared mailboxes, Sieve filter editor, snooze/send later, contacts autocomplete from CardDAV, multiple mailboxes switcher, PWA offline read | Calendar/contacts UI with delegation, resource mailboxes (rooms/equipment) booking, PGP, encrypted-at-rest settings, rules templates |
