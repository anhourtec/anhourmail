# 05 — Webmail

Last updated: 2026-10-22 (settings, part 1).

**Status (2026-10-22): slice 1 is built** — webmail sign-in (OAuth code flow + PKCE, tokens sealed server-side), the
JMAP proxy (allow-list, per-user queue ≤ 4, `limit` retry), folders with counts and nesting, the thread-collapsed
windowed list, the reader (server-sanitised HTML in a sandboxed `srcdoc` frame, remote images blocked, attachments as
downloads), read/unread/flag, basic shortcuts, and the control-plane mailbox gate. Next slices: push (SSE fan-out),
IndexedDB cache and `*/changes` sync, the image proxy ("Load images" is shown disabled until then), composer,
move/archive/delete, search. Until push lands the client refreshes on tab focus and every 5 minutes. Details:
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

### Reading (slice 2 viewer)

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
  - **View original** (`/messages/:id/raw`, text/plain, nosniff, sandbox CSP, first 2 MB shown, .eml download) and
    **Print** (`/messages/:id/print`: escaped headers + the sanitised body, served with `sandbox` CSP — an opaque
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
  (`Identity/get`, cached a minute), and builds the Email itself (in Drafts, `$draft`, plain text). Replacing a
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
  MIME token pair. Plain text only in this slice: no HTML is ever sent from the webmail yet.
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
  forwarding, junk lists, a signature, your name). One primary button per panel.
- **Opinionated choices.** One **density** control (compact / comfortable / roomy) sets text size and spacing
  together; reading pane right (default) / bottom / off; preview off / 1 / 2 lines; motion follows the device or is
  reduced (an "always animate" option would override an accessibility setting, so it isn't offered).
- **Defaults** are the current behaviour, so most people never open settings: comfortable, right pane, 2 preview
  lines, grouped by conversation, mark read when opened, open the next message after a move, Reply, 10 s undo,
  English (Canada) dates, the device's time zone, shortcuts on, start in Inbox.
- **Not offered (no real behaviour yet), recorded rather than shown as placeholders:** loading remote images
  ("always ask" / "allow for contacts") needs the image proxy — the Reading panel states that remote images are
  blocked; read receipts — Stalwart v0.16.27 doesn't advertise JMAP MDN, and the webmail never sends them (stated);
  "basic formatted" messages — the composer sends plain text only (stated); "empty Deleted after N days" — JMAP
  doesn't expose when a message was moved to Trash, so a correct per-person policy needs the worker-side
  `folder_policy` (phase 6); the server-wide 30-day clean-up applies meanwhile. "Empty Trash when I sign out" is
  offered: it is explicit and runs from the browser through the proxy's Trash-only delete.

**Where each setting lives.**

| Setting                                                                                                                 | Stored                                                                                                  | Changes behaviour in                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme, density, reading pane, preview, grouping, sender/subject first, initials, attachment names, date headers, motion | `webmail_preference.prefs` (control plane, per mailbox id; closed values, `@anhourmail/shared/webmail`) | `webmail-app` (layout, theme via next-themes, `data-motion`), `message-list` (`rowHeight(look)`, date headers between windowed rows), `mail-client` (`collapseThreads`, `attachments` property) |
| Mark as read (open / after N s / never), after delete or archive, mark read when moving                                 | same                                                                                                    | `reader` (timer), `webmail-app` (`dropThreads`, `moveThreads` adds `$seen`)                                                                                                                     |
| Reply button, undo-send delay, always show Cc/Bcc                                                                       | same                                                                                                    | `reader`, `composer`; the delay is read **server-side** at send (`holdSeconds` dep → `HOLDFOR`, 1–60 s or the 6 s fallback), never trusted from the browser                                     |
| Region, time format, time zone, start in, shortcuts on/off, empty Trash on sign-out                                     | same                                                                                                    | `format.ts` `setDateStyle`, initial view, key handler, sign-out                                                                                                                                 |
| Sender name, signature                                                                                                  | Stalwart JMAP `Identity` (`name`, `textSignature`, `htmlSignature` = escaped text + `<br>`)             | composer (inserted after `-- `, swapped when From changes)                                                                                                                                      |
| Automatic replies, forwarding on/off + keep a copy, blocked/safe senders, trusted-only                                  | Stalwart: one managed Sieve script per mailbox (`anhourmail`)                                           | delivery                                                                                                                                                                                        |
| Forwarding target + confirmation                                                                                        | `forwarding_target` (control plane)                                                                     | the BFF writes a redirect only to a confirmed target                                                                                                                                            |

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

| Route                                                  | What                                                             | Tier                                   | Audit                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `GET /api/webmail/settings`                            | preferences, identities, quota, rules + state, forwarding target | `webmailSettings`                      | —                                                     |
| `POST /api/webmail/settings/password`                  | own mailbox password: current (proved to Stalwart) + new         | `mailboxPassword`                      | `mailbox.password_changed` (no secret)                |
| `PATCH /api/webmail/settings/preferences`              | display preferences (known keys and values only)                 | `write`                                | `webmail.preferences_changed` (key names)             |
| `PATCH /api/webmail/settings/identities/:id`           | sender name / signature of an own identity                       | `write`                                | `identity.changed` (field names)                      |
| `PUT /api/webmail/settings/vacation`                   | automatic replies                                                | `write`                                | `vacation.changed` (flags)                            |
| `PUT /api/webmail/settings/junk`                       | blocked / safe senders, trusted-only                             | `write`                                | `junk_rules.changed` (counts)                         |
| `POST · PUT · DELETE /api/webmail/settings/forwarding` | ask to confirm · on/off + keep a copy · remove                   | `forwardingVerify` · `write` · `write` | `forwarding.verification_sent` · `forwarding.changed` |
| `POST /api/webmail/forwarding/confirm`                 | the target confirms (public, token in the body)                  | `publicForm`                           | `forwarding.confirmed`                                |

Audit entries are written in the mailbox's own account (its admins see them) as a `system` actor named by the
mailbox address; meta never holds message text, signatures or list entries — target addresses are masked. The
JMAP proxy still refuses every `SieveScript/*`, `VacationResponse/*`, `Identity/set` and `Quota/*` call
(`settings.test.ts`), so the confirmation and audit can't be skipped from the browser.

### Security notes from the slice 1 review (2026-10-22)

- **Account-level suspension must gate the webmail too.** Today the BFF's `MailboxAccessGate` checks the mailbox's
  own status (`suspended`, `deleting`, unknown). When account-level suspension (a whole customer account) lands, the
  same gate must also refuse mailboxes of a suspended account — extend `MailboxStatusLookup` rather than adding a
  second check, so sign-in and every session use stay covered.
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
  messages (no create, destroy, moves or other properties); the composer and move slices widen it deliberately.
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
- Icon buttons get a shared `Tooltip` (`apps/web/src/components/tooltip.tsx`, no dependency) instead of `title`:
  shows after 150 ms on hover and at once on keyboard focus, hides on leave, blur, click or Escape, flips at the
  viewport edge, shows the shortcut in a mono keycap, `role="tooltip"` linked with `aria-describedby` while shown
  (the button keeps its `aria-label`).
- Optimistic actions (archive, delete, flag, read, move) are applied instantly with rollback on failure (an idea kept from HourMail). An outbox queue handles send with undo-send (5–30 s, user setting).

### Keyboard shortcuts (conventional webmail defaults, rebindable later)

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

## Folders (ADR-0014)

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

## Signatures (ADR-0014)

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
