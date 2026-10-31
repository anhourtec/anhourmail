# ADR-0027: Safe senders load images; own Sent mail loads images

**Status:** Accepted 2026-10-31, built 2026-10-31 (see "Update (2026-10-31): built"). Proposed 2026-10-31, revised
the same day: replaces this ADR's earlier sealed "Always load images from" list, which was never built; see
"Alternatives considered".

**Maintainer decisions (2026-10-31):**

1. **One list.** The existing **Safe senders** list (webmail Settings → Junk and blocked senders, addresses or
   domains, today "never moved to Junk") also loads remote images automatically, through the image proxy, **only
   when the message's From is verified** (the rule of today, `senderVerified`). There is no separate image list.
2. **"Always for <sender>"** from a message adds that sender's address to Safe senders.
3. **Own Sent mail** — a message in the open mailbox's own Sent folder loads its remote images automatically
   through the proxy, decided by mailbox, never by From.
4. **Later:** the account-wide admin list becomes an account-wide safe-senders list (Owners and User
   Administrators, verified-only, audited). Not designed here.

- Related: ADR-0003 (webmail behind the BFF), ADR-0008 (ports and adapters), ADR-0010 (audit), ADR-0019 (sender
  identity; update "internal mail", 2026-10-30), ADR-0020 (managed Sieve, customers can't write Sieve), ADR-0025
  (export and deletion), ADR-0026 (delegated mailboxes); `../05-webmail.md` "Remote images", "Settings" and the
  managed script section, `../07-security.md` "Image proxy (SSRF)".

## Context

- **Safe senders today** live in the mailbox's one managed Sieve script (`anhourmail`): the settings line
  (`SETTINGS_PREFIX` + base64url JSON of `MailRules`, `apps/web/src/server/webmail/sieve.ts`) holds
  `junk.safe` / `junk.blocked` (≤ `MAX_SENDER_ENTRIES` = 300 each, validated by `senderEntry`), and the compiled
  rules test them with `address :all :is "from"` (address) and `address :domain :is "from"` (domain, exact, no
  subdomains), `i;unicode-casemap`. The script is read and written with management credentials through the
  `ManagedSieve` port (`WebmailService.mailRules` → `sieve.read(accountId)` → `{ content, active }`), never the
  user's token. `PUT /api/webmail/settings/junk` saves the whole `junk` object (`WebmailSettings.saveJunk`), own
  mailbox only, rate tier `write`, audited **`junk_rules.changed`** with counts (`blocked`, `safe`, `trustedOnly`).
- **Images today:** "Always for <sender>" stores `senderKey` — `HMAC(server secret, "am.webmail.image-sender.v1" ‖
mailbox ‖ lowercased From)` — in `webmail_preference.prefs.imageSenders` (≤ 500). The message route sends the key
  only for a verified From; the browser matches it. Keys can't be shown, so Settings offers only a count and
  "Forget all". Own Sent mail loads only on "Load images", once, with no choice (`own` on `MessageContent`).
- The earlier design of this ADR (a separate list sealed per mailbox in a new Postgres table) solved the "show the
  list" problem by inventing a second list. People already have one list of senders they trust; a second, almost
  identical list with different limits is what they would not expect.

## Decision

### 1. One list, two effects

A Safe senders entry means: the junk rules never move this sender's mail to Junk (unchanged, enforced at delivery
by Sieve) **and** the webmail loads this sender's remote images without asking, through the proxy, when the From is
verified. Storage, limits (300), validation (`senderEntry`) and the route stay as they are. Blocked senders are
unchanged and never load images.

Verification stays exactly as today (`senderVerified` in `image-proxy.ts`: DMARC pass for the From domain or DKIM
pass for it or a parent on our own trusted Authentication-Results, or our internal-mail marker; attached messages
never). A forged From that matches a safe sender gets the normal notice and "Load images", plus the unverified line.
Note the asymmetry, which is deliberate and documented: Sieve's junk skip does not require verification (today's
behaviour, unchanged here); image loading does, because loading is an observable signal to the sender.

### 2. Matching (identical to the junk rules)

`matchSafeSender(from, safe)` — pure, in `packages/shared/src/senders.ts`, together with `senderEntry` and its
`ADDRESS` / `DOMAIN` patterns moved out of `server/webmail/sieve.ts` (no behaviour change; `sieve.ts` imports
them):

- `from` = the verified From address, trimmed, lowercased (the same lowercasing as `senderEntry`, matching
  `i;unicode-casemap` for ASCII).
- Address entry: exact match on the whole address. Domain entry: exact match on the From's domain. **No
  subdomains** — `example.com` doesn't cover `news.example.com`, the same as the Sieve `:domain :is` test, so the
  two effects of one entry always agree.
- Returns `{ kind: "address" | "domain"; value }` or null; an address match wins over a domain match.
- Entries are ASCII only (the `DOMAIN` pattern); an IDN From domain never matches a typed entry until the junk
  lists accept A-labels (out of scope; open question 2).

A test asserts that for a table of From/entry pairs `matchSafeSender` agrees with the compiled Sieve tests' intent
(same inputs, same verdicts as the junk-rule unit cases in `sieve.test.ts`).

### 3. Where the check runs: server, on message view, cached

The browser never receives the list for matching. The message route (`app/api/webmail/messages/[emailId]/route.ts`),
after deciding `senderVerified` and only when the view has loadable images **and** the From is verified:

1. Resolves the mailbox **server-side** — the session's active mailbox; for a delegated tab, the mailbox the
   delegation gate admitted (ADR-0026) — never from a browser-sent id.
2. Reads that mailbox's safe list through `server/webmail/safe-senders.ts` → `safeSenders(accountId)`: the parsed
   `MailRules.junk.safe` of the managed script, read with `ManagedSieve.read` (management credentials, as today).
3. **Cache:** a per-process LRU (≤ 2,000 mailboxes) of `accountId → { stamp, addresses: Set, domains: Set }`.
   Freshness: a Redis counter `webmail:rules:v:<stalwartAccountId>` (a number, no addresses), `INCR`ed by every
   managed-script write (`saveMailRules` — junk, vacation, forwarding, the contacts refresh, the reconciler's
   rewrite). On use: same counter → cached sets; different or missing → re-read the script. **Redis down** (fail
   open for availability, never for permission): fall back to a 60-second TTL on the entry. The writing process
   replaces its own entry immediately. Decoded lists live only in the web process's memory: **never written to
   Redis or Postgres**, never logged.
4. Sets `safeSender: { kind, value } | null` on the view (only when verified and matched). `loadsWithoutAsking` and
   `rememberOffer` (`remote-images.ts`) read it in place of the browser-side key lookup.

**Failure modes:** Sieve read fails or times out (300 ms budget on this path) → no match, the notice and "Load
images" show as for an unknown sender, `log.warn("safe senders unavailable", { component: "webmail", error:
<name> })`. Script missing or not ours (`parseScript` → null) → empty list. Script present but **inactive**
(`state: "inactive"`, Settings shows its existing warning) → the list still applies to images: it is the person's
stated trust, and image loading doesn't depend on the script running. Log lines never carry an entry.

**Cost:** nothing extra for messages without remote images or with an unverified From; otherwise one Redis `GET`,
and one management read after a rules change.

### 4. "Always for <sender>" and "Stop loading"

New route **`POST /api/webmail/settings/junk/safe`** `{ emailId }` and **`DELETE …/junk/safe`** `{ emailId }`
(rate tier `write`, own mailbox only — 403 `own_mailbox_only` in a delegated tab via the delegation gate; pinned
with `X-Webmail-Account`). The browser never sends an address: the BFF reads that message's From with the session's
token, re-checks `senderVerified`, and applies a **delta** to `junk.safe` (add the address, or remove whichever
entry matched — so "Stop loading" on a domain match removes the domain entry, and the confirm text says so: "Stop
loading images from anyone at <domain>? This also removes <domain> from Safe senders.").

- New method `WebmailSettings.changeSafeSender(sessionId, account, emailId, "add" | "remove", req)`: reads rules,
  applies the delta (dedupe; adding an address already covered by its domain is a no-op success), validates through
  `JunkInput`, writes through the existing `saveMailRules` path, audits (section 7).
- The same message moved out of Junk is not touched: adding to Safe senders affects future delivery only (as the
  Settings list does today). The reader's confirm line after "Always for": "Images from <address> will load, and
  their mail won't go to Junk."
- Errors: `emailId` not visible to the session → 404; unverified From → 400 "Images from this sender can't be
  remembered because we couldn't confirm who sent it."; list full (300) → 400 "Your Safe senders list is full.
  Remove some entries in Settings first."; address on Blocked senders → 409 "<address> is on your blocked list.
  Remove it there first."; script budget exceeded → the existing `MAILBOX_RULES_LIMIT_MESSAGE`.
- **Concurrency:** today's `saveJunk` is read-modify-write of the whole script with no version check, so two
  concurrent writes can lose one. This route uses deltas, and the `ManagedSieve` write gains an optimistic check:
  re-read and compare the content hash immediately before `putSieveScript`, retry the delta once on mismatch, then
  409 "Your settings changed in another window. Try again." (Stalwart's `SieveScript/set` has no `ifInState` on the
  management path we use; verify on v0.16.27 before building — if it does, use it instead.) `saveJunk` gets the
  same check.
- Optimistic UI as today: the reader loads the images at once and saves in the background; on failure it shows the
  error and keeps the message loaded.

### 5. Own Sent mail

A message whose `mailboxIds` include the open mailbox's folder with role `sent` (never decided by From; in a shared
or delegated tab, that mailbox's own Sent) **loads its remote images automatically through the proxy in every
Reading mode**, with no notice choice and no unverified line. The decision is the existing `own` flag, computed by
the reader from the folder; the server needs nothing new (no sender key, no list lookup). The loaded notice stays
("Images loaded through our privacy proxy …"). A copy of the same message in Inbox (a message to oneself) follows the
normal rules there; the reader treats a message as own when any of its mailboxes is Sent. Drafts are not Sent and
stay as today.

### 6. Reading settings interplay

Reading → "Load remote images" keeps its three modes (`REMOTE_IMAGE_MODES` = `ask`, `contacts`, `always`):

| Mode       | Loads without asking                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `always`   | Every message (unchanged).                                                                           |
| `contacts` | Own Sent mail; verified From on a contact card; verified From matching Safe senders.                 |
| `ask`      | Own Sent mail; verified From matching Safe senders. (Safe senders is explicit, per sender, consent.) |

Everything else shows the notice. The Reading panel's "Forget all" (for fingerprints) becomes the legacy line in
section 8; the panel gains one sentence: "Images from your Safe senders always load. Manage them in Junk and blocked
senders." with a link to that section. With "Only trust my contacts and safe senders" (trusted-only) nothing changes
for images: it already lists safe senders separately from contacts.

### 7. Privacy, audit, logging, rate limits, roles

- **Privacy / rule 24.** The list already exists in the mailbox's own Sieve script on Stalwart: it is the person's
  own filter configuration, stored on the mail server with their mail, exported with the mailbox's rules, deleted
  with the mailbox. It is not mail content and it never enters Postgres, Redis, logs, analytics, audit or error
  reports through this design: Postgres gains nothing, Redis holds only a counter, the cache is in-process memory.
  So it doesn't conflict with rule 24, and it removes the need for a sealed Postgres copy of correspondents.
- **Audit (rule 46).** Settings saves stay **`junk_rules.changed`** with counts (unchanged). The new routes write the
  same action with extra meta `via: "message"`, `change: "added" | "removed"`, `kind: "address" | "domain"`, and the
  new counts — never an address or domain (rule 48). Settings saves add `via: "settings"`. A refusal in a delegated
  tab is audited `denied` with the delegate as actor (the gate's existing helper). Note: junk writes are
  write-then-audit (the script is on Stalwart, outside our transaction), as today; the audit row is written right
  after a successful write and a failed audit is logged at error level. `../audit.md` gets the new meta keys; no new
  action name.
- **Logging:** no new keys carry entries; add `safeSender` to `REDACT_KEYS` as a backstop.
- **Rate limits:** the two new routes use `write`, not fail-closed (no sending or abuse effect). Rows in
  `../rate-limits.md`.
- **Roles:** no RBAC matrix change (a webmail session acts as its mailbox). `../roles.md` notes that delegates
  can't change another mailbox's Safe senders.

### 8. Delegated and shared mailboxes

- In a delegated or shared mailbox's tab, images match **that mailbox's** Safe senders (read with management
  credentials for the admitted mailbox's Stalwart account id, as the reconciler reads it). The Reading mode stays the
  delegate's own preference, as today.
- Delegates can't change that list: the reader offers "Just this once" only (no "Always for", no "Stop loading"),
  and the routes return 403 in a delegated tab. A person-less shared mailbox's list can't be edited in the webmail
  until the account-wide list exists (section 10); an Owner can still edit it by signing in to that mailbox if it
  has credentials.

### 9. Existing fingerprints (`imageSenders`): keep read-only, then drop

Decision: **no automatic conversion into Safe senders.** A fingerprint meant "load images"; turning it into a Safe
sender would silently also exempt that sender from Junk, a wider grant than the person gave.

1. `imageSenders` stays readable: the message route still sends `senderKey` for verified senders while the
   mailbox's preference holds any keys, and the reader still loads on a match.
2. On a legacy match the reader shows, after loading, "Always load from this sender" → "Add <address> to Safe
   senders" (the new route) and, when used, removes the key in the same request (`PATCH …/preferences`, as "Forget"
   does today). "Stop loading" removes the key.
3. Reading settings shows "N senders saved before Safe senders loaded images" with **Forget them**.
4. New saves never write keys. **Drop:** 90 days after this ships to production, a code change normalises
   `imageSenders` to `[]` and removes the key from `@anhourmail/shared/webmail` and the `senderKey` code path. It
   lives in `prefs` jsonb, normalised on read: no migration, rollback level **Safe**.

### 10. Account-wide list (later, not designed here)

The planned account-wide "trusted image senders" list becomes an **account-wide safe-senders list** managed in the
console by Owners and User Administrators: verified From only for images, audited per change, visible to the
account's admins, applied to every mailbox. `matchSafeSender` takes sources in order (mailbox, then account) and
the match carries `source`. Where it is stored, and whether it also feeds every mailbox's junk rules, are that ADR's
questions.

### Interfaces summary

```ts
// packages/shared/src/senders.ts (no dependencies)
export function senderEntry(input: string): string | null; // moved from sieve.ts, unchanged
export type SafeSenderMatch = { kind: "address" | "domain"; value: string };
export function matchSafeSender(from: string, safe: readonly string[]): SafeSenderMatch | null;

// apps/web/src/server/webmail/safe-senders.ts
export function safeSenders(
  stalwartAccountId: string,
): Promise<{ addresses: Set<string>; domains: Set<string> } | null>; // null = unavailable
export function bumpRulesVersion(stalwartAccountId: string): Promise<void>; // called by saveMailRules

// view field (MessageView): safeSender: SafeSenderMatch | null
```

No migration. No Postgres change. No new environment variable.

## Consequences

- People see, add and remove trusted senders in one place they already know; "Always for" and the Settings list are
  the same thing. The behaviour is the conventional one.
- Adding a sender for images also keeps their mail out of Junk. That is the intended coupling; the reader's confirm
  text says it.
- Limit is the junk list's 300, not 500 (`REMOTE_IMAGES.maxSenders` stops being a list limit once fingerprints are
  dropped; the published limit text changes then).
- A message open with remote images from a verified sender costs a Redis read and, after a change, a management
  read; reading mail now depends (softly, fail-to-ask) on the management path.
- Own Sent mail loads automatically: a remote server sees a fetch from our proxy when the person opens their own
  sent message (no IP, no browser) — accepted by the maintainer.
- Domain entries stay exact; nobody can trust a whole provider's subdomains by accident, and an entry of a large
  shared provider domain (including ours) is allowed, as in the junk lists today; images still need a verified From.

## Alternatives considered

- **A separate per-mailbox "Always load images from" list sealed in Postgres** (this ADR's earlier text: table
  `webmail_image_sender_list`, AES-256-GCM via the key ring, AAD per mailbox, version-checked cache). Sound, but a
  second list of trusted senders beside Safe senders, with its own limits, UI, migration, key-rotation target and
  export path. Superseded: **one list is the conventional behaviour people expect**, and it keeps correspondents out
  of Postgres entirely instead of sealing them there.
- **JMAP File Storage in the mailbox** (the first draft): file storage is being switched off for every customer
  (shares to any account). Dropped.
- **Converting fingerprints into Safe senders automatically:** widens consent (section 9). Rejected.
- **Matching in the browser** (sending the safe list with each view or with preferences): exposes the list to every
  page load and lets a forged From be tested client-side. Rejected.
- **Caching parsed lists in Redis:** Redis persists and is shared; only a counter goes there. Rejected.
- **Subdomain matching:** would make one entry mean different things for Junk and images. Rejected for now.

## Build plan (slices, each its own commits)

1. `packages/shared/src/senders.ts`: move `senderEntry` and patterns, add `matchSafeSender`; `sieve.ts` imports them
   (no behaviour change); unit tests.
2. Rules version counter: `bumpRulesVersion` in every managed-script write; optimistic content check before
   `putSieveScript` (verify `SieveScript/set` options on v0.16.27 first).
3. `server/webmail/safe-senders.ts` (cache, counter, TTL fallback, failure states); message route sets `safeSender`
   for the own and delegated mailbox.
4. `remote-images.ts`: decisions read `safeSender`; own Sent loads automatically in every mode; legacy key path kept.
5. Routes `POST`/`DELETE /api/webmail/settings/junk/safe` + `changeSafeSender` + audit meta; rate-limit rows.
6. Reader UI: "Always for" / "Stop loading" call the routes; confirm copy; delegated tab "Just this once" only.
7. Settings copy: Safe senders description → "Mail from these addresses or domains is never moved to Junk, and their
   images load."; Reading panel sentence + link; legacy fingerprint line.
8. Docs and changelog (below). Later, separately: the fingerprint drop (section 9.4).

## Tests

- **Unit** `senders.test.ts`: exact address, exact domain, no subdomain, case, address beats domain, empty list,
  agreement with the Sieve test intent.
- **Unit** `safe-senders.test.ts`: cache hit on same counter, re-read on bump, TTL fallback when Redis fails, read
  failure → null (no match), inactive script still matches, no entry in any log call.
- **Unit** `remote-images` / `image-proxy` tests: unverified From matching a safe sender still asks; `ask` mode +
  safe sender loads; `contacts` mode; own Sent loads in `ask` and with a forged From in Inbox it doesn't; attached
  messages never match; legacy key still loads.
- **Unit** routes: 404 for an `emailId` the session can't see, 400 unverified, 400 full, 409 blocked, 403 + `denied`
  audit in a delegated tab, pin mismatch 400; audit meta has counts and kinds only (assert no `@`); concurrent delta
  retry.
- **Integration** (real stack): "Always for" writes the address into the managed script and a later delivery from it
  skips Junk; a second web process sees the change after the counter bump; delegated tab matches the mailbox's list.
- **e2e** `webmail-images.spec.ts`: add a domain in Junk and blocked senders → a verified message from it loads in
  `ask` mode; a forged From from the same domain still asks; "Always for" appears in Safe senders; "Stop loading"
  removes it; own Sent message loads automatically; Settings copy shows the new description.

## Docs to update when built

`../05-webmail.md` ("Remote images", "Settings", managed script), `../07-security.md` ("Image proxy": the matching
source), `../01-architecture.md`, `../04-data-model.md` (`imageSenders` legacy and drop), `../audit.md`
(`junk_rules.changed` meta), `../rate-limits.md`, `../roles.md`, `../codemap.md` (`senders.ts`, `safe-senders.ts`),
`docs/public/webmail.mdx` (Safe senders now also load images, verified-only wording without protocol names, own Sent
mail), a changelog entry.

## Decided (maintainer, 2026-10-31)

1. **Reading mode `ask` + Safe senders:** safe senders' images load in every mode; adding a sender is explicit
   consent for that sender.
2. **IDN domains:** accepted as A-labels (typed U-labels converted with `domainToASCII`) for both effects at once.
3. **Optimistic check on the script write:** checked on the pinned server when building; the re-read-and-compare
   fallback in section 4 is used if `ifInState` isn't honoured.
4. **Fingerprint drop date:** at launch (pre-staging has only test users).

## Update (2026-10-31): built

Built as decided, slices 1–8 (the fingerprint drop at launch stays a later change). What the code does where the text
above left a choice:

- **IDN (decision 2):** `senderEntry` converts a typed U-label to its A-label with the WHATWG URL parser (the same
  mapping as `domainToASCII`, and it runs in the browser too); `matchSafeSender` converts the From's domain the same
  way, so both effects see one form. A test asserts `matchSafeSender` and the compiled Sieve tests agree.
- **Optimistic check (decision 3):** `ifInState` **is** honoured by `SieveScript/set` on the management path of the
  pinned v0.16.27 (a stale state is refused with `stateMismatch`; verified against the real server in
  `webmail-settings.int.test.ts`). So the re-read-and-compare fallback isn't used: `putSieveScript(…, ifInState)`
  writes on the state of the read the change was based on (`null` = "the read found no script"), for `saveJunk` and
  the Safe senders routes (one retry of the delta, then 409 `settings_changed`); the contacts refresh uses it too.
- **Rules version:** a missing counter is created at a random start (not 0) and `INCR` creates it the same way, so a
  Redis flush can't make an old stamp look current; counters expire after 30 days; a cached list is also re-read
  after 10 minutes whatever the counter says (covers a bump lost while Redis was down).
- **Denied audit in a delegated tab:** the delegation gate still answers 403 before the handler; the route's new
  `onSharedRefusal` option (in `route()`) records `junk_rules.changed` `denied` `own_mailbox_only` through
  `WebmailSettingsService.recordMailFlowDenied` (the person as actor, in the shared mailbox's account).
- **Reader:** in a shared mailbox's tab "Load images" loads straight away (the "Just this once" choice alone would be
  a one-button question). After a fingerprint match the notice offers "Add <address> to Safe senders" (forgets the
  fingerprint once saved) and "Stop loading from this sender" (forgets it). Preferences changes can only remove
  fingerprints. Settings shows the legacy line only while there are any ("Forget them").
- **Message view:** `withImageSender` (`image-proxy.ts`) replaces `withSenderKey`; attached messages are served without
  any sender evidence (never verified, never matched).

## Update (2026-10-31): security review fixes

After the coordinator's review and security-audit run-55 (0 confirmed), still before any commit:

- **Verified means DMARC.** `senderVerified` now needs our own results to show **DMARC passing for the From domain**
  (or the internal-mail marker); an aligned DKIM pass alone no longer counts. Reason: a DKIM signature limited to part
  of the body (`l=`) can be replayed with content appended, such as images. This applies to every way images load
  without asking (Safe senders, "Always for", remembered fingerprints, contacts mode), since they all use it.
  Residual (needs validation): a DMARC pass can itself rest on such a DKIM signature; whether the pinned Stalwart
  honours `l=` wasn't tested on the dev stack (no DNS there to publish a throwaway key), so the regression is a unit
  test on real results headers (`original.test.ts`).
- **One domain form for verification and matching.** `fromAddress` (`@anhourmail/shared/senders`) takes the From only
  if its domain is already plain ASCII and lower-cases A–Z only — no fullwidth letters, ideographic full stop or Kelvin
  sign mapped onto an entry. `senderVerified`, `matchSafeSender` and "Always for" all use it, so the domain matched is
  the domain verified. Typed entries still convert U-labels to A-labels (decision 2); a From written in U-label form
  doesn't match (it wouldn't verify either). Entries' local parts refuse control characters and direction or
  zero-width marks.
- **More than one From address is never verified** (the view, and the From read for "Always for").
- **Cache:** keyed by the mail-server account id **and** the mailbox address (hashed in the Redis counter key,
  `webmail:rules:v:<accountId>:<hash>`), so an account id the mail server reuses for another mailbox never inherits a
  list. A write bumps the counter and **drops** the writing process's entry instead of seeding it (a seed could race
  another write). The start-up upgrade passes the mailbox address through `ManagedScriptStore.write`.
- **Denied audit only while the grant holds:** `refusedInSharedMailbox` reads the session, which checks the delegation
  grant again; with the grant gone nothing is written into the shared mailbox's account log (still 403).
- **Errors:** a sender on Blocked senders is 409 `sender_blocked`, distinct from 409 `settings_changed`; the junk
  lists are validated with `safeParse` (no entry in an error or a log).
- **No Sieve state from the server:** if a read comes back without a state, the write falls back to re-reading the
  script and comparing a hash of its text right before writing (version `content-sha256:…`) instead of refusing every
  save.
- **Own Sent mail by folder is accepted as designed** (maintainer decision 3): a message loads its images by itself
  whenever any of its folders is the open mailbox's Sent, including Sent copies saved there by other mail apps and
  mail a full-access delegate moves into a shared mailbox's Sent folder. Either way the person (or someone with full
  access) put it there, and the fetch still goes through the proxy.
