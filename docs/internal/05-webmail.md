# 05 — Webmail

Last updated: 2026-10-30 (mailboxes shared with you: the delegation BFF, ADR-0026; profile photos; remote images: the image proxy, "Load images", per-sender and Reading settings; reading: conversations, message menu, Show original page, restore; auto refresh, chime and
notifications; quoted replies; compose image placeholders; first-sign-in password step; sign-in links not pre-filled).

**Status (2026-10-22): slice 1 is built** — webmail sign-in (OAuth code flow + PKCE, tokens sealed server-side), the
JMAP proxy (allow-list, per-user queue ≤ 4, `limit` retry), folders with counts and nesting, the thread-collapsed
windowed list, the reader (server-sanitised HTML in a sandboxed `srcdoc` frame, remote images blocked, attachments as
downloads), read/unread/flag, basic shortcuts, and the control-plane mailbox gate. Next slices: push (SSE fan-out),
IndexedDB cache and `*/changes` sync, the image proxy (built 2026-10-29, "Remote images" below), composer,
move/archive/delete, search. Until push lands the client refreshes on tab focus and every 5 minutes (superseded
2026-10-23: a 30 s `Email/changes` check, see "Push"). Details:
`01-architecture.md` "How the webmail gets a Stalwart session". Research: `research/legacy-audit.md`, `research/ui-references.md`, `research/stalwart.md` §5.

## Why HourMail was slow, and what we do instead

HourMail opened a new IMAP connection and logged in on every API call, ran one STATUS per folder serially, re-polled every 30 s, preloaded every folder, autosaved drafts every 2 s with 2–3 IMAP sessions each, and downloaded and re-parsed whole raw messages for each view and attachment (`research/legacy-audit.md`, with file references).

AnhourMail: **browser → same-origin BFF (`mail.anhourmail.com`) → Stalwart JMAP.** There is no IMAP in the browser path. We sync incrementally, push changes, cache locally and fetch only what is on screen.

**Status (2026-10-22): slice 2 is built** — compose / reply / reply all / forward (plain text, quoting, address
suggestions, From = own identities, attachments up to the shared caps, autosaved drafts), **undo send held on the
server** (FUTURERELEASE `HOLDFOR` 6 s, cancelled with `undoStatus: canceled`, verified on v0.16.27), archive /
delete / junk / move with undo toasts, delete forever and empty Trash/Junk (with confirmation), Priority (flagged
everywhere) and pinned conversations (`$pinned` keyword, verified), multi-select with shift ranges, search
(`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:flagged`) and filters, several mailboxes per webmail
session ("Add another mailbox", switcher tiles), previous/next, the inline reply box, relative times, a collapsible
sidebar, and a bottom action bar on phones.

**Since then (2026-10-23 … 2026-10-28):** rich-text compose with a plain-text option and Insert HTML (below);
whole conversations in the reader, a complete per-message menu, a Show original page and Restore from Trash; an
automatic change check with an optional chime and desktop notifications; quoted replies kept as quotes; remote-image
placeholders while writing; a floating **New email** button on phones and tablets; the first-sign-in password step;
and the access states at sign-in ("Who may use the webmail").

### Reading (slice 2 viewer)

- **Whole conversations (2026-10-23).** The reader shows the subject with folder chips (Inbox's chip has an ✕ that
  archives) and every message of the thread oldest first (`components/webmail/reader.tsx` `Reader`). The newest
  message that isn't a draft and every unread one open expanded (`defaultExpanded` in `conversation.ts`); the rest
  are one-line rows, and bodies load only when a message is expanded. **Expand all / Collapse all** sits in the
  toolbar and the ⋮ menu for threads of more than one message. Each message's recipients line opens its details
  (from, to, cc, date, and **mailed-by** / **signed-by** read only from our own server's Authentication-Results,
  trusted by authserv-id; 07-security.md).
- **Per-message menu** (`messageMenu` in `reader.tsx`, conventional order): Reply, Reply all, Forward · Delete (Delete
  forever in Trash/Junk), Mark unread from here (`fromHere`) · Block "address" (adds it to the managed junk rules'
  blocked list and moves the thread to Junk), Report spam / Not spam, Report phishing (to Junk with `$junk` and
  `$phishing`) · Print, Download message (`.eml` via `/raw?download=1`), Show original. The toolbar's ⋮ adds Restore
  (in Trash), Mark as read/unread, Add to/Remove from Priority, Expand/Collapse all and Move to.
- **Restore from Trash.** The primary move button is Archive normally, Restore in Trash and Not spam in Junk. Restore
  sends each message back by its sender — our own identities to Sent, everything else to the Inbox
  (`restoreTarget`; JMAP doesn't record the folder a message was deleted from) — with an Undo toast that puts the
  previous `mailboxIds` back.
- **One surface.** The reader is a single scrolling pane: subject and date, sender card (To/Cc), attachments, then
  the body, with the reply box pinned at the bottom. No message markup ever enters the page's DOM:
  - **text/plain** → `body.ts` `textBlocks`: format=flowed decoded (RFC 3676, from the part's `header:Content-Type`),
    line breaks kept, quoted replies (`>` runs with their "On … wrote:" line) collapsed behind a "…" toggle, the
    signature after `-- ` dimmed. URLs and addresses are linked by the client from plain text (bounded patterns).
  - **text/markdown** → `markdownBlocks`: a small AST (headings, lists, quotes, code, emphasis, links limited to
    http/https/mailto); raw HTML and images become text. Rendered by React.
  - **text/calendar** (invitations) → `calendarEvents`: event cards (title, time, place, organiser). Answering
    invitations comes later.
  - **message/rfc822** (forwarded or attached messages) → opened from their chip with `Email/parse` (the blob must be
    an rfc822 attachment of that message) and shown through the same sanitiser.
  - **Image attachments** (raster only) preview as thumbnails and in a viewer through `/api/webmail/preview/:blobId`,
    served only as that image type with `nosniff` and a sandboxing CSP. SVG, HTML and everything else only download.
    **PDF preview is not offered yet:** the browser's PDF viewer can't run in a sandbox and a same-origin PDF page is
    a risk we don't take; production needs a separate attachment origin first (open item).
  - Charsets: Stalwart returns decoded `bodyValues` (verified with ISO-8859-1). Bodies over 1 MB are cut with
    "View entire message" (`?full=1`, up to 8 MB).
  - **Show original** (2026-10-23) opens `/message/:emailId/original` in a new tab
    (`app/webmail/message/[emailId]/original/page.tsx`): a server page that checks the session, the access gate
    and the first-sign-in gate, rate-limits on `webmailDownload`, and reads the source with the session's token for
    the active mailbox only (any other id is a 404). It shows Message ID, Created at (with "Delivered after …" from
    Date vs receivedAt), From, To, Cc, Subject and SPF / DKIM / DMARC (`server/webmail/original.ts`: only the
    Authentication-Results our own authserv-ids added are trusted, `MAIL_AUTHSERV_ID` or the MX hosts), then the
    source as text (first 2 MB) with **Download original** (`/api/webmail/messages/:id/raw?download=1`, `.eml`) and
    **Copy to clipboard**. The source is never rendered as HTML. `/raw` without `download` still serves text/plain
    with nosniff and a sandbox CSP. **Print** (`/messages/:id/print`: escaped headers + the sanitised body, served with `sandbox` CSP — an opaque
    origin with no scripts — opened in a new tab for the browser's print command).
- **text/html** stays in the sandboxed `srcdoc` frame (no `allow-scripts`, no `allow-same-origin` — unchanged).
  Quoted replies inside it (the quote containers and reply header blocks common mail apps add, `blockquote type=cite`) become
  `<details>` toggles (no script needed) and signatures are dimmed. The frame has no card or border of its own.
- **HTML frame height — open maintainer decision.** A script-less, cross-origin frame can't report its content
  height and the parent can't read it, so the frame is sized to the reading pane: the header scrolls away and the
  message then fills the pane, scrolling inside (the reply box stays pinned). True auto-height would need
  `allow-same-origin` on the script-less frame (the parent could then read `scrollHeight`), or an inert twin of the
  message in the page's DOM to measure — both change the isolation model, so neither is done without a decision.
- **Webmail API CSP:** every `/api/webmail/*` response carries a CSP (`route()` adds `default-src 'none';
frame-ancestors 'none'` unless the route sets its own sandboxing one). `next.config.mjs` sets no CSP at all, because
  a config header of the same name replaced the routes' own CSPs; `src/proxy.ts` sets each page's one policy.

### Compose and send (slice 2)

- **The proxy never creates or sends mail.** Drafts go through `PUT /api/webmail/drafts`: the BFF validates the input
  (`compose.ts`: addresses, header-safe subject and names, Message-IDs, ≤ recipients per message, attachments per
  file and per message from `WEBMAIL_ATTACHMENTS`), checks the From identity is one of the mailbox's own
  (`Identity/get`, cached a minute), and builds the Email itself (in Drafts, `$draft`, plain text or text + sanitised
  HTML, see "Rich text and HTML" below). Replacing a
  draft checks the old one is a draft in Drafts.
- **Send** (`POST /api/webmail/send`, `sending` tier fail-closed per webmail session and again per mailbox) re-reads
  the draft and checks: in Drafts with `$draft`, exactly one From equal to the chosen identity, 1..max recipients,
  size ≤ 30 MB. It submits with an explicit envelope (MAIL FROM = the identity; RCPT TO = To + Cc + Bcc) held for
  `UNDO_SECONDS`, moving the message to Sent on success. Stalwart's sender rules (ADR-0019) also apply.
- **Trust tiers (rule 27, security review run-15):** the tier comes from one helper, `sendingTier()` — `new` for
  every mailbox until tiers are stored per account; `restricted` refuses sending. Sending is charged per rolling
  hour and day, one unit per recipient (03-anti-spam-and-abuse.md), in sliding windows per mailbox and per webmail
  session, atomically and failing closed (`SlidingQuotaStore`). The whole send runs against one mailbox: every
  server-built call refuses if the active mailbox changes meanwhile.
- **Only BFF drafts can be sent.** Drafts the BFF builds carry the `$am-composed` keyword; the proxy refuses setting
  `$draft`, adding to Drafts, or touching that keyword, and `send` and draft replacement require it, so no message
  can be promoted into a sendable draft through the proxy.
- **Session record writes are compare-and-set** (a version prefix checked by a Lua script), so a token refresh
  finishing late can't undo a mailbox switch or an added mailbox.
- **Uploads:** at most 4 in flight per process (each holds up to 20 MB once; the body isn't streamed because the
  upstream request may be retried).
- **Undo** (`POST /api/webmail/send/undo`) cancels the held submission and moves the message back to Drafts; once it
  is released Stalwart refuses the cancel and the person sees "It has already been sent".
- **Uploads** (`POST /api/webmail/upload`) are capped while reading the body; the content type is reduced to a plain
  MIME token pair.
- **Rich text and HTML (2026-10-24; one composer 2026-10-29).** The composer always starts in rich text with the
  formatting toolbar showing; there is no format switch in the footer. Plain text is a mode in the footer's
  "More options" (⋯) menu: "Plain text mode" (asks first when the body has formatting, `hasFormatting` — any element
  besides `div`/`p`/`br`, or a styled or aligned line), and in plain mode "Switch to rich text". Reopening a
  plain-text draft still opens in plain text. The editor is a contentEditable area with the toolbar in
  `components/webmail/format-toolbar.tsx` (choices in `format-options.ts`): undo, redo, font (sans-serif, serif,
  monospace — generic families, nothing downloaded), text size (small, normal, large, huge → the editing command's
  2/3/5/6, written as `font-size` keywords), bold, italic, underline, strikethrough, text colour and highlight (fixed
  palettes of `#rrggbb` values — mail content, not theme tokens; the picker UI itself uses tokens), alignment
  (left, centre, right), bulleted and numbered lists, decrease/increase indent, link (`linkUrl` validation,
  ⌘/Ctrl+K), quote, clear formatting and Insert HTML. Every change is a browser editing command, so the editor's own
  undo history covers it; colour, font, size, alignment, strikethrough and indent run with `styleWithCSS` on (inline
  CSS), bold/italic/underline and lists keep semantic tags. Indent is the browser's borderless
  `blockquote style="margin: 0 0 0 40px; border: none; padding: 0px"`; the editor shows it without the quote style and
  the text part doesn't quote it. At 390 px the toolbar row scrolls sideways; its menus open in a fixed layer inside
  the composer (outside the scrolling row) so they are never clipped, and Escape closes only the menu. One
  allow-list sanitiser, `server/webmail/outgoing-html.ts`
  (`sanitizeOutgoingHtml`, isomorphic, sanitize-html engine like the reader's, lazy-loaded in the browser), runs on
  every paste and drop, on "Insert HTML" (pasted source or an `.html` file ≤ `WEBMAIL_HTML.maxMb`, previewed with the
  reader's frame document in an iframe with `sandbox=""`, listing what was removed and warning about remote images)
  and on the whole body before each save; `PUT /api/webmail/drafts` sanitises `html` again (`draftBody` in
  `compose.ts`) and stores `textBody` + `htmlBody` (multipart/alternative), generating the text part from the HTML
  when the person wrote none. Rules and their reasons: 07-security.md "Outgoing HTML". Replies and forwards quote the
  reading view's sanitised HTML (no remote images; ≤ 256 KB, else the text). **Quotes stay quotes (2026-10-28):**
  a rich reply's quote is a `blockquote type=cite` (the outgoing sanitiser keeps `type=cite` and turns the reading
  view's folded `<details>` quote back into one), so readers fold it, and the generated text part prefixes quoted
  lines with `> ` per level, capped at eight levels so a crafted draft can't make the text part quadratic.
  **Remote images while writing** (`components/webmail/remote-images.ts`): images on other servers in pasted or
  inserted HTML are "parked" for display (address moved to `data-am-src`, a sized blank placeholder shown; remote
  CSS backgrounds kept in `data-am-style`) and put back before sanitising and saving, so nothing loads them while
  writing or previewing and they are sent as written; the outgoing sanitiser drops every `data-*`. Switching a
  formatted message to plain text asks first. Drafts reopen in the format they were
  written in, formatting included. **Text part (2026-10-29):** each editor line (`div`) is one line, not a paragraph;
  numbered lists are numbered and nested list items indented two spaces per level (capped like quotes). Known limits: a reopened rich draft loses its https images (the reading view blocks them); Quote has no
  toggle-off (undo works).
- **Proxy allow-list changes:** `Email/set` may now update `keywords/*` and `mailboxIds` (moves) and `destroy`, and
  the service checks every destroyed message is only in Trash or Junk before forwarding. No `create`, no
  `EmailSubmission/*`, no `Mailbox/set`, no other properties (tests in `webmail.test.ts` cover each refusal).
- **Several mailboxes:** the session record holds the active mailbox's tokens plus up to four others, all sealed
  together; switching checks the target with the mailbox access gate. A blocked active mailbox still ends the whole
  session (conservative).

### Contacts (slice 3)

- **Stored in Stalwart, never by us.** Contacts are JSContact cards in the mailbox's own address books (JMAP
  Contacts, RFC 9610; verified shapes and limits in `research/stalwart.md` "JMAP Contacts"), so they also sync to
  phones and desktop apps over CardDAV. Nothing about them reaches Postgres, logs or audit (rule 24).
- **Books:** the account's default book is shown as **My contacts**; **Other contacts** is a book the BFF creates
  when first needed. A card is moved between them with an `addressBookIds` update.
- **Dedicated endpoints, not the proxy.** The generic JMAP proxy refuses the contacts capability and every
  `AddressBook/*` and `ContactCard/*` method (tests in `webmail.test.ts`). The browser sends a small validated
  `ContactInput` (`contacts.ts`: names, ≤ 10 addresses and phones, organisation, notes ≤ 4,000 chars, birthday,
  ≤ 10 labels; control characters stripped) and the BFF builds the card; edits replace only the fields we manage.
  Every call is pinned to the session's account.

  | Route                                    | What                                                                            | Tier              |
  | ---------------------------------------- | ------------------------------------------------------------------------------- | ----------------- |
  | `GET /api/webmail/contacts`              | account, books, contacts (≤ 5,000, read in 500-card batches), auto-save setting | `webmailContacts` |
  | `POST /api/webmail/contacts`             | create in My contacts or Other contacts                                         | `write`           |
  | `DELETE /api/webmail/contacts`           | delete ≤ 500 ids (the app confirms first)                                       | `write`           |
  | `PATCH /api/webmail/contacts/:contactId` | edit                                                                            | `write`           |
  | `POST /api/webmail/contacts/move`        | move ≤ 500 ids to My contacts or Other contacts                                 | `write`           |
  | `PUT /api/webmail/contacts/settings`     | "Automatically save people I email"                                             | `write`           |
  | `POST /api/webmail/contacts/import`      | .vcf import, ≤ 1 MB and ≤ 1,000 cards, parsed by the BFF                        | `webmailUpload`   |
  | `GET /api/webmail/contacts/export`       | .vcf download (all or `?ids=`), `sandbox` CSP, attachment                       | `webmailDownload` |

- **vCard import** (`parseVcards`): vCard 3.0/4.0, unfolded; only FN, N, EMAIL, TEL, ORG, NOTE, BDAY and
  CATEGORIES are read. PHOTO, URLs and everything else are ignored, so an import never fetches anything. Each card
  goes through `ContactInput`; invalid or empty cards are skipped and counted. Linear-time parsing (no
  backtracking regexes over whole lines). **Export** (`toVcards`) escapes every value.
- **Auto-save after the send is released** (server-side): `send` schedules a check for `UNDO_SECONDS` + 2 s later
  (an unref'd in-process timer, so the send response never waits). The check reads the submission's `undoStatus`:
  `canceled` (undone) saves nobody, `pending` checks again every 5 s (three times at most), anything else saves every
  To/Cc/Bcc recipient whose address isn't on any card (matched case-insensitively against the cards' own `emails`,
  because the `email` query filter lags fresh writes) to Other contacts with the name the message used. Existing
  cards are never changed; at most 100 recipients per send. Best effort: a restart inside those seconds skips it;
  errors are logged by kind only, never with addresses. It always acts on **the account that sent** (captured at
  send time): if the person switched mailbox during the hold, it uses that mailbox's own tokens from the session
  (`#callOther`; refreshed in memory if due, the session record isn't rewritten) instead of refusing; if that mailbox
  was signed out of the session meanwhile, it skips (review run-22).
- **5,000 contacts per mailbox**, enforced by the BFF (create, import and auto-save count the cards first; Stalwart
  accepts a `maxContactCards` quota but didn't enforce it, `research/stalwart.md`). Below the cap the "already saved"
  check reads every card, so it is complete; the list says "Showing the first 5,000" if cards added over CardDAV
  push a mailbox past it.
- **Account pinning:** the list returns the `accountId`; every change sends it back in `X-Webmail-Account` and the
  BFF refuses (400) if it's missing, or if the session's active mailbox is another one (switched in another tab).
  The same pin applies to **drafts, send, undo send and uploads** (`PUT /drafts`, `POST /send`, `POST /send/undo`,
  `POST /upload`; review run-22): the client sends the account the tab shows (its JMAP session account), and the BFF
  refuses before acting, so a send or draft save from a tab showing mailbox A can never act on mailbox B after a
  switch in another tab (e2e `webmail-settings.spec.ts`, unit `compose.test.ts`).
- **Values from cards are cleaned** before they reach the app or a vCard (control characters removed, line breaks
  only in notes), and labels map through `Map`s, so a label such as `constructor` is just a label.
- **The setting** lives in Stalwart too: the Other contacts book's `description` says whether saving is on (default
  on when the book doesn't exist yet), so no per-mailbox preference is stored in our database.
- **Composer suggestions** merge every address on a card with recent correspondents (last 200 sent messages),
  most emailed first. "Add to contacts" appears on the reader's sender card and on composer address chips for
  addresses not yet on a card.
- **CardDAV for phones and desktop apps:** `CARDDAV` in `packages/shared` (the client host, `/dav/card/`), signed in
  with the mailbox address and an app password. Production needs the NGINX route (private ops repo).

### Settings (slice 4, part 1)

Opened from **Settings** in the sidebar footer or `,`; a large dialog on wide screens and full screen on phones
(groups, then one panel). `components/webmail/settings/*`, BFF `server/webmail/{settings,sieve}.ts`, control plane
`packages/core/src/webmail/settings-*.ts`.

**Structure (maintainer decision, 2026-10-22).** The brief listed capabilities by category (Account, General, Mail
with nine sub-sections, Calendar, People). We ship **eight flat groups** instead of two levels of tabs, because a
person looking for a setting thinks in tasks, not in a product's category tree: **Appearance**, **Reading**,
**Writing**, **Automatic replies**, **Forwarding**, **Junk and blocked senders**, **Account**, **Region and
shortcuts**. Calendar (nothing to configure yet) and People (contacts' only setting already sits in Contacts) are
not listed: an empty group doesn't earn its place. **Search settings** matches a group's label or any of its
keywords (`settings/sections.ts`), so "vacation", "spam" or "24-hour" still find the right group.

- **Instant, with live preview.** Display preferences apply on click (optimistic, saved in the background, rolled
  back with a message if saving fails); the app behind updates, and Appearance shows two made-up rows rendered with
  the real `MessageRow`. Only multi-field forms that change mail flow have a Save button (automatic replies,
  forwarding, junk lists, your name; signatures save from their own dialog). One primary button per panel.
- **Opinionated choices.** One **density** control (compact / comfortable / roomy) sets text size and spacing
  together; reading pane right (default) / bottom / off; preview off / 1 / 2 lines; motion follows the device or is
  reduced (an "always animate" option would override an accessibility setting, so it isn't offered).
- **Defaults** are the current behaviour, so most people never open settings: comfortable, right pane, 2 preview
  lines, grouped by conversation, mark read when opened, open the next message after a move, Reply, 10 s undo,
  English (Canada) dates, the device's time zone, shortcuts on, start in Inbox.
- **Remote images (2026-10-29):** Reading → Privacy offers **Remote images: Always ask / Load from contacts / Always
  load** (`remoteImages`, default ask) and **Senders whose images always load** with a count and **Forget all**
  (`imageSenders`: keyed hashes, so the list can't be shown as addresses). See "Remote images" below.
- **Not offered (no real behaviour yet), recorded rather than shown as placeholders:** read receipts — Stalwart v0.16.27 doesn't advertise JMAP MDN, and the webmail never sends them (stated);
  "basic formatted" messages — superseded: the composer writes rich text by default (2026-10-24); "empty Deleted after N days" — JMAP
  doesn't expose when a message was moved to Trash, so a correct per-person policy needs the worker-side
  `folder_policy` (phase 6); the server-wide 30-day clean-up applies meanwhile. "Empty Trash when I sign out" is
  offered: it is explicit and runs from the browser through the proxy's Trash-only delete.

**Where each setting lives.**

| Setting                                                                                                                 | Stored                                                                                                       | Changes behaviour in                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme, density, reading pane, preview, grouping, sender/subject first, initials, attachment names, date headers, motion | `webmail_preference.prefs` (control plane, per mailbox id; closed values, `@anhourmail/shared/webmail`)      | `webmail-app` (layout, theme via next-themes, `data-motion`), `message-list` (`rowHeight(look)`, date headers between windowed rows), `mail-client` (`collapseThreads`, `attachments` property) |
| Mark as read (open / after N s / never), after delete or archive, mark read when moving                                 | same                                                                                                         | `reader` (timer), `webmail-app` (`dropThreads`, `moveThreads` adds `$seen`)                                                                                                                     |
| Reply button, undo-send delay, always show Cc/Bcc                                                                       | same                                                                                                         | `reader`, `composer`; the delay is read **server-side** at send (`holdSeconds` dep → `HOLDFOR`, 1–60 s or the 6 s fallback), never trusted from the browser                                     |
| Region, time format, time zone, start in, shortcuts on/off, empty Trash on sign-out                                     | same                                                                                                         | `format.ts` `setDateStyle`, initial view, key handler, sign-out                                                                                                                                 |
| Sender name                                                                                                             | Stalwart JMAP `Identity.name`                                                                                | the From header                                                                                                                                                                                 |
| Signatures (named, several) and the two defaults                                                                        | `webmail_signature` (control plane, per mailbox); the default for new messages is copied to every `Identity` | composer (default per kind of message, Signature picker); other JMAP mail apps (identity copy, about 2 KB)                                                                                      |
| Automatic replies, forwarding on/off + keep a copy, blocked/safe senders, trusted-only                                  | Stalwart: one managed Sieve script per mailbox (`anhourmail`)                                                | delivery                                                                                                                                                                                        |
| Forwarding target + confirmation                                                                                        | `forwarding_target` (control plane)                                                                          | the BFF writes a redirect only to a confirmed target                                                                                                                                            |

**Customers can't change mail flow themselves (security reviews run-20/21, verified on v0.16.27, 2026-10-22).**
With a mailbox password a person could otherwise install a Sieve `redirect`/`enotify` over ManageSieve (port 4190)
or JMAP `SieveScript/set` — an open relay from our IPs with per-message targets, bypassing forwarding confirmation,
quotas and audit — or call `VacationResponse/set`, which activates Stalwart's own `vacation` script and switches ours
off. So every customer mailbox carries `CUSTOMER_PERMISSIONS` (`packages/stalwart-client/src/management.ts`):
`disabledPermissions` `sieveAuthenticate` (ManageSieve login), `jmapSieveScript{Create,Update,Destroy}` and
`jmapVacationResponse{Create,Update,Destroy}` (`jmapSieveScriptSet/Delete/Activate/Rename` and
`jmapVacationResponseSet` don't exist on the pinned server). The same list also turns off self-service credentials,
principal and DAV directory look-ups, and sharing (ADR-0020, `07-security.md` "App passwords"). Sign-in, sending, delivery, reading scripts and blob upload
(attachments) are untouched. `SUSPENDED_PERMISSIONS` is a superset, so resuming never briefly unlocks; new accounts
are created locked even when the caller doesn't pass `suspended` (dev seed, e2e fixtures).

- **Deactivation is closed too** (run-22): with `jmapSieveScriptDestroy` and `jmapVacationResponse{Create,Destroy}`
  also denied, a bare `SieveScript/set { onSuccessDeactivateScript: true }` answers `forbidden` for the user
  (verified). Before that it worked, and a user could deactivate then delete our script. `mailRules` still reports
  `inactive` if the script is switched off some other way (by hand, or an account not locked yet); every settings
  save re-activates it (the operations key; nothing is deleted), and the hourly reconciler reports it. Since the
  credential split (ADR-0020) `mailbox.ensure` no longer does: the worker's key has no owner access to a mailbox.
- **Drift and backfill:** `listUsers`/`listMailboxes` report `sieveLocked` (all customer denials present, or
  suspended); the hourly reconciler adds `sieveLockMismatch` for active mailboxes and re-queues `mailbox.ensure`, like
  suspension drift. Existing mailboxes are backfilled once at deploy: `npm run job:mailbox-backfill --workspace
@anhourmail/worker` queues `mailbox.ensure` for every active mailbox (audited `platform.mailboxes_requeued`;
  `deploy/README.md` "One-off deploy steps"). Run on dev 2026-10-22: 31 queued, all 31 control-plane mailboxes
  locked afterwards (the only unlocked accounts were leftover test accounts unknown to the control plane).
- **What a User-role token can still call over public JMAP** (probed): standard mail/contacts/submission objects on
  its own account and its own `x:AppPassword`; `x:Account/get|set`, `x:Domain/get`, `x:SieveSystemScript/set` are
  `forbidden` (research/stalwart.md).

The one managed script (`anhourmail`, `MANAGED_SIEVE_SCRIPT` in `@anhourmail/shared/webmail`) is read and **written
with management credentials** — the web app's operations key (`StalwartManagement.getSieveScript` →
`{content, active}` / `putSieveScript`; standard JMAP `SieveScript/*` + blob upload/download, `impersonate` addresses
another account; the reconciler reads with the scheduler's audit key),
never the user's token — behind `server/adapters/stalwart.ts` `managedSieve()` (rule 21), injected into the BFF as the
`ManagedSieve` port. There is no "include the person's previous script" behaviour (they can't have one).

**Sieve, not JMAP VacationResponse (verified on v0.16.27).** `VacationResponse/set` installs and activates its own
`vacation` script, and only one script can be active, so every other rule would stop. So automatic replies are part
of our managed script (`vacation`, `:days 3`, `:addresses` = the mailbox's identities, dates with
`currentdate :zone <offset>`). The script (`sieve.ts`) runs:

1. junk rules — safe senders (and, with trusted-only, contact addresses) skip; blocked addresses/domains →
   `fileinto :specialuse "\\Junk" "Junk"; stop;`; trusted-only → everything else to Junk;
2. `if not <suppress> { automatic reply (optionally contacts only); redirect / redirect :copy to the confirmed
target }` — replies and forwarding run **only for ordinary person-to-person mail**. `<suppress>` is any of:
   Stalwart's own `X-Spam-Status: Yes` (a forged `No` can't override — `:contains "Yes"` matches any copy), a
   `List-*` header, `Precedence: bulk/list/junk`, `Auto-Submitted` other than `no`, or an empty envelope sender
   (bounces). Verified end to end: a blocked / bulk / spam / list sender gets no reply and no forward, a clean
   sender gets both. This stops auto-reply and relay of spam and backscatter. "Contacts only" tests the **envelope
   sender** (`envelope :is "from"`), the validated MAIL FROM, not a forgeable header.

Blocked and junked mail is never answered or forwarded (the `stop` comes first). Settings are stored in the script
as a base64url JSON comment and validated on read, so the mail server stays the source of truth. **Injection:**
every value reaches the script only through `sieveString` (backslash and quote escaped, control characters
dropped); the script requires only `fileinto`, `special-use`, `mailbox`, `envelope`, and `vacation`/`date`/
`relational`/`copy` when used — never `variables`, `enotify`, `editheader`, `encoded-character` or `regex` — so
`${…}` is literal and there is no notify/redirect-by-variable; sender entries must be a plain address or domain.
Tests in `sieve.test.ts` strip every quoted string and check no command was introduced. Contacts for "contacts
only" rules are written into the script (≤ 1,000 addresses, within Stalwart's 100 KB `maxSizeScript`) and refreshed
after webmail contact changes (CardDAV changes at the next save).

**Forwarding is confirmed by the target.** `POST /api/webmail/settings/forwarding` refuses the mailbox's own
addresses (loops), a `restricted` sender (`sendingTier()`), and more than 5 confirmation emails per mailbox per
24 h (the counter is read `FOR UPDATE`; plus the fail-closed `forwardingVerify` tier); it stores only the token's
sha256 and emails a link (with the mailbox address **masked**) to `/forwarding/confirm/<token>` (72 h). Opening the
page changes nothing; its button posts the token (link scanners can't confirm) and the page shows the full mailbox
address. Only then can the owner turn forwarding on; asking for another address turns forwarding to the old one off
at once. Enabling forwarding or automatic replies is refused while the tier is `restricted`. Every writer reads the
session once and refuses on an `X-Webmail-Account` pin mismatch before any lookup. **`WebmailService.saveMailRules`
itself** keeps a redirect only when it equals the control-plane confirmed target (`confirmedForward` dep), so every
caller — the settings writers and the contacts refresh — goes through the same filter, and the script comment is
never trusted for it. The counter's first request inserts a placeholder row (`ON CONFLICT DO NOTHING`) and locks it,
so two first requests can't both pass the cap. Stalwart's `maxNumberRedirects` is 1.

**Open items (security reviews run-20/21):**

- Forwarded mail isn't charged to the webmail's per-mailbox send quota (`SlidingQuotaStore`); whether Stalwart's
  `MtaOutboundThrottle` counts redirects, and whether SRS / the hop limit need setting, is unverified — a
  per-mailbox forwarding cap may be wanted.
- Untrusted-Sieve interpreter hardening (disable unused capabilities, cap outgoing messages per run) is **lower
  priority now that no customer can write Sieve or VacationResponse**; the exact v0.16 setting-object names still need discovery from the
  running server before changing the dev plan and production settings (don't guess).
- When trust tiers become stored, a mailbox turning `restricted` should actively switch its forwarding and
  automatic replies off (today they're only refused at change time).

**API (webmail origin, `webmail` guard, account pinned with `X-Webmail-Account` on every change).**

| Route                                                  | What                                                                       | Tier                                   | Audit                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| `GET /api/webmail/settings`                            | preferences, identities, quota, rules + state, forwarding target           | `webmailSettings`                      | —                                                         |
| `POST /api/webmail/settings/password`                  | own mailbox password: current (proved to Stalwart) + new                   | `mailboxPassword`                      | `mailbox.password_changed` (no secret)                    |
| `PATCH /api/webmail/settings/preferences`              | display preferences (known keys and values only)                           | `write`                                | `webmail.preferences_changed` (key names)                 |
| `PATCH /api/webmail/settings/identities/:id`           | sender name of an own identity                                             | `write`                                | `identity.changed` (field names)                          |
| `GET · POST /api/webmail/settings/signatures`          | the signatures and defaults (first read brings the old one over) · add one | `webmailSettings` · `write`            | — · `webmail.signature_added` (id, size, image count)     |
| `PATCH · DELETE /api/webmail/settings/signatures/:id`  | rename / rewrite · delete (a default it was becomes none)                  | `write`                                | `webmail.signature_changed` · `webmail.signature_removed` |
| `PUT /api/webmail/settings/signatures/defaults`        | default for new messages, default for replies and forwards (null = none)   | `write`                                | `webmail.signature_defaults_changed` (flags)              |
| `PUT /api/webmail/settings/vacation`                   | automatic replies                                                          | `write`                                | `vacation.changed` (flags)                                |
| `PUT /api/webmail/settings/junk`                       | blocked / safe senders, trusted-only                                       | `write`                                | `junk_rules.changed` (counts)                             |
| `POST · PUT · DELETE /api/webmail/settings/forwarding` | ask to confirm · on/off + keep a copy · remove                             | `forwardingVerify` · `write` · `write` | `forwarding.verification_sent` · `forwarding.changed`     |
| `POST /api/webmail/forwarding/confirm`                 | the target confirms (public, token in the body)                            | `publicForm`                           | `forwarding.confirmed`                                    |

Audit entries are written in the mailbox's own account (its admins see them) as a `system` actor named by the
mailbox address; meta never holds message text, signatures or list entries — target addresses are masked. The
JMAP proxy still refuses every `SieveScript/*`, `VacationResponse/*`, `Identity/set` and `Quota/*` call
(`settings.test.ts`), so the confirmation and audit can't be skipped from the browser.

### Profile photos (2026-10-29, ADR-0022)

- **One source with the console.** Settings → Account → You shows the photo of the active mailbox's person — the
  same one as their console Profile page — or, for a mailbox without a person, the mailbox's own, with Upload /
  Change / Remove (`POST`/`DELETE /api/webmail/settings/avatar`, `avatarUpload` tier). The browser crops to a square
  and re-encodes; the server checks and re-encodes again (07-security.md "Profile photos").
- **Where they show:** the sidebar's mailbox tiles (the account switcher, and the collapsed rail's trigger), message
  senders in the list and the reader, and the contacts list — for addresses that are mailboxes in the same account as
  one of the session's mailboxes (`POST /api/webmail/avatars/lookup`, batched, ≤ 100 addresses; anything else stays
  initials). Images come from `/api/webmail/avatars/:kind/:id` on this origin only.
- **Kept in step (rule 61):** `components/webmail/avatars.ts` re-reads the session's photos (`GET
/api/webmail/avatars`) on focus and when the tab is shown, every five minutes, and right after a change here; a
  change has a new URL (content-hash version), an unchanged photo stays cached.
- **Names:** the field below the photo is the **sender name** (the JMAP identity's name for this address, "Sender
  name, as people see it on your mail"), not the person's console name; the copy says so (04-data-model.md "Names").

### Security notes from the slice 1 review (2026-10-22)

- **Account-level suspension must gate the webmail too.** Done: a staff suspension of an account or a person suspends
  their mailboxes (status `suspended`, with a hold), and `MailboxStatusLookup` also returns whether the mailbox's
  person is suspended, so sign-in, every session use and `route()` refuse both ("Who may use the webmail").
- **Attachment names never travel in URLs.** `/api/webmail/download/:blobId` carries only the blob id; the link's
  `download` attribute names the file (the sanitised name the reader shows) and the response is a bare
  `Content-Disposition: attachment`. Our access log records paths only; NGINX must not log query strings for
  `/api/webmail/*` either (use `$uri`, not `$request` / `$request_uri`, in the `mail.` log format), in case a future
  endpoint adds one.
- **Stalwart sees the end user's address.** The BFF forwards the trusted client IP as `X-Forwarded-For` on
  `/api/auth` and `/auth/token`, and Stalwart has `x:Http.useXForwarded: true` (dev plan; required in production), so
  its anonymous rate limit and failed-login ban apply per person, not to the app. That setting trusts the header from
  any caller, so **Stalwart's HTTP listener must be reachable from the app network only** (it is: internal network
  in production, `127.0.0.1` in dev by default). Stalwart's 429/403 on sign-in surface as "busy", never as "wrong
  password".
- **Dev forwards visitors' addresses too (2026-10-22).** Without a client address every dev sign-in reached Stalwart
  from the `mail-edge` forwarder's container address, so the day's deliberate wrong passwords (tests from every
  agent) got the forwarder banned permanently and the whole app lost Stalwart. Now dev runs `TRUST_PROXY=true`,
  `scripts/dev-mail-proxy.mjs` sets `X-Forwarded-For` (`dev-forwarded-for.mjs`: a LAN visitor's socket address,
  replacing anything they sent; a loopback visitor's own valid address, else loopback), and the OAuth adapter
  forwards `127.0.0.1` in dev when a request has no address (direct hits on the app port, work outside a request).
  Tests that fail sign-in on purpose use their own documentation-range address (RFC 5737: e2e via
  `extraHTTPHeaders`, integration tests inside a request context), so the shared loopback identity isn't banned
  either. No `x:AllowedIp` exemption and no change to Stalwart's thresholds. Caveat: a local `.env` with
  `DEV_HOST=0.0.0.0` lets LAN machines reach the app port directly and claim any address there (dev only).
- **Proxy allow-list is minimal until the next slices.** `Email/set` may only set or clear `keywords/*` on existing
  messages (no create, destroy, moves or other properties); the composer and move slices widen it deliberately
  (done in slice 2, see "Proxy allow-list changes").
- **CSS scrubbing is linear and capped** (style attribute 8 KB, `<style>` block 64 KB, over-cap CSS dropped and
  counted as blocked); `<style>` keeps no attributes; inline `cid:` images are fetched only when the HTML references
  them, at most 32 per message.

## Client architecture

```
React UI (virtualized lists, reader iframe, composer)
   │  hooks / selectors
Sync engine (packages/jmap-client + webmail store)
   │  IndexedDB cache: mailboxes, thread/email summaries, state strings, bodies (LRU, size-capped)
   │  outbox queue (optimistic actions with rollback)
Same-origin BFF  /jmap (proxy) · /jmap/push (SSE) · /jmap/upload · /jmap/download · /img (image proxy, POST)
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
passwords are argon2id PHC strings in Stalwart, so we cannot derive tokens without the user) — or, from the console,
from a throwaway credential the control plane mints for one sign-in ("Console handoff" below). Nothing in a URL ever
pre-fills the sign-in form: a sign-in link carrying an email address is the shape of a phishing link (browsers'
phishing checks flag it) and anyone could craft one (`app/webmail/sign-in/page.tsx`).

### Console handoff (ADR-0024, 2026-10-29)

The console's **Open webmail** (person menu, sidebar, home quick actions; customers with an account that isn't
suspended, never while acting as someone) opens the person's **own** mailbox without its password. Three top-level
navigations, nothing secret in any URL a server sees:

1. `GET <webmail>/api/webmail/handoff[?mailbox=<id>]` (webmail origin): a fresh 32-byte verifier goes into an
   HttpOnly, `SameSite=Strict`, two-minute cookie (`__Host-am.handoff`; `am.handoff` in dev) and the browser is sent
   (303) to `<console>/open-webmail?challenge=<SHA-256 of it>` (plus the mailbox id, never an address).
2. The console page (`app/(console)/open-webmail`) lists the person's own mailboxes (`handoffMailboxes`: their
   `userId`, in accounts where they hold `webmail.open.own`; shared and unassigned mailboxes never) and, with exactly
   one that can be opened and a navigation the browser marks `Sec-Fetch-Site: same-site`/`same-origin` (the 303 from
   the webmail origin), continues by itself; otherwise it waits for **Open**. Minting needs a recent step-up on the
   console session (403 `step_up_required` → the page shows "Confirm it's you" in place, then continues): `POST /api/accounts/:accountId/mailboxes/:mailboxId/webmail-handoff`
   `{ challenge }` → `startWebmailHandoff` (core) checks and audits, stores a 60-second code in Redis (key = its
   SHA-256) bound to the person, the console session id and sign-in method, the account, the mailbox and the challenge,
   and answers `<webmail>/handoff#<code>`. The page moves there: the code is in the **fragment**.
3. The webmail page (`app/webmail/handoff`, `components/webmail/handoff.tsx`) removes the fragment from the address bar
   and history, then `POST /api/webmail/handoff { code }` (same origin; the verifier cookie goes with it).
   `redeemWebmailHandoff` takes the code once (`GETDEL`), compares the verifier's SHA-256 with the challenge, rebuilds
   the person from the database and re-checks the console session (still there, no support access open, still meeting
   the account's sign-in requirements), the matrix, the mailbox (still theirs, active, no password change owed) and the
   access gate (uncached). Then `WebmailService.openHandoff`: the operations key mints an app password on the mailbox
   (every permission but `authenticate` off, `expiresAt` 60 s; expired leftovers cleared first), the BFF exchanges it
   once at `/api/auth` (the person's address forwarded), destroys it, checks the JMAP session names exactly that
   mailbox, and stores an ordinary webmail session that records its console session: it ends when that console session
   ends (sign-out, "sign out everywhere", a revoke, a password reset; checked on every webmail request, "alive" cached
   ≤ 30 s). The verifier cookie is cleared on every answer; a webmail session the browser already had is ended; if the
   audit entry can't be written the new session is deleted again. Credential changes on the mailbox run under its
   credential lock (`lockCredentials`), shared with the revocation job.

Refusals land on a page that says why and links to the sign-in page: a code nobody knows or already used (400
`handoff_invalid`), another browser (409 `handoff_refused`, reason `wrong_browser`; the code is used up),
the mailbox not usable or owing its first-sign-in password change (409 `handoff_refused` — the person signs in with
the password they were given), act-as (403). Customer accounts have `maxAppPasswords` 6 (our 5 + one handoff slot,
set by `mailbox.ensure`). Rate limits `webmailHandoff` and `webmailHandoffIp` (rate-limits.md); audit
`webmail.handoff_started` / `webmail.handoff_redeemed` (audit.md). Security notes: 07-security.md "Webmail handoff".

### First-sign-in password step (2026-10-24, hardened 2026-10-28)

A mailbox created by **Add a user** with "Require this user to change their password when they first sign in" (or
given a new password by **Make this a user**) carries a must-change flag. `PasswordChangeGate`
(`packages/core/src/webmail/password-change-gate.ts`; a "required" answer is never cached, "not required" for ≤ 30 s)
makes the webmail page show **Choose your own password** (`components/webmail/first-password.tsx`: the password you
were given, a new one twice, Generate a strong password, **Save and open my mail**) instead of the inbox, and
`route()` answers `403 password_change_required` for every webmail route except the password change and sign-out
(a test pins that list). The flag clears only when the worker has applied the person's own password, in the same unit
of work; until then the step says "Your new password is being applied … sign in again", and a job that gave up shows
that the last change didn't go through. The console has its own step for the console password
(`app/(console)/change-password/page.tsx`). Details: 07-security.md, 01-architecture.md.

### Who may use the webmail (control-plane access, 2026-10-28)

Stalwart's own suspension disables sign-in, but tokens issued before it — and mailboxes our control plane blocks
without Stalwart knowing — are our responsibility. `MailboxAccessGate` (`packages/core/src/webmail/access.ts`, cached
≤ 30 s per address) answers one of:

| State              | When                                                                                                | What the person is told                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ok`               | the mailbox exists, isn't suspended or deleting, and its person isn't suspended                     | —                                                                    |
| `person_suspended` | staff suspended the person the mailbox belongs to (`user_profile.suspended`, as the console checks) | their sign-in is suspended, mail kept, appeal to the support address |
| `suspended`        | the mailbox is suspended (by its account, or by a staff suspension of the account/person)           | the mailbox is suspended, mail kept; ask the admin or support        |
| `deleting`         | the mailbox is waiting out its deletion grace period                                                | it is being deleted; ask the admin to restore it in time             |
| `gone`             | no mailbox has that address                                                                         | it no longer exists                                                  |

It is checked at sign-in (after Stalwart accepted the password), on every use of a session in the BFF
(`WebmailService.session`), and **centrally in `route()`** for every route with `session: "webmail"` — before the
first-sign-in password gate, sign-out and the password change included — so a route that never reaches Stalwart
(preferences, contacts settings) can't serve a blocked session either (`server/webmail/access-block.ts`). A blocked
session is ended (record deleted, cookie cleared) and answered `401 mailbox_unavailable` with the state's message; a
short-lived notice cookie lets the sign-in page show it. Server pages, which can't set cookies, redirect with a
signed `?reason=` (`reason.expiry.mac` under the server secret, 60 s), so a crafted sign-in link shows no notice
(`blockedNoticeForLink` in `server/webmail/http.ts`). Every open session of a suspended person ends on its next
request, within the 30 s cache.

A fresh sign-in to a mailbox Stalwart already disabled fails at Stalwart with the same answer as a wrong password, so
it can't reach the check above; the suspension is named only to a browser that signed in to that address before
(07-security.md "Webmail sign-in and suspension").

### Mailboxes shared with you (delegation, ADR-0026 §6; BFF built 2026-10-30, webmail UI and sending next)

A person given **Read and manage** on another mailbox of their account opens it in their own webmail session, without
its password and without signing in again (maintainer decision 2: no extra step). The BFF holds that mailbox's own
token; the browser never does (rule 21).

- **The list ("Shared with you").** `GET /api/webmail/mailboxes` now answers `{ active, activeShared, others, shared }`:
  `others` are the session's own signed-in mailboxes only; `shared` lists, from core `delegatedMailboxesFor`, every
  mailbox the session's people hold a right on now (`address`, `via` — the own mailbox it comes through —,
  `fullAccess`, `sendAs`, `sendOnBehalf`, `open`). The people are found from the session's own mailboxes'
  `mailbox.user_id` (a shared mailbox signed in by password maps nothing). Listing mints nothing; it also drops opened
  entries whose grant is gone.
- **Opening one.** `POST /api/webmail/mailboxes/delegated` `{ address }` (a "Shared with you" entry, or the address
  typed in **Open another mailbox**; tier `webmailDelegatedOpen`, fail closed). Core `openDelegatedMailbox` checks
  everything now under the account lock, then the web app mints a throwaway credential with the operations key,
  exchanges it once with the person's client address forwarded and destroys it (the handoff's `stalwartHandoffSignIn`,
  under the mailbox's credential lock, reserved slot, one retry when the slot was held, else 503), the BFF checks the
  JMAP session names that mailbox, and the tokens become a `delegated` entry (`{ mailboxId, granteeUserId, via }`) in
  the session, made active. Already open → switched to. Every refusal — no grant, a send-only grant, an unknown
  address, another account's address, the plan, the mailbox's state — is the same `404 not_found` "You don't have
  access to this mailbox.", audited `delegation.mailbox_opened` in the person's own account; 403 while the console
  session a handoff-born session came from has act-as open. Delegated entries don't count toward `MAX_MAILBOXES`
  (capped at `DELEGATED_MAILBOXES_PER_PERSON` instead). The page at `/mailbox/<address>/` that runs this open is slice 14.
- **The gate on every request.** `route()` runs `delegationBlock` (`server/webmail/delegation-gate.ts`) on every route
  with `session: "webmail"` after the access check. With a delegated active entry:
  - `delegated: "full_access"` routes (JMAP proxy, session document, message, attached message, raw, print,
    download, preview, image proxy, photos) ask core's `DelegationGate` (the right, membership, plan, mailbox state and
    the own mailbox now; "has the right" cached ≤ 10 s per session and mailbox, "no right" never); refused → the entry
    is dropped and the answer is 404;
  - `delegated: "allowed"` routes (list, switch, open, add one's own mailbox, sign out) work whichever is active;
  - every other webmail route (send, undo, drafts, upload, identities, settings, contacts, export) answers
    `403 own_mailbox_only`: those always act on the person's own mailbox (a route-file test pins all three lists).
    This route-level gate is defence in depth: the service decides on the entry whose token it uses (only its read
    paths accept a delegated entry; settings, password, photo and export callers refuse one on the read they use), so
    a switch between the gate and the handler can't aim an own-only action at a shared mailbox.
    `WebmailService.session()` checks the gate again on each use and before refreshing a delegated token. Before every
    open, and at most every 10 s on use, the person's own mailbox the grant comes through is proven at the mail server
    (its JMAP session, with its token, refreshed when due); a refused token or refresh — a password reset — ends the
    whole session. A refused
    refresh (the mailbox's password changed), a mail-server 403 or a refused grant drop **only that entry** and hand the
    session back to the mailbox it came through; the person's own session never ends over it. The access and
    first-password gates check the session's own mailbox (`via`) while a delegated one is active.
- **The proxy.** `checkJmapRequest` keeps its single-`accountId` rule (for a delegated entry, that mailbox's own
  account) and refuses `Identity/get` there without a send right (none is used until slice 13). `Email/set` and
  `Email/import` that would set `sender`, any `header:*` property or the `X-AnhourMail-On-Behalf` header are refused
  outright, before the allow-list (ADR-0026 §8 requirement 3); drafts are built server-side from `DraftInput`, which
  has no such fields.
- **Not built yet:** sending as or on behalf (the From picker, the cross-mailbox draft move, the tag; slice 13), the
  webmail UI ("Shared with you" in the switcher and sidebar, **Open another mailbox**, the refusal page; slice 14), and
  the best-effort Redis scrub of sealed tokens after a revoke (§7; the gate is the control).

### Push

- The BFF holds **one upstream push channel per active user**: the JMAP WebSocket with `WebSocketPushEnable` (preferred) or EventSource. It fans `StateChange` events out to every open tab over **our own SSE** endpoint. Tabs share one connection via `BroadcastChannel` and leader election.
- A state change triggers `*/changes` for the affected types only. There is no polling (except a 5-min safety resync when push is down).
- **Until push lands (built today):** the app sends one request carrying `Email/changes` and `Mailbox/changes`
  every 30 s while the tab is visible (at once on focus, visibility or coming back online; backing off after errors;
  `mailChanges` in `components/webmail/mail-client.ts`). Changed folders alone (counts moved by reading or moving
  mail on another device or in an IMAP app) reload just the folder counts. A real mail change reloads the folders and
  the list windows in place, and is passed to the open conversation as the new messages' thread ids and the changed or
  removed message ids: when it touches the conversation (or on Refresh, or when the server can't list the changes),
  the conversation loads again in place — what the person expanded or collapsed stays, newly arrived messages open
  like on first opening, the scroll position and loaded bodies are kept (`mergeExpanded`, `touchesThread` in
  `components/webmail/conversation.ts`). New arrivals aren't marked read automatically.
- **Folder counts follow the webmail's own changes (2026-10-29):** the mail client reports every change it makes to
  folder membership or read/draft state once it has been answered (`onChange`: `Email/set` updates and destroys, a
  new draft, a send, an undone send — saving over an existing draft doesn't change a count and isn't reported; a
  refusal changed nothing and isn't either). The app turns those reports into one folder reload (`Mailbox/get` plus
  the Priority count) 300 ms after the first, coalesced so a burst of changes costs one reload and never more than one
  is in flight (`coalescer` in `components/webmail/sync.ts`); while Drafts is shown its list reloads with it. So no
  action has to remember to reload the counts — discarding a draft, sending one, reading, moving, restoring,
  blocking or reporting spam all go through the same path. Marking read or unread also moves the unread counts at
  once for the messages the list has (`adjustUnread`); the server's counts that follow are the source of truth.
- **New mail alerts (2026-10-23; chime and permission help in `components/webmail/sync.ts`, the check in
  `webmail-app.tsx`):** when the check finds new Inbox mail, an optional
  short chime (Web Audio, `newMailSound`, default on) and an optional desktop notification naming only the sender,
  never the subject or text (`desktopNotifications`, default off; Settings → Reading → New mail). Turning
  notifications on asks the browser; if it refused, `notificationHelp` explains how to allow them in the site
  settings (2026-10-28).
- **Answered (Phase 1, ADR-0018):** long-lived channels do **not** count against `maxConcurrentRequests`. With one
  WebSocket (`/jmap/ws`, subprotocol `jmap`, `WebSocketPushEnable`) and five EventSource streams open for the same
  user, bursts of 4 and 8 requests still all succeeded, and the 40-request overload test produced the same share of
  `limit` errors as with no channels. Sizing: one upstream WebSocket per active user (EventSource as fallback),
  plus the ≤ 4 in-flight request queue above.

### Rendering safety

- Server-side sanitising (allow-list sanitizer; HourMail's DOMPurify config is the starting point, hardened per `research/legacy-audit.md`) plus a client-side defence in depth.
- Message HTML renders in an `<iframe sandbox>` **without `allow-scripts` and without `allow-same-origin`**, `srcdoc`, with its own CSP: `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'` (the frame never loads an image by URL, not even from the proxy: loaded images arrive as `data:` URLs). Links open via `target=_blank rel=noopener noreferrer` through a click interstitial for lookalike domains.
- **Remote images are blocked by default.** "Load images" fetches them through our image proxy (`POST /api/webmail/img` with a signed image link): no cookies, no referrer, no client address, a size cap, and content checks. Senders never see the user's IP. The choice can be remembered per sender. Details: "Remote images" below and `07-security.md` "Image proxy (SSRF)".

### Remote images

Built 2026-10-29. `server/webmail/{sanitize,image-proxy,remote-image}.ts`, `app/api/webmail/img/route.ts`,
`components/webmail/{message-body,remote-images,mail-client}.ts(x)`.

- **Served blocked, with links.** The message routes (`messages/:emailId`, `attached/:blobId`) sanitise with
  `linkingSanitizer`: every remote `<img>` (http, https, protocol-relative) becomes a placeholder with a signed
  **image link** in `data-am-img` and no address; at most `REMOTE_IMAGES.perMessage` (100) per message. Trackers
  (≤ 2×2) are still dropped and never linked; CSS background images stay blocked (counted, not loadable). The view
  carries `loadableImages` and `senderKey`. The print view keeps images blocked.
- **Why sign when serving, not a sign endpoint:** the proxy can only ever fetch addresses that were in a message this
  session opened, for the mailbox it showed, for an hour; a sign endpoint would let any session make us fetch any
  address. The link goes in a POST body so no address lands in access logs.
- **Loading.** "Load images" (or a setting) posts each distinct link to the proxy, four at a time; answers become
  `data:` URLs (raster types only) and replace the placeholders in the frame document (one re-render at the end).
  An expired link (410) makes the reader load the message again for fresh links, once. Images that fail stay
  placeholders and the notice says how many.
- **Without asking:** `remoteImages` `always`; `contacts` when the From address is on a contact card (the reader's
  known-addresses set); or a remembered sender (`senderKey` in `imageSenders`). "Always load from this sender" /
  "Stop loading from this sender" on the notice; "Forget all" in Reading settings. Both `contacts` and remembered
  senders need a **verified From** (`senderVerified` in `image-proxy.ts`): our own trusted Authentication-Results show
  DMARC passing for the From domain or DKIM passing for it or a parent domain. A message with no results of ours is
  not verified: a copy forwarded by a mailbox's redirect rule arrives that way whatever its From says (security-audit
  run-32), and so does mail sent from inside, which therefore always asks. Otherwise the server sends no sender key
  and the reader asks, so a forged From can't learn that the message was opened. Attached messages are never
  verified.
- **Notice copy.** Blocked: "N remote images blocked · N trackers removed — Senders can't see when or where you
  opened this. Loading them goes through our privacy proxy, so the sender never sees your IP address." Loaded:
  "Images loaded through our privacy proxy — The sender can't see your IP address or your browser."
- **Limits** (`REMOTE_IMAGES` in `packages/shared/src/webmail.ts`, published): 5 MB per image, 100 per message,
  3 redirects, 10 s, links valid 60 min, 500 remembered senders. Rate tier `webmailImage`.
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
- Icon buttons get a shared `Tooltip` (`apps/web/src/components/tooltip.tsx`, no dependency) instead of `title`:
  shows after 150 ms on hover and at once on keyboard focus, hides on leave, blur, click or Escape, flips at the
  viewport edge, shows the shortcut in a mono keycap, `role="tooltip"` linked with `aria-describedby` while shown
  (the button keeps its `aria-label`).
- Optimistic actions (archive, delete, flag, read, move) are applied instantly with rollback on failure (an idea kept from HourMail). An outbox queue handles send with undo-send (5–30 s, user setting).

### Keyboard shortcuts (conventional webmail defaults, rebindable later)

Built (`SHORTCUTS` and the key handler in `components/webmail/webmail-app.tsx`; the `?` dialog lists the same set;
off when Settings → Region and shortcuts turns them off):

| Key           | Action                        | Key                   | Action                          |
| ------------- | ----------------------------- | --------------------- | ------------------------------- |
| `j` / `k`     | next / previous conversation  | `c`                   | new email                       |
| `o` / `Enter` | open                          | `r` / `a` / `f`       | reply / reply all / forward     |
| `u` / `Esc`   | back to list                  | `e`                   | archive                         |
| `#`           | delete                        | `!`                   | report spam (in Junk: not spam) |
| `s`           | add to / remove from Priority | `p`                   | pin / unpin                     |
| `x`           | select                        | `Shift+i` / `Shift+u` | mark read / unread              |
| `/`           | search                        | `,`                   | settings                        |
| `?`           | shortcut help                 | `⌘/Ctrl+Enter`        | send (composer)                 |

Not built yet: the `g i` / `g s` / `g d` go-to sequences.

## Folders (ADR-0014)

| Capability                                                                           | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Plan                        | Phase                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------ |
| System folders: Inbox, Drafts, Sent, Archive, Junk, Trash                            | JMAP `role`s; Archive comes from Stalwart's `x:Email.defaultFolders` (`archive.create` on, so every account opened since gets it), older mailboxes from the one-off `backfillArchiveFolders` (ADR-0014 update); with no Archive the action shows an error toast; Inbox/Junk/Trash can't be deleted (server rule)                                                                                                                                                      | All                         | 4                              |
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

## Signatures (ADR-0014)

**Built (2026-10-29).** A mailbox keeps up to 20 named signatures (`WEBMAIL_SIGNATURES` in
`packages/shared/src/signatures.ts`, published in the docs) with two defaults: **Default for new messages** and
**Default for replies and forwards**, each of which may be "(No signature)".

- **Belongs to the mailbox (decision).** Signatures and both defaults are per mailbox, not per sending address: any
  of the mailbox's addresses (its own, aliases, masked aliases) can use any of them, and changing From in the
  composer keeps the chosen signature. Per-address defaults would add a matrix most people never need; they can be
  added later as an override without changing the storage. Shared mailboxes get their own set when send-as from a
  shared mailbox ships (each mailbox is its own owner).
- **Storage:** `webmail_signature` (migration 0023): name (1–32 characters, unique per mailbox ignoring case), the
  sanitised HTML, the generated text, and one `default_new` / `default_reply` flag each (partial unique indexes keep
  one of each per mailbox; deleting a default leaves none). A dedicated table rather than the preferences JSON
  because a signature can be up to 300 KB with images, and the preferences row is read on every page load.
  `webmail_preference.signatures_started_at` records that the mailbox's signatures were started (see "Bringing the
  old signature over"). Service `packages/core/src/webmail/signatures-service.ts`; the BFF joins it with the mail
  server in `server/webmail/settings.ts`.
- **Sanitised on save, on the server** (`server/webmail/signature-html.ts`, which runs in the editor too so the
  person sees what is kept): the outgoing allow-list sanitiser in its `embeddedImagesOnly` mode — everything it
  removes from messages, plus **every https and `cid:` image and every CSS `url()`**. Images survive only as `data:`
  PNG, JPEG, GIF or WebP whose first bytes match the type, each up to 64 KB as a file, at most 3 per signature, the
  whole signature up to 300 KB of HTML, and all of a mailbox's signatures together up to 1 MB (they load with the
  webmail). The text version is generated from the HTML (`outgoingText`). The request
  body is read with a cap before parsing (`signature-body.ts`). The core service re-checks names, count and size.
- **Editor:** Settings → Writing → Signatures has an explanatory line, **Add signature** (the panel's one primary
  button), a table of names with what each is the default for, **Edit**, **Delete** (confirmed) and **More options →
  Duplicate** ("Name (copy)"), and the two default pickers (saved on change). **Edit signature** / **Add signature**
  is a dialog with the name and the composer's rich editor and formatting toolbar (fonts, sizes, bold, italic,
  underline, strikethrough, colours, highlight, alignment, lists, indents, links, quote, Insert HTML) plus **Insert
  image**; pasted, dropped or chosen image files are read in the browser and embedded as `data:` images (type and size
  checked, then the same sanitiser); pasted HTML keeps embedded images only.
- **Composer:** `ComposeSeed.signature` is `"new"` or `"reply"` (replies and forwards); the composer starts with that
  default, or adds it when the signatures arrive after it opened. A **Signature** menu in the composer's footer
  lists "(No signature)" and every signature (checked = current). Switching replaces only the signature: in rich
  text the block marked `data-am-signature` (kept, empty, for none; the outgoing sanitiser drops the marker, so it
  never reaches sent mail or drafts); in plain text everything after the last `-- ` line of what you wrote, stopping
  where the quoted message begins (so a forwarded message's own signature is never touched). Plain text mode uses the
  generated text version. Reopened drafts start without a default but can switch.
- **Copied to the mail server's identities** so other JMAP mail apps and server-side features see one: after every
  change that alters the default for new messages, the BFF writes `htmlSignature` + `textSignature` on **every
  identity of the mailbox** with the person's own session (`WebmailService.mirrorSignature`; the browser's JMAP proxy
  still refuses `Identity/set`). Stalwart v0.16.27 keeps at most **2,047 bytes** per identity signature (2,048 is
  refused with `invalidProperties`), so the copy is the HTML when it fits, else the HTML without its images, else the
  text (cut at a line break with "…") as HTML (`identitySignature`). The settings panel says when other apps got a
  shorter copy or when the copy failed (the signature is still saved here; logged without content). There is no
  drift check yet (a JMAP client could change an identity's signature; the next change here overwrites it).
- **Bringing the old signature over:** the first `GET …/signatures` for a mailbox whose signatures were never started
  reads its identities' old signature (the mailbox's own address first, then any other) and saves it once as
  "Signature", the default for both. Starting (that, or adding a signature) sets `signatures_started_at`, so deleting
  every signature later never brings the old one back.
- **Audit:** `webmail.signature_added` / `_changed` / `_removed` / `_defaults_changed` in the mailbox's account, as
  the mailbox: signature id, size in characters, image count, which fields changed, the count of signatures — never
  the name or content (rules 24, 48).
- **Sending:** embedded images go out as `data:` images inside the HTML part, as the composer already sends pasted
  images. Some recipients' mail apps don't show `data:` images; turning them into `cid:` inline parts at send time is
  open (see the table).

| Capability                                                                                                                          | How                                                                                                                                                     | Plan                    | Phase           |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------- |
| Several named rich-text signatures per mailbox; default for new mail vs replies/forwards; pick per message                          | `webmail_signature`; editor and sanitiser above; default for new mirrored to every `Identity`                                                           | All                     | 4.1 (**built**) |
| Images in signatures                                                                                                                | embedded `data:` raster images, **remote and `cid:` images refused**; 64 KB each, 3 per signature, 300 KB total — **built**; `cid:` parts at send: open | All                     | 4.1             |
| Per-address default signatures                                                                                                      | an optional override per identity on top of the mailbox defaults                                                                                        | All                     | later           |
| Signatures for shared mailboxes                                                                                                     | each shared mailbox has its own set; members with access edit it                                                                                        | Plus/Supporter (shared) | with send-as    |
| Admin signature templates with placeholders (`{{name}}`, `{{title}}`, `{{phone}}`, `{{email}}`, `{{account}}`), optionally enforced | `signature_template`; rendered per member by the worker                                                                                                 | Plus/Supporter          | 4.1             |
| Account disclaimer appended to outgoing mail (optionally external recipients only)                                                  | inserted by the composer/submission path we control, before DKIM; **not** applied to mail sent from IMAP/SMTP clients in v1 (documented)                | Plus/Supporter          | 4.1             |
| Signatures in desktop/phone mail apps                                                                                               | set in the app itself (IMAP/SMTP clients keep their own) — docs page explains                                                                           | All                     | 4 (docs)        |

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

| v1 (Phase 4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | v1.1                                                                                                                                                                                                                                                                                                                                           | v2                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Shared mailboxes and folder sharing in the sidebar, send as from shared mailboxes, auto-reply; folders, threads, read/compose/reply/forward (rich text with a formatting toolbar; plain text mode), attachments upload/download, drafts, undo send, search (server FTS), flags, move/archive/junk with training, remote-image proxy, shortcuts, light/dark, mobile layout, identities/aliases as From, masked-alias quick create from composer, settings basics (named signatures with defaults for new mail and replies, vacation responder), nested folders with favourites, archive, Archive created at provisioning, empty Trash/Junk | Admin signature templates, account disclaimer, search folders, folder colours, archive by year, folder rules, Send on behalf, personal send-as delegation, mail flow rules UI (admins), filters on shared mailboxes, Sieve filter editor, snooze/send later, contacts autocomplete from CardDAV, multiple mailboxes switcher, PWA offline read | Calendar/contacts UI with delegation, resource mailboxes (rooms/equipment) booking, PGP, encrypted-at-rest settings, rules templates |
