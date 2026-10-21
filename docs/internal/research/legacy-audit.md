# Legacy webmail audit (HourMail)

Date: 2026-10-21
Source: /Users/nish/Development/Hourmail @ e7c3a9b (main)

Note: the working tree has `app/`, `Dockerfile` and `LICENSE` deleted but still tracked. Those files were read from `HEAD`, so every `app/...` reference below points to commit e7c3a9b. Secrets, `.env*` and customer data were not read.

## Summary

- HourMail is a thin Nuxt 4 BFF (backend-for-frontend) over IMAP. **Every API call opens a new TLS connection to IMAP, logs in, runs one operation and logs out** (`server/utils/imap.ts:137-149`, repeated in every exported function). Nothing is pooled, nothing listens with IDLE, and nothing syncs. The only buffer is a 30–60 s Redis cache.
- The slowness comes from how the client uses that model. One inbox load triggers about N+4 IMAP logins (N = folder count). The folder list sends one serial STATUS per folder, and the poller skips the cache to repeat it every 30 s. Draft autosave runs **every 2 s** and each save costs 2+ IMAP sessions. Archive, junk and delete each run a full folder+STATUS scan just to find a special-use folder.
- Opening a message downloads the whole raw source and runs mailparser on it. Inline images become base64 `data:` URIs inside the JSON, and the result is cached in Redis. Downloading an attachment re-downloads and re-parses the whole message.
- **Security is not fit for reuse.** The `PUT /api/org/:domain` route has no authentication and changes IMAP/SMTP hosts, which allows credential harvesting. Org registration has no authentication and doubles as an SSRF port prober. There are three stored-XSS paths: the print view, the forward quote, and inline attachments served from the app origin. Passwords are stored reversibly in Redis for 24 h.
- Worth keeping: UX patterns (optimistic flag/delete with revert, stale-while-revalidate list cache, outbox queue, account switcher), the iframe/srcdoc rendering skeleton (after hardening), envelope address normalisation, and the special-use folder mapping. Nothing here gives the import tool batching, resume or UIDVALIDITY handling; that has to be written new.
- Licence is MIT, copyright "HourMail (Anhourtec)". Concept-level reuse has no obligations. Code copied verbatim must keep the copyright and permission notice.

## Stack & structure

**Versions** (from `package.json`, locked versions in brackets): nuxt ^4.3.0 [4.3.1], vue [3.5.27], @nuxt/ui ^4.4.0, tailwindcss ^4.1, imapflow ^1.0.171 [1.2.9], mailparser ^3.7.2 [3.9.3], nodemailer ^6.10 [6.10.1], dompurify ^3.3.1 (client side), ioredis ^5.6 [5.9.2], @prisma/client ^6.5 [6.19.2], Node 20 (Dockerfile).

**Layout**
- `app/`: Nuxt client.
  - Pages: `inbox/index`, `inbox/[id]`, `folders/[name]`, `starred`, `outbox`, `contacts`, `settings`, `login`, `register`, plus marketing pages (`home`, `features`, `support`).
  - Layout: `layouts/mail.vue` (1189 lines: sidebar, search, account menu, mobile drawer).
  - Composables hold module-level singleton state: `useMail` (671 lines), `useCompose`, `useNotifications`, `useOutbox`, `useContacts`, `useSettings`, `useSignatures`, `useAuth`.
  - Components: `ComposeEditor.vue` (execCommand rich text), `ComposeModal.vue`, `EmojiPicker.vue`, `landing/*`.
- `server/api/`: h3 handlers for `auth/*`, `mail/*` (folders, messages, message by uid/Message-ID, flags, batch-flags, search, starred, archive, junk, draft, send, attachment, contacts and vCard import/export), `org/*` and `settings/*`.
- `server/utils/`: `imap.ts` (all ImapFlow code, 760 lines), `smtp.ts` (nodemailer), `session.ts`, `cache.ts`, `redis.ts`, `prisma.ts`, `vcard.ts`, `messageId.ts`.
- `prisma/schema.prisma`, `docker-compose.yml`, `Dockerfile`, and `docs/*.md` (internal plans).

**Data flow.** Browser → `$fetch('/api/mail/...')`. The handler does three things:
1. Redis `GET session:<token>` and `GET password:<token>`.
2. AES-GCM decrypt of the password.
3. Optional Redis cache lookup. On a miss it calls `new ImapFlow()`, then `connect` (TCP+TLS+LOGIN), then `LIST`/`SELECT`/`FETCH`, then `LOGOUT`.

The JSON response goes to module-level Vue refs, an in-memory `Map` cache and `sessionStorage`. Send uses a fresh nodemailer SMTP transport and then a separate IMAP APPEND to Sent.

**Auth and session** (`server/utils/session.ts`, `server/api/auth/login.post.ts`)
- Login looks up `Organization` by email domain, verifies the credentials with a full IMAP login, and stores the session JSON (hosts, ports, TLS mode) at `session:<token>` (24 h).
- The password is stored AES-256-GCM encrypted at `password:<token>` (24 h). The key is SHA-256 of `NUXT_SESSION_SECRET`, with a hard-coded fallback (`session.ts:20-22`), and there is a legacy plain-base64 "decrypt" path (`session.ts:41-45`).
- Cookies are `hourmail_session` plus a JSON list of tokens `hourmail_accounts` for multi-account (httpOnly, SameSite=Lax).
- Login is rate-limited to 5 attempts per email per 15 min (`login.post.ts:16-23`).

**Prisma (Postgres 16)**
- `Organization`: domain → imapHost/Port, smtpHost/Port, tlsMode, rejectUnauthorized.
- `UserSettings`: keyed by email; push/sound toggles and `pollInterval` (default 30 s).
- `Signature`: name, HTML body, isDefault.
- No mail data is stored in the database.

**docker-compose**
- Three services: `postgres:16-alpine` (published on host 5487), `redis:7-alpine` with requirepass (host 6391), and `app` built from the Dockerfile on `${NUXT_PORT}`. All are on one bridge network with healthchecks.
- The container runs `prisma db push` on every start (Dockerfile CMD).
- Postgres and Redis ports are published to the host, which is unnecessary.

## Why it's slow (ranked, with file:line)

1. **New IMAP connection and LOGIN for every API call; no pool.** `server/utils/imap.ts:137-149` builds a client and each function does `connect()`…`logout()`: 179-200, 210-258, 280-341, 350-400, 410-439, 448-475, 485-502, 513-531, 543-614, 623-664, 673-697, 707-719, 727-736, 746-758. That is 1 TCP + 1 TLS handshake + LOGIN + capability negotiation (≈3–6 round trips, often 100–400 ms) before any work, on every list, open, flag change or poll. Concurrent requests also run into per-user connection caps (Dovecot's default is 10 per user and IP), so they fail or queue.
2. **Folder list = one serial STATUS per folder, and the cache is bypassed constantly.** `imap.ts:186-195` awaits `client.status()` inside a `for` loop (N round trips). `folders.get.ts:14-23` skips the cache when `refresh=true`. The poller always sends `refresh=true` (`app/composables/useNotifications.ts:87-89`), immediately on mount (`:137`) and every `pollInterval` s (`:139-141`, default 30 s per `schema.prisma` `pollInterval`). Compose and draft flows also call `fetchFolders(true)` (`app/composables/useCompose.ts:134,149,218,255`).
3. **Fan-out on first load.** `app/layouts/mail.vue:211-224` calls `fetchFolders()` and `startPolling()`, which duplicates the first folder fetch with `refresh=true`. A `watch(folders)` then fires `preloadAllFolders()` (`app/composables/useMail.ts:573-610`). That function sends **one parallel `/api/mail/messages` per folder plus `/api/mail/starred`**, each a separate IMAP login. Total for one inbox load: roughly N+4 logins and about 2N STATUS commands.
4. **Draft autosave every 2 s with no dirty check.**
   - `useCompose.ts:86-94` uses `setInterval(..., 2000)` and calls `saveDraftToServerQuiet()` whenever there is any content, changed or not.
   - Each save runs `appendDraft` (`imap.ts:673-697`: connect, LIST, SELECT, delete the old draft, APPEND), then `fetchFolders(true)` (connect, LIST, N STATUS), plus `fetchMessages(Drafts)` when Drafts is open (`useCompose.ts:141-149`).
   - Net cost is about 2–3 IMAP sessions and N STATUS every 2 s while the user types.
5. **Message open downloads and parses the full raw message.** `imap.ts:356-367` fetches `source: true` and runs `simpleParser`. mailparser's simple parser turns every `cid:` part into a base64 `data:` URI (`node_modules/mailparser/lib/simple-parser.js:99`), so inline images inflate the JSON by about 33%. That payload is cached in Redis (`messages/[uid].get.ts:62`) despite the comment in `cache.ts:1` saying content is not cached.
6. **Attachment download re-fetches and re-parses the whole message** for each attachment (`imap.ts:416-427`). There is no BODYSTRUCTURE part fetch and no streaming; the whole buffer is held in memory.
7. **Move/delete actions run a full folder scan first.** `archive.post.ts:24`, `junk.post.ts:24` and `messages/[uid].delete.ts:24` call `listFolders()` (LIST + N STATUS) only to find a special-use folder, then open a second IMAP session for the move (`imap.ts:707-719`). `appendToSent` / `appendDraft` LIST every time (`imap.ts:678,731`).
8. **Detail page waterfall.**
   - `app/pages/inbox/[id].vue:63-95` runs `fetchMessage` (session #1), then `toggleRead` (session #2, `:93`).
   - With a Message-ID URL and a cold list cache, the server first runs `findUidByMessageId`: up to two `SEARCH HEADER Message-ID` commands, which are unindexed on many servers (`imap.ts:456-467`), as its own session. That makes three or more serial logins.
9. **List fetch over-fetches and is unstable.**
   - `imap.ts:229-236` requests `bodyStructure`, `headers:['date']` and 256 bytes of `source` per message, then throws them away (`preview: ''` at `:246`).
   - Pages are computed from sequence numbers (`:223-225`), so they shift as mail arrives.
   - `imap.ts:216` sends STATUS on the already-selected mailbox; `client.mailbox.exists` already has that count.
10. **Search is uncached server-side full-body search.** `imap.ts:288` maps free text to IMAP `BODY` (a full scan on servers without FTS), and only INBOX is searched for starred (`starred.get.ts:23`). Contacts scan 200 envelopes each from Sent and INBOX (`imap.ts:556-559`).
11. **Polling instead of push.** IDLE was never implemented (`docs/plan.md:165` is unchecked). New-mail detection compares the INBOX unseen count, so it misses mail that arrives already read and fires on unrelated flag changes.
12. **SSR adds cost and no data.** Every mail page fetches in `onMounted` (`inbox/index.vue:11-12`, `folders/[name].vue:21-22`, `[id].vue:63`), so SSR renders an empty shell. Module-level `ref`s (`useMail.ts:40-58`, `useAuth.ts:14-17`) are shared across SSR requests (a cross-request state hazard). `DOMPurify.addHook` runs in `<script setup>` on every mount (`[id].vue:381`), so hooks pile up.
13. **Minor:**
    - Each handler makes 2–3 serial Redis round trips for session and password, plus 3 serial ones in `setMailCache` (`cache.ts:8-13`).
    - The list has 50 rows per page with no virtualization (`inbox/index.vue:226`). That is fine at 50 rows but blocks larger pages.
    - Flag updates send separate STORE commands for add and remove (`imap.ts:491-496`).

## Reusable (with file refs and how to reuse)

| Item | Where | Reuse | Notes |
|---|---|---|---|
| Envelope address normalisation (missing mailbox/host, email in name, `Name <addr>` in name) | `server/utils/imap.ts:57-99` | **Adapt** (import tool: logging/dedupe only) | JMAP returns parsed addresses, so the webmail doesn't need it. |
| IMAP credential check | `imap.ts:151-176` | **Adapt** for the import tool's "test source account" step | Add timeouts, map error codes, never echo raw server errors to the UI. |
| Special-use → role mapping | `imap.ts:593,679,732`; `archive.post.ts:25-27`; `junk.post.ts:25-27`; `[uid].delete.ts:25` | **Adapt** into the import folder map | `INBOX`→inbox, `\Sent`→sent, `\Drafts`→drafts, `\Trash`→trash, `\Junk`→junk, `\Archive`/`\All`→archive. Name fallbacks ("Sent", "Drafts") are needed for servers without SPECIAL-USE. |
| UID-set batching for STORE | `imap.ts:505-532` | **Reference** | The pattern is `uids.join(',')` with `{uid:true}`. For import, use compact ranges (`1:500`) and fetch by UID windows. |
| Batch flag endpoint and optimistic UI with revert | `useMail.ts:408-555`, `batch-flags.put.ts` | **Port concept** | In JMAP: one `Email/set` with `keywords/$seen` patches. |
| Stale-while-revalidate list cache keyed by folder:page | `useMail.ts:242-311` | **Port concept** | Replace TTLs with JMAP `state` plus `Email/queryChanges` / `Email/changes`. |
| Email iframe skeleton: `srcdoc` + sandbox + `<base target=_blank>` + ResizeObserver auto-height + forced light background | `app/pages/inbox/[id].vue:381-447,726-732` | **Reference, harden before use** | See the safety assessment below. |
| Inline image → CID on send | `server/utils/smtp.ts:27-49` | **Reference** | For JMAP: upload a blob, add an inline part with `cid` to `bodyStructure`. The regex only matches `src="data:..."` in double quotes. |
| Paste handling: cid images → data URL, entity escaping for plain text | `app/components/ComposeEditor.vue:80-106` | **Reference** | The editor itself is `document.execCommand`; use a maintained editor (TipTap/Lexical). |
| Outbox queue with queued/sending/sent/failed states | `app/composables/useOutbox.ts` | **Port concept** | Enables undo-send. JMAP `EmailSubmission` with `sendAt`/FUTURERELEASE (if Stalwart supports it) can back it server-side. |
| Notification tones via Web Audio, no assets | `useNotifications.ts:13-33,70-83` | **Port** (small, self-contained) | Keep the MIT notice if copied verbatim. |
| Multi-account switcher UX | `session.ts:165-236`, `mail.vue` account menu | **Port concept** | Implementation is discarded (it stores passwords). |
| Mobile drawer and sidebar layout, recent searches, search filter fields (from/to/subject/since/before/size) | `app/layouts/mail.vue:29-54,179-186,264-275,664-690` | **Port concept** | Map the filters to a JMAP `Email/query` `FilterCondition`. |
| vCard/CSV contact parse and generate | `server/utils/vcard.ts` (84 lines) | **Reference only** | Naive: no line unfolding edge cases, quoted CSV or vCard 4 params. Use a real library for contact import into Stalwart (JMAP Contacts/CardDAV). |
| Signature model (name, HTML, default) | `prisma/schema.prisma` `Signature` | **Discard storage, keep UX** | JMAP `Identity.htmlSignature` holds it server-side. |
| Login rate limit pattern | `login.post.ts:16-23` | **Reference** | Add per-IP limits. Stalwart has its own auth throttling. |

**Email HTML rendering: safety assessment**
- Sanitiser: DOMPurify 3.3.1 in the browser (`[id].vue:394-398`), using the default profile plus `FORBID_TAGS` (script, iframe, object, embed, form, input, textarea, button) and a short `FORBID_ATTR` list. `<style>` is allowed and `ALLOW_DATA_ATTR` is false. A global hook forces `target=_blank rel=noopener noreferrer` on links (`:381-386`). Reasonable baseline.
- iframe: `sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"` (`:729`). Scripts are off (good). `allow-same-origin` is needed only because the parent reads `contentDocument` to size the frame. That is safe only while `allow-scripts` stays absent and the sanitiser holds.
- **Missing:**
  - No remote-content blocking: `<img>`, CSS `url()`, `background` and `@import` in `<style>` all load, so tracking pixels and IP leaks get through.
  - No CSP inside `srcdoc`.
  - No image proxy and no per-sender "load images" consent.
  - No `<style>` scoping (styles stay inside the iframe, which is fine).
  - Inline images are `data:` URIs from mailparser rather than blob URLs.
- **Unsafe paths that bypass the iframe (stored XSS from received mail):**
  - `handlePrint` (`[id].vue:321-358`) `document.write`s raw `msg.html` and the unescaped subject and addresses into a same-origin `about:blank` window, so scripts and handlers run in the app origin.
  - `openForward` (`[id].vue:218-233`) puts raw `msg.html` into the compose body, which `ComposeEditor.vue:297,303` assigns via `innerHTML` in the main document (an `<img onerror>` executes).
  - `attachment.get.ts:30-36` serves attachments `inline` on the app origin with the attacker-supplied `Content-Type`. An `text/html` or `image/svg+xml` attachment opened in "view" mode executes as the app.
  - `v-html="reply.html"` (`[id].vue:761`) renders the user's own composed HTML; this is lower risk.
- **MIME parsing:** mailparser `simpleParser` over the full source, kept in memory. Fine for an importer that only needs headers (better: don't parse at all and pass raw RFC 822 bytes to Stalwart). Not needed for the webmail, because JMAP returns `bodyStructure`, `bodyValues`, `textBody`/`htmlBody` and attachments as blobs.

**ImapFlow code for the import tool:** only the primitives are usable: client construction (`imap.ts:137-149`), `list()` with `specialUse`, `getMailboxLock`, `fetch(range, {uid, flags, envelope})`, `fetchOne(..., {source:true}, {uid:true})` and `append`. Missing entirely: UIDVALIDITY/UIDNEXT tracking, checkpointing, resume, streaming of large messages, back-pressure, concurrency limits, retry/backoff, Gmail labels, folder hierarchy/delimiter handling, and INTERNALDATE preservation.

**Licence:** MIT (`LICENSE` at HEAD, "Copyright (c) 2026 HourMail (Anhourtec)"). Porting ideas or rewriting from reference has no obligations. Copying code verbatim requires keeping the copyright and permission notice (in the file header or a `THIRD_PARTY_NOTICES`). Both projects appear to belong to the same owner (Anhourtec), so relicensing is possible if the copyright holder agrees. Record the provenance anyway.

## Discard

- **The whole per-request IMAP BFF** (`server/utils/imap.ts`, `server/api/mail/*`). It is architecturally the cause of the latency and is replaced by JMAP to Stalwart.
- **The password-in-Redis session model** (`login.post.ts:57-73`, `session.ts`): reversible credentials for 24 h, a hard-coded fallback key (`session.ts:21`), and a base64 "decrypt" fallback (`session.ts:41-45`).
- **Organization and registration multi-tenancy** (`server/api/org/*`, `Organization` model). Stalwart owns domains. Specific problems:
  - `org/[domain].put.ts` has **no authentication** and rewrites IMAP/SMTP hosts, so the next logins send passwords to an attacker.
  - `register.post.ts` has no authentication, and `testConnection` (`imap.ts:101-135`) gives an open host:port probe (SSRF).
- **Hand-built draft MIME** (`draft.post.ts:28-47`): CRLF header injection through `to`/`cc`/`subject`, no multipart, and non-ASCII subjects are not encoded. Replaced by JMAP `Email/set` drafts.
- **The UserSettings `pollInterval`, polling in `useNotifications.ts`, and the 2 s draft autosave timer.** Replaced by JMAP push (EventSource/WebSocket) and a debounced, change-driven save.
- **Message-ID URL routing and `findUidByMessageId`** (`messageId.ts`, `[uid].get.ts:22-43`). JMAP `Email.id` is stable. Separately, the client `btoa` throws on non-Latin-1 IDs (`app/utils/messageId.ts:8`).
- **Redis TTL caches** (`cache.ts`, handler caches), **sessionStorage caches** and module-level singleton state (unsafe under SSR).
- **The execCommand editor** (`ComposeEditor.vue`), the print and forward implementations, and inline attachment serving.
- **Infra details:** the `prisma db push` on container start, and the published Postgres and Redis ports in `docker-compose.yml`.
- **The marketing/landing pages** (`app/pages/home|features|support.vue`, `components/landing/*`). They are unrelated to webmail; keep the copy only if wanted for the site.

## Recommendations for AnhourMail webmail & import tool

**Webmail (Next.js 16 / React 19, JMAP through a same-origin proxy)**
1. **One JMAP request per view, using back-references.**
   - List view: `Mailbox/get` (server-maintained `totalEmails`/`unreadEmails`, no STATUS) plus `Email/query` (filter `inMailbox`, sort `receivedAt` desc, `collapseThreads`, `position`/`anchor`, `limit` 50–100, `calculateTotal` only when needed) plus `Email/get` with `#ids` and only list properties: `id, threadId, mailboxIds, keywords, from, subject, receivedAt, preview, hasAttachment, size`.
   - Detail view: `Email/get` with `fetchHTMLBodyValues`, `maxBodyValueBytes`, `bodyStructure`, attachments as `blobId`.
2. **Sync, don't refetch.** Keep the `state` strings and use `Email/changes`, `Email/queryChanges` and `Mailbox/changes`. Push through the JMAP EventSource (RFC 8620 §7.3) or WebSocket (RFC 8887), proxied same-origin. No polling.
3. **Proxy.**
   - Keep a keep-alive HTTP agent (undici pool) to Stalwart.
   - The session cookie maps to a server-held OAuth/OIDC token (Stalwart supports OAuth), never a stored password.
   - Enforce Origin checks and CSRF protection on mutating requests, and stream blob downloads and uploads.
4. **Rendering.**
   - Sanitize with DOMPurify, then render in an iframe with `sandbox="allow-popups allow-popups-to-escape-sandbox"` and a CSP `<meta>` in `srcdoc` (`default-src 'none'; style-src 'unsafe-inline'; img-src blob: data: <image-proxy>; font-src <image-proxy>`).
   - Remote images are blocked by default and loaded through an image proxy only after per-message or per-sender consent. Rewrite `cid:` to authenticated blob URLs instead of data URIs.
   - Only add `allow-same-origin` if auto-height can't be solved another way, and never alongside `allow-scripts`.
   - Print from the sandboxed frame. Quote replies and forwards from **sanitized** HTML.
5. **Attachments.** Serve with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. Any inline preview must come from a separate cookieless origin.
6. **UI.** Virtualized list (TanStack Virtual) with anchor-based infinite scroll. Optimistic `Email/set` keyword and mailbox patches with rollback. A client store keyed by JMAP id and state (TanStack Query or a normalized store). Mail views are client-rendered behind an authenticated shell, with no per-request SSR data fetching and no module-level server state.
7. **Search.** Use `Email/query` filters backed by Stalwart's FTS index. Map the legacy filter fields: `text`, `from`, `to`, `subject`, `after`/`before`, `minSize`/`maxSize`, `hasKeyword: $flagged` (across all mailboxes, not INBOX only).
8. **Compose.** Use a maintained editor. Save drafts via `Email/set` with a debounce of about 1–2 s after the last change and only when content is dirty. Send with `EmailSubmission/set` plus `onSuccessUpdateEmail` to move the message to Sent. Signatures come from `Identity`.

**IMAP → Stalwart import tool (ImapFlow 1.2.x)**
1. **Setup.** Use one long-lived ImapFlow connection per source account (at most 2–3 with care) and respect the source server's connection limits. Verify credentials with a short timeout (adapt `imap.ts:151-176`).
2. **Folder map.** `LIST` with special-use and STATUS (`messages, uidNext, uidValidity`) once per folder. Map special-use and name fallbacks to JMAP roles, otherwise create mailboxes preserving hierarchy (split on the server delimiter) via `Mailbox/set`. Let the user review the map before import. Skip `\Noselect`. For Gmail, import `[Gmail]/All Mail` once and use `X-GM-LABELS` for multiple `mailboxIds` to avoid duplicates.
3. **Batching.** `UID FETCH <lastUid+1>:<lastUid+W> (UID FLAGS INTERNALDATE RFC822.SIZE)` in windows of about 500. Then stream each message's `source` with a size cap and a separate path for very large messages. Upload the raw bytes to the JMAP upload endpoint, then `Email/import` in batches of about 50 with `mailboxIds`, `keywords` and `receivedAt = INTERNALDATE`.
4. **Flags.** Map `\Seen`→`$seen`, `\Flagged`→`$flagged`, `\Answered`→`$answered`, `\Draft`→`$draft`, `$Forwarded`→`$forwarded`, and keep `$Junk`/`$NotJunk`. Skip `\Deleted` messages. Keep other custom keywords if they are valid JMAP keywords.
5. **Resumability.** Persist per folder `{uidValidity, lastImportedUid, count, errors}` after each committed batch. If UIDVALIDITY changes, rescan that folder and dedupe on Message-ID plus size plus date hash (or a stored source hash). Make the job idempotent: record the `Email/import` result id per source UID.
6. **Robustness.**
   - Exponential backoff on `NO`/`BYE`/throttling, with reconnect-and-resume.
   - Per-message failure isolation with an error report.
   - A progress API (messages/bytes per folder) for the UI.
   - Source credentials are encrypted at rest only for the life of the job and deleted afterwards.
7. **Alternative.** Evaluate Stalwart's own CLI import (mbox/Maildir) for admin bulk migrations. Use the ImapFlow tool for self-service per-user imports from remote IMAP.
