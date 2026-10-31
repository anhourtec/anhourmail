# ADR-0027: "Always load images from" — a visible per-mailbox list, sealed per mailbox in the control plane

**Status:** Proposed 2026-10-31

**Maintainer decisions (2026-10-31):** in Settings → Reading a person can add an address or a whole domain, see the
list (including senders saved with "Always for <sender>" from a message) and remove entries. Images from a listed
sender load without asking **only when the message's From is verified** (the rule of today); otherwise the notice and
"Load images" stay. The list is stored **in our Postgres, encrypted per mailbox** (AES-256-GCM with AAD bound to the
mailbox, key from the key ring, rule 16): the database never holds a readable sender address, and reads decrypt in
the web process. Mailbox file storage on Stalwart is being switched off for every customer (security: customers
could share files with any account), so the list can't live there. Existing fingerprints keep working. An
account-wide "Trusted image senders" list (Owners and User Administrators, verified-only, audited, also sealed, per
account) comes later and layers on top.

- Related: ADR-0003 (webmail behind the BFF), ADR-0008 (ports and adapters), ADR-0010 (audit), ADR-0016 (encryption
  at rest), ADR-0019 (sender identity; update "internal mail", 2026-10-30), ADR-0025 (export and deletion), ADR-0026
  (delegated mailboxes open with that mailbox's token); `../05-webmail.md` "Remote images" and "Settings",
  `../07-security.md` "Standards" (key ring) and "Image proxy (SSRF)", `../04-data-model.md` (`webmail_preference`,
  `webmail_image_sender_list`), `packages/server/src/keyring.ts`, `../research/reference-patterns.md` pattern 5.

## Context

Today "Always for <sender>" stores `senderKey` — `HMAC(server secret, "am.webmail.image-sender.v1" ‖ mailbox ‖
lowercased From)`, 22 characters (`apps/web/src/server/webmail/image-proxy.ts` `senderKey`) — in the control-plane
preference `imageSenders` (`webmail_preference.prefs`, ≤ `REMOTE_IMAGES.maxSenders` = 500). The message route sends a
key only when the From is verified (`senderVerified`: our own trusted Authentication-Results show DMARC pass for the
From domain or DKIM pass for it or a parent, or our internal-mail marker vouches for the From; never for attached
messages). The browser matches the key against its preferences. Keys can't be shown or typed, so Settings
(`components/webmail/settings/panels-view.tsx` ~290) offers only a count and "Forget all", and nobody can pre-approve
a sender or a domain.

Showing the list means storing addresses in a form we can read back. Plain addresses in a Postgres column would put
a person's correspondents in our database, readable by anyone with a database dump, a replica or a backup. The
earlier draft of this ADR kept the list as a file in the mailbox's JMAP File Storage; that home is gone (see
"Alternatives considered").

## Decision

### 1. Storage: one sealed row per mailbox in Postgres

New table **`webmail_image_sender_list`** (drizzle, `packages/adapters/src/db-postgres/schema.ts`):

| Column       | Type                                                         | Notes                                                                                    |
| ------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `mailbox_id` | `uuid` primary key, → `mailbox.id` `on delete cascade`       | One list per mailbox.                                                                    |
| `account_id` | `uuid not null`, → `customer_account.id` `on delete cascade` | Scoping (every account-owned row carries it); every query filters on both ids (rule 25). |
| `sealed`     | `text not null`                                              | `v1.<keyId>.<iv>.<ciphertext+tag>` from `KeyRing.encrypt`; never a readable address.     |
| `version`    | `integer not null default 1`                                 | +1 on every write; the cache's freshness check (section 3) and the response to the UI.   |
| `created_at` | `timestamptz not null default now()`                         |                                                                                          |
| `updated_at` | `timestamptz not null default now()`                         |                                                                                          |

- Index: `webmail_image_sender_list_account_idx` on `account_id` (account deletion and the later account-wide
  policy). No other index: every read is by primary key.
- **Migration:** the next free number at build time (the journal ends at `0031_mailbox_sender_name_backfill`; another
  change may take 0032 first), named `<n>_webmail_image_sender_list`, generated with `npm run db:generate -w
@anhourmail/adapters -- --name webmail_image_sender_list`. Additive (new table): rollback level **Safe**; rolling
  back the code leaves an unused table, and the legacy `imageSenders` keys keep working throughout (section 6). Logged
  in `../migration.md`.
- The in-memory adapter (`packages/adapters/src/memory`) gets the same rows, removed with the mailbox and the account
  as the Postgres cascade does (it already does this for `webmailPreferences`); the contract tests cover both.
- **Why a table of its own, not a key in `webmail_preference.prefs`:** prefs are display choices, normalised on read,
  exported as-is and patched by `PATCH …/preferences`; a sealed blob there would ride every preference read and
  write, and mixing it in would break the "no addresses" rule that column documents. A separate row also gives the
  list its own version and lock.

### 2. Encryption and keys

The repository's one pattern for data at rest is `@anhourmail/server/keyring` (`07-security.md` "Standards",
`reference-patterns.md` pattern 5): master keys by id in `SECRETS_KEYRING` (first = active, the rest decrypt only),
**HKDF-SHA256 per purpose**, AES-256-GCM with a random 96-bit IV, **AAD per row**, key id inside the output. Its
users so far: webmail session tokens, TOTP secrets (AAD `auth_two_factor:<userId>`), the export archive (AAD
`data_export:<id>`). This list follows it unchanged:

- **Purpose** (HKDF info): `webmail.image_senders`.
- **AAD**: `webmail_image_sender_list:<mailboxId>` (table + row, the `table:rowId` convention). Together with the
  purpose in the key derivation, a sealed value copied to another mailbox's row, or used for another purpose, fails
  to decrypt.
- **Plaintext**: the JSON of section 4, ≤ 256 KB before sealing (500 entries of at most 254 characters fit with room).
- **Who decrypts:** only the web process (the webmail BFF). The worker never reads this table; the console never
  shows it. No SQL function, view or report reads `sealed`.

**Why not a per-mailbox data key (envelope encryption) or a per-mailbox HKDF key.** AAD already binds each value to
its mailbox, which is what a per-mailbox key would buy against moved ciphertexts. A wrapped data key per row adds a
column, a second decryption per read and a second thing to rotate, and gives no crypto-shredding benefit: the wrapped
key sits in the same row and the same backups as the data, so deleting the row is the deletion. A per-mailbox HKDF
info string would need a new derivation path in `keyring.ts` that no other caller uses. The trade-off we accept:
one derived key encrypts every list, so the random-IV budget is shared (NIST's 2³² encryptions per key under random
96-bit IVs; one encryption per list write, far below that between key rotations). Reversal cost: low — a new purpose
string or derivation is a re-seal of each row by the re-encryption job, no schema change.

**Rotation.** Adding a key to the front of `SECRETS_KEYRING` makes it active: new writes use it, old values still
decrypt. Rows under a retired key are re-sealed by the key ring's re-encryption job (still to come, `07-security.md`
"Standards"); this table is one of its targets: scan by primary key in batches, `keyIdOf(sealed)` ≠ active →
decrypt, re-encrypt, update **where `version` is unchanged** (a concurrent write wins and is already under the new
key). A retired key leaves the ring only after the job reports no rows under it. No new environment variable.

**Failure modes on read:**

| Case                                                        | Behaviour                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No row                                                      | Empty list.                                                                                                                                                                                                                                |
| `keyIdOf` returns null for a well-formed value (key absent) | **Unavailable**: no match (fail closed), Settings says "Your list can't be shown right now" with **no Reset** (a ring misconfiguration must never invite people to wipe their lists), `log.error("image senders key missing", { keyId })`. |
| Decryption fails (tampered, wrong AAD) or JSON invalid      | **Unreadable**: no match, Settings shows "Your list couldn't be read" with **Reset list** (writes an empty list), `log.error("image senders unreadable", { component: "webmail", error: <name> })`.                                        |
| Postgres error or timeout                                   | No match (fail closed), the notice and "Load images" show as for an unknown sender, `log.warn` with the error kind only.                                                                                                                   |

Log lines carry kinds, key ids and counts only, never an entry, an address or the sealed value.

### 3. Read path, matching and caching

The decision moves to the server. The message route (`app/api/webmail/messages/[emailId]/route.ts`), after it has
decided `senderVerified` (unchanged), asks the list only when the view has loadable images **and** the From is
verified:

1. **Resolve the mailbox server-side:** the session's active mailbox address (from the session store, never from the
   browser; for a delegated tab, the mailbox the delegation gate already admitted, ADR-0026) →
   `webmailSettings.mailboxByAddress` → `{ id, accountId }`. Every repository call takes both ids.
2. **Per-process cache** (`server/webmail/image-senders.ts`): `mailboxId → { version, addresses: Set<string>,
domains: Set<string> }`, an LRU of at most 2,000 mailboxes, entries idle for 15 minutes dropped. Decrypted values
   live only in the web process's memory: **never Redis** (Redis persists to disk and is shared), never logs.
3. **Freshness check on every use:** `select version from webmail_image_sender_list where mailbox_id = $1 and
account_id = $2` (primary-key lookup, a few bytes). Same version → cached sets. Different version or not cached →
   read `sealed`, decrypt, parse, cache. No row → empty list (cached as version 0). Checking the version each time,
   instead of trusting a TTL, means "Stop loading from this sender" in one process takes effect at once in every
   other process.
4. **Writes invalidate in place:** the writing process replaces its cache entry with the list and version it just
   wrote.
5. **Matching** (`matchImageSender(from, sources)`, pure, in `packages/shared/src/senders.ts`): `from` normalised like
   entries (section 5). Address entry: exact match on the whole normalised address. Domain entry: **exact** match on
   the From's domain, **no subdomains** (the junk lists' `address :domain :is` rule); `example.com` does not cover
   `news.example.com`. The address entry wins when both match.
6. The view carries `imageSender: ImageSenderMatch | null` (set only when verified and matched) in place of the
   browser's key lookup; `loadsWithoutAsking` and `rememberOffer` (`remote-images.ts`) read it. `senderKey` stays in
   the view for verified senders while legacy keys exist (section 6). Attached messages (`attached/[blobId]`) are never
   verified, so they never match. Our own Sent mail keeps its current "load once, no choice" rule.

Cost on a message open: nothing extra when the message has no remote images or the From isn't verified; one
primary-key query otherwise, plus one decrypt after a change.

### 4. Data shape (the plaintext)

```json
{
  "v": 1,
  "entries": [
    { "value": "jane@example.com", "added": "2026-10-31T10:02:11Z" },
    { "value": "example.org", "added": "2026-10-31T10:05:40Z" }
  ]
}
```

- `value`: an address (contains `@`) or a domain (no `@`), stored normalised (section 5). `added`: ISO-8601 UTC, for
  sorting ("Recently added") and nothing else. Nothing else is stored: no names, no message ids, no counts.
- `v` lets a later shape be read and rewritten.
- Only our code writes it, but the read stays defensive: unknown keys ignored, invalid entries dropped, duplicates
  merged (earliest `added` wins), the first 500 kept. On write the service always seals the normalised, validated
  list.
- Ciphertext length shows roughly how long a list is; we don't pad. Counts are not secret (the audit records them).

Types (in `packages/shared/src/webmail.ts`, no dependencies):

```ts
export type ImageSenderEntry = { value: string; added: string }; // value: normalised address or domain
export type ImageSenderMatch = { kind: "address" | "domain"; value: string; source: "mailbox" }; // "account" later
export const IMAGE_SENDERS = { maxEntries: REMOTE_IMAGES.maxSenders, maxPlaintextBytes: 256 * 1024 } as const;
```

`REMOTE_IMAGES.maxSenders` (500, published) stays the one limit.

### 5. Validation, normalisation and display

- **One validator for every sender list:** move `senderEntry` (and its `ADDRESS`/`DOMAIN` patterns) from
  `server/webmail/sieve.ts` to `packages/shared/src/senders.ts`, used by the junk lists, this list and the Settings
  form (instant feedback). `@example.com` and `example.com` are the domain `example.com`; at most 254 characters.
- **Domains are stored as lowercase A-labels.** A typed Unicode domain is converted on the server with `node:url`
  `domainToASCII` (UTS #46) before `senderEntry`; an empty result is refused. From domains are normalised the same way
  before matching, so `bücher.example` and `xn--bcher-kva.example` are one entry.
- **Addresses:** domain part as above; local part NFC-normalised and lowercased (the rule `senderKey` already uses);
  quoted local parts are refused, as in the junk lists.
- **Display (lookalikes):** values render in mono (convention). A domain with an `xn--` label shows its Unicode form
  and, beside it, the stored A-label ("bücher.example · xn--bcher-kva.example"); a label mixing scripts (Unicode
  `Script` of its letters differs) shows the A-label only, with the note "This domain uses characters from more than
  one alphabet." Domain entries read "Anyone at example.org". No domain is refused for being a big shared provider
  (including our own platform domain); adding one shows "Images from anyone with an address at <domain> will load."

### 6. Service, routes, writes and concurrency

**Where the logic lives (ADR-0008):** `WebmailSettingsService` (`packages/core/src/webmail/settings-service.ts`)
gains `imageSenders(address)` and `changeImageSenders(address, change, req)`. It takes a **`Sealer` port**
(`{ encrypt(purpose, plaintext, aad); decrypt(purpose, sealed, aad); keyIdOf(sealed) }`: the shape
`packages/adapters/src/auth/sealed-adapter.ts` declares plus `keyIdOf`, a subset of `KeyRing`) in its constructor; the web app passes the key ring
from `keyRingFromEnv` (`server/webmail/instance.ts` builds it today). Core imports no crypto. The repository
(`WebmailSettingsRepository`) gains:

```ts
imageSenderList(mailboxId: string, accountId: string): Promise<{ sealed: string; version: number } | null>;
imageSenderListVersion(mailboxId: string, accountId: string): Promise<number | null>;
/** Row-locked for the rest of the transaction; inserts an empty placeholder first, as `forwardingForUpdate` does. */
imageSenderListForUpdate(mailboxId: string, accountId: string): Promise<{ sealed: string | null; version: number }>;
saveImageSenderList(mailboxId: string, accountId: string, sealed: string, at: Date): Promise<number>; // new version
```

`server/webmail/image-senders.ts` holds the cache and calls the service; `server/webmail/settings.ts` gets the
route-facing methods behind `#pinned` (own mailbox, account pin).

**Routes.** All writes are BFF routes; the browser never sends a list. Each is own-mailbox only (`ownMailbox`; a
delegated tab gets 403 `own_mailbox_only` from the delegation gate), pinned with `X-Webmail-Account` (400 when
missing, refused when the active mailbox changed).

| Route                                        | Body                                                                        | What                                                                                                                                                                                                                                                                                                  | Tier      |
| -------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `GET /api/webmail/settings/image-senders`    | —                                                                           | `{ accountId, version, entries: [{ value, kind, display, added }], legacy: <count of old fingerprints>, state: "ok" \| "unreadable" \| "unavailable" }`                                                                                                                                               | `webmail` |
| `POST /api/webmail/settings/image-senders`   | `{ entry: string }` or `{ emailId: string }`                                | Add. `entry`: typed in Settings, validated (section 5). `emailId`: "Always for <sender>" from a message — the BFF reads that message's From and verification itself with the session's token and refuses (400) if not verified; it never takes an address from the browser for this path. Idempotent. | `write`   |
| `DELETE /api/webmail/settings/image-senders` | `{ entries: string[] }` (≤ 500) or `{ all: true }` or `{ emailId: string }` | Remove ("Stop loading from this sender" sends `emailId`; the BFF removes whichever entry matched it). `{ all: true }` also serves **Reset list** for an unreadable list. Idempotent.                                                                                                                  | `write`   |

Errors: an `emailId` the session's own mailbox can't see → 404 (never says whose it is; rule 25); an `emailId` of
an unverified message → 400 "Images from this sender can't be remembered because we couldn't confirm who sent it.";
a full list → 400 "Your list is full (500). Remove some entries first." (no silent eviction: the person sees the
list); adding to an `unavailable` list → 503 "Your list can't be changed right now." (never overwrite what we can't
read); a write to an `unreadable` list other than `{ all: true }` → 409 "Your list couldn't be read. Reset it first."

**One transaction per write, with its audit** (rule 46): `mutation()` opens the unit of work; inside it the service
calls `imageSenderListForUpdate` (row lock; the first write's placeholder insert is `ON CONFLICT DO NOTHING`, so two
first writes serialise on the same row), decrypts, applies the **delta** (add or remove, never "replace with the
browser's list"), validates, seals, `saveImageSenderList` (sets `sealed`, `version = version + 1`, `updated_at`) and
returns the audit meta; the audit row commits with it. Because changes are deltas applied under a row lock, two tabs
or two devices adding at once both keep their entry and there is no lost update, so no retry loop and no 409 for
concurrency. `version` is the optimistic token for readers: the cache compares it, the re-encryption job updates
only when it is unchanged, and the response carries it so an open Settings tab can tell its copy is stale (it
re-fetches on `version` mismatch and on window focus). Lock hold time is one decrypt and one encrypt of ≤ 256 KB
(well under a millisecond each).

Optimistic UI as for other instant settings (05-webmail.md "Settings"): the reader loads the images at once and saves
in the background; on failure it shows the error and leaves the message loaded.

### 7. Fingerprints already saved (keep both, migrate as they are seen)

Keys can't be reversed, so there is no bulk conversion. Both are read; keys drain into the list over time:

1. `imageSenders` (in `webmail_preference.prefs`) stays readable and keeps working exactly as today (the message route
   still sends `senderKey` for verified senders; the reader still loads when it's in the preference).
2. **When a legacy key matches** a message being read, the reader sends `POST /api/webmail/settings/image-senders
{ emailId }` once; the BFF recomputes the From and the key itself, adds the address to the list and removes the
   key from `imageSenders` **in the same transaction** (both rows are ours now, so no half-done state). Audited as
   `migrated`.
3. **Recovery when Settings opens:** while legacy keys remain, `GET …/image-senders` also matches them against the
   distinct From addresses of the mailbox's newest 2,000 messages (Inbox and Archive, `Email/query` + `Email/get
{ properties: ["from"] }` with the session's token, in memory only), recomputing `senderKey`; found addresses move
   to the list as in step 2 (audited `recovered`). At most once per mailbox per web process per hour. Nothing is
   stored about addresses that didn't match.
4. Settings shows the rest as "N senders saved before this list showed addresses. They'll appear here the next time
   you open mail from them." with **Forget them** (`PATCH …/preferences { imageSenders: [] }`, as today).
5. New saves never write keys. The `imageSenders` preference is dropped (normalise to `[]`, then remove the key from
   `@anhourmail/shared/webmail`) by a later change once production shows none left; it lives inside `prefs` jsonb,
   normalised on read, so no migration is needed and the drop is a code change only.

### 8. Delegated and shared mailboxes

- In a delegated or shared mailbox's tab the BFF reads **that mailbox's** list (resolved from the mailbox the
  delegation gate admitted, section 3.1). The display mode (`remoteImages`) stays the delegate's own preference, as
  today.
- Delegates **can't change** another mailbox's list: the write routes are own-mailbox only (403), and the reader in a
  delegated tab offers "Just this once" only — no "Always for", no "Stop loading". A person-less shared mailbox's list
  is therefore read-only in the webmail until the account-wide list (section 11) exists.
- A leaver's mailbox converted to a shared mailbox (ADR-0026) keeps its list: the row belongs to the mailbox.

### 9. Export and deletion

- **Webmail export** (ADR-0025, `server/webmail/export.ts`, the person exporting their own mailbox in the web
  process): the ZIP gains `image-senders.txt` — a comment line, then one decrypted entry per line — read through the
  service for the session's own mailbox, after the access gate like contacts.
- **Control-plane exports** (the worker's `data-export` job): never the sealed value and never decrypted entries. The
  personal export's preferences keep the legacy keys while they exist (as today) and add `imageSenderList: { entries:
<count>, exportedFrom: "webmail" }` so the archive says where the list is. The account export (Owner) never carries
  members' lists, not even counts per mailbox.
- **Deletion:** the row goes with the mailbox (`on delete cascade` from the purge in `repositories.ts`, and from
  `customer_account` on account deletion); a mailbox in its `deleting` grace period keeps its list so a restore
  brings it back. Backups keep sealed rows until they expire; they are unreadable without the ring.

### 10. Audit, logging, rate limits and roles

- **Audited in the same transaction** (rule 46): new action **`webmail.image_senders_changed`**, in the mailbox's
  account, actor the mailbox (`system` named by its address, as `webmail.preferences_changed`), target the mailbox,
  permission `mailbox.read`. Meta: `change` (`added` · `removed` · `cleared` · `migrated` · `recovered` · `reset`),
  `kind` (`address` · `domain` · `mixed`), `via` (`settings` · `message`), `entries` (count after the change),
  `changed` (count). **Never an address, a domain or the sealed value** (rule 48). A refusal in a delegated tab is
  audited `denied` with the delegate as actor through the same helper. Add the action to `../audit.md`; `check:audit`
  covers the service method.
- Logging: kinds, key ids and counts only. Add `entry`, `entries`, `imageSenders` and `sealed` to `REDACT_KEYS`.
- Rate limits: reads `webmail`, writes `write`; neither fails closed (no sending or abuse effect). No new tier;
  `../rate-limits.md` lists the routes.
- Roles: no RBAC matrix change (a webmail session acts as its mailbox). `../roles.md` gets one line saying the list
  is the mailbox's own and delegates can't edit it.

### 11. Shape for the later account-wide list (not designed here)

`ImageSenderMatch.source` is `"mailbox"` now and gains `"account"`. The matcher takes a list of sources
(`[{ source, addresses, domains }]`) and returns the first match, mailbox first. The account-wide list will be an
account policy managed in the console by Owners and User Administrators (new permission, audited per change,
visible to the account's admins), applied to every mailbox of the account, verified From only, and **stored the same
way**: its own table keyed by `account_id` (cascade from `customer_account`), sealed with purpose
`account.image_senders` and AAD `account_image_sender_list:<accountId>`, cached and version-checked like this one.
Whether it holds addresses or only domains, and whether a person can opt out, are that ADR's questions.

## Consequences

- People see, add and remove the senders whose images load. Our database holds the list only as ciphertext bound to
  its mailbox; a dump, replica or backup without `SECRETS_KEYRING` shows no addresses. Anyone holding both the
  database and the ring (the running web process, an operator with production secrets) can read it — the same trust
  boundary as webmail session tokens and TOTP secrets.
- The list depends only on our own stack: no Stalwart object to re-verify on upgrades, no mail-server quota use, and
  writes are transactional with their audit (better than the junk lists' write-then-audit).
- A message open with remote images from a verified sender costs one primary-key query; unverified mail and mail
  without remote images cost nothing.
- Losing a ring key that still has rows under it makes those lists unavailable (fail closed, no wipe offered). The
  re-encryption job must run before a key is retired.
- Matching moves from the browser to the server: the browser no longer needs the list to read mail.
- The list no longer "travels with the mailbox" to another server; it travels in the webmail export instead.

## Alternatives considered

- **JMAP File Storage in the mailbox** (`/.anhourmail/image-senders.json`, the first draft of this ADR) — probed on
  v0.16.27: worked with the session's own token, invisible to IMAP, `ifInState` and `alreadyExists` honoured. The same
  probe showed a customer could share any file with any other account (`FileNode/set { shareWith }`), so the
  maintainer is switching mailbox file storage off for every customer (2026-10-31). Dropped: the store no longer
  exists for customers.
- **Postgres with plain addresses** — simplest, but the database (and every dump and backup) would hold who people
  correspond with. Rejected.
- **A per-mailbox data key wrapped by the ring** — see section 2: no gain over AAD binding, more to rotate. Rejected.
- **A key in `webmail_preference.prefs`** — see section 1. Rejected.
- **Managed Sieve script settings line** (where the junk lists live) — written only with management credentials,
  shares the 95 KB script budget, every "Always for" click would recompile a delivery-critical script, and each message
  open would need a management read. Rejected.
- **An address book or contact group** — syncs to every phone over CardDAV as a strange book, counts against the
  contacts cap, its cards appear in suggestions. Rejected.
- **A hidden mailbox or a note email** — appears in every IMAP client's folder list. Rejected.
- **`x:AccountSettings`** — denied to customers on purpose (ADR-0020); not general storage. Rejected.
- **Browser storage** — not shared across devices, lost with the browser, not in the export. Rejected.
- **Caching decrypted lists in Redis** — Redis persists and is shared; plaintext would leave the web process. Rejected.

## Build plan (slices, each its own commits)

1. `packages/shared/src/senders.ts` (the moved `senderEntry`, `matchImageSender`; the IDN conversion stays
   server-side, `node:url`), types and `IMAGE_SENDERS`; junk lists switch to it (no behaviour change).
2. Migration (next free number) + schema + `migration.md` entry; repository methods in Postgres and memory adapters,
   contract tests (cascade on mailbox and account delete, cross-account ids return null).
3. Core: `Sealer` port, `WebmailSettingsService.imageSenders` / `changeImageSenders` with audit; audit action in the
   catalogue and `../audit.md`; `REDACT_KEYS`.
4. `server/webmail/image-senders.ts` (cache, version check, failure states); message route sets `imageSender`;
   `remote-images.ts` decisions read it (legacy key path kept).
5. Routes (GET/POST/DELETE), rate-limit rows.
6. Settings → Reading list UI (add field, list with remove, empty, unreadable and unavailable states, legacy line),
   loading skeleton; reader's "Always for" / "Stop loading" call the routes; delegated tab read-only.
7. Legacy migration (match-time and Settings recovery).
8. Export entry (webmail ZIP; count line in the personal control-plane export).
9. Docs and changelog.

## Tests

- **Unit** (`senders.test.ts`, `image-senders.test.ts`): parse defensive read, duplicate merge, 500 cap, over-size
  plaintext refused on write; `matchImageSender` exact address, exact domain, no subdomain, case and IDN (U-label vs
  A-label From), address beats domain; validator (quoted local part, `@domain`, too long, empty IDN); mixed-script
  display rule; cache hit on same version, re-read on new version, fail closed on repository error.
- **Unit** (core service, with the memory adapter and a real key ring): seal/unseal round trip; a sealed value moved
  to another mailbox's row fails (AAD); unknown key id → `unavailable`, tampered → `unreadable`; add to `unavailable`
  refused, Reset of `unreadable` works; two concurrent adds both kept; audit row in the same transaction with counts
  only (assert no `@` and no entry value in meta); cross-account mailbox id → not found; legacy migration removes the
  key and adds the entry atomically (a failure rolls back both).
- **Unit** (`image-proxy.test.ts`, `remote-images` tests): no `imageSender` when unverified, attached, no loadable
  images, or read failure; legacy key path still loads; Sent mail unchanged.
- **Unit** (routes): own-mailbox only (403 in a delegated tab, audited `denied`), pin mismatch 400, `emailId` of an
  unverified message 400, `emailId` not visible to the session 404, full list 400.
- **Integration** (real stack): migration applies; `sealed` in Postgres contains no entry substring; rows cascade on
  mailbox purge and account deletion; a delegated mailbox's tab reads that mailbox's list; the export ZIP contains
  `image-senders.txt`; a key-ring rotation (new active key) still reads old rows and writes new ones under the new id.
- **e2e** (`webmail-images.spec.ts`): add a domain in Settings → a verified message from it loads without asking; a
  forged (unverified) From from the same domain still asks; "Always for" from a message appears in an open Settings
  tab after focus; remove → asks again; legacy key migrates on open.

## Docs to update when built

`../05-webmail.md` "Remote images" and "Settings" (list, matching, legacy), `../07-security.md` "Standards" (new key
ring user; re-encryption job targets) and "Image proxy" (verified rule unchanged; storage), `../01-architecture.md`,
`../04-data-model.md` (`webmail_image_sender_list`; `imageSenders` legacy), `../migration.md`, `../audit.md` (new
action), `../rate-limits.md` (routes), `../roles.md` (delegates read-only), `../codemap.md`, `docs/public/webmail.mdx`
(the list, address vs domain, verified-only wording without protocol names), `docs/public/export-and-deletion.mdx`
(the export file), a changelog entry.

## Open questions

1. **Subdomains:** exact domain only (as the junk lists). Offer "and its subdomains" per entry later?
2. **Delegated tabs:** the mailbox's list read-only (this ADR) vs the delegate's own list; and whether the display
   mode should also follow the mailbox there.
3. **Recovery scan** (section 7.3): acceptable to read 2,000 From addresses in memory once an hour per mailbox to
   recover old saves, or migrate only when a message is opened?
4. **Personal control-plane export:** this ADR puts the decrypted list only in the webmail export (decryption stays
   in the web process) and a count in the personal export. If the personal export must be complete on its own, the
   worker would decrypt too (it already holds the ring for sealing archives); maintainer call.
5. **Re-encryption job:** still unbuilt for every key-ring user (`07-security.md`). Not a blocker for this ADR, but it
   must exist before the first production key rotation retires a key.
