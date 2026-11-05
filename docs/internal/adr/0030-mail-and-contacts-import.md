# ADR-0030: Mail and contacts import

**Status:** Accepted 2026-11-04 with the defaults below (design, not built). The questions for the maintainer are at the end with the default
this ADR builds if nobody answers.

- Related: ADR-0001 (Stalwart through its management API), ADR-0002 (tenancy in the control plane), ADR-0008
  (ports and adapters), ADR-0010 (audit), ADR-0014 (folders), ADR-0017 and ADR-0020 (scoped keys, credential split,
  management proxy, app passwords), ADR-0023 (act-as never reaches mail), ADR-0024 (throwaway credential minted by
  the operations key), ADR-0025 (mail export streamed from the person's own session; option B rejected), ADR-0027
  (verified senders); `../09-roadmap.md` Phase 5 "Migration: import mail and contacts"; `../05-webmail.md`
  "Contacts"; `../07-security.md` (rules 16 and 23); `../research/stalwart.md`; `../rate-limits.md`; `../audit.md`.

## Context

Paying customers moving a domain need their old mail and contacts on day one (roadmap Phase 5). The Phase 5 exit asks
for an IMAP import of a seeded source mailbox (folders, flags, dates, duplicates) and a vCard/CSV contacts import
that pass integration tests against the compose stack, resume after a worker restart, and leave no source
credentials behind.

The hard question is **how anything of ours writes into the destination mailbox**. None of the three management keys
can act inside a mailbox: the provisioning key has no `impersonate`; the operations key has `impersonate` but no mail
permissions; the audit key reads Sieve scripts only (ADR-0020 "Credential split"). That is deliberate and stays.

### What the pinned Stalwart v0.16.27 does (checked on the dev server, 2026-11-04; throwaway domain and account, destroyed afterwards)

An app password minted by the dev admin with `x:AppPassword/set { accountId }`, `expiresAt` ten minutes ahead, and
`Disable` of `imapFetch`, `imapStore`, `imapCopy`, `imapMove`, `imapExpunge`, `imapDelete`, `imapRename`, `emailSend`,
`pop3Authenticate` and every JMAP mail permission, on an account with the customer denials for folders
(`jmapMailboxCreate`, `jmapMailboxUpdate`, `imapAclSet`):

| Probe                                                                                   | Result                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMAPS `LOGIN` with the app password                                                     | OK. Post-auth capabilities include `UIDPLUS`, `LITERAL+`, `MULTIAPPEND`, `SPECIAL-USE`, `CREATE-SPECIAL-USE`, `CONDSTORE`, `QRESYNC`, `OBJECTID`, `QUOTA`, `STATUS=SIZE`, `ID`. |
| `CREATE "Imported/Old Stuff"` (nested, parent missing)                                  | OK (parent created). IMAP CREATE works where JMAP `Mailbox/set create` is denied to customers.                                                                                  |
| `APPEND` with `(\Seen \Flagged $Forwarded custom_kw)` and an INTERNALDATE in 2015       | `OK [APPENDUID …]`. Over JMAP: `receivedAt` 2015-02-03T10:00:00Z, keywords `$seen $flagged $forwarded custom_kw` (keywords lowercased), `messageId` kept.                       |
| The same message appended twice                                                         | Two messages. **Stalwart does not deduplicate.**                                                                                                                                |
| `UID SEARCH HEADER Message-ID "<id>"` (with and without brackets); JMAP `header` filter | **Nothing matches** on v0.16.27, while `SUBJECT`, `FROM`, `SENTON`, `LARGER` match. Message-ID can't be found by search: dedupe must read the destination's Message-IDs itself. |
| A 60 MB literal                                                                         | `BAD [PARSE] Literal exceeds the maximum request size of 52428800 bytes` (50 MiB).                                                                                              |
| `GETQUOTAROOT INBOX`                                                                    | Answers with the account quota (`STORAGE used limit`, KiB). Usage lagged the two appends (async).                                                                               |
| `UID FETCH` with `imapFetch` disabled                                                   | No reply; later commands on that connection got no reply either. A refused command must never be sent.                                                                          |
| JMAP session document with the app password (Basic)                                     | 200 (methods would be `forbidden`, ADR-0024).                                                                                                                                   |

Known from earlier ADRs: an app password with `authenticate` can be exchanged at `/api/auth` for an **account-wide**
OAuth token whose refresh grant outlives the credential (ADR-0024); credential permissions are enforced per protocol
(ADR-0020); revoking an app password cuts off an IMAP session signed in with it (`07-security.md`); customer accounts
can't create folders over JMAP but IMAP `CREATE` still works (`CUSTOMER_DENIALS`); JMAP uploads have a 50 MB
`uploadQuota` per window (`research/stalwart.md` "Limits"), which would throttle any bulk import over JMAP.

### Options for writing into the destination

| Option                                                                                                                     | Verdict                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. From the person's own webmail session (the ADR-0025 export pattern)                                                     | Rejected for mail: imports take hours to days, must resume after a worker restart, must run for admins' batch migrations and keep syncing during cut-over. A browser tab can't carry that. **Kept for contacts upload** (seconds, person present, already built for vCard).                                                                                                                       |
| B. A per-import **IMAP-only** app password minted by the web app's operations key at start, sealed for an importer process | **Chosen.** No new key scope, no mail at rest outside the mail server, resumable, works for batches. The credential is narrow (IMAP only), time-boxed (`expiresAt`), destroyed at the end, and the importer that holds it has no network route to Stalwart's HTTP listener (so not to `/api/auth`).                                                                                               |
| C. A new key with mail write scope for the worker                                                                          | Rejected: a standing credential that writes (and, with fetch for dedupe, reads) every mailbox, in a process that parses hostile remote input. Exactly what the credential split forbids.                                                                                                                                                                                                          |
| Destination over JMAP `Email/import` instead of IMAP `APPEND`                                                              | Rejected for writes: folder creation is denied over JMAP for customers (`shareWith` rides on it), the upload quota is 50 MB per window, Message-ID isn't searchable there either, and it needs the importer to reach Stalwart HTTP (where `/api/auth` lives). IMAP keeps one protocol on both sides, gives `APPENDUID`, keeps INTERNALDATE and keywords (verified), and needs only the mail port. |

ADR-0025 rejected a sealed throwaway credential for **export** because it would leave a copy of the mail at rest and a
credential exchangeable for an account-wide token in a worker for hours. Import differs on both: mail is streamed
message by message from source to destination in memory and never stored, and the credential is IMAP-only in a
container that can't reach `/api/auth` (NGINX doesn't expose it publicly either, `02-mail-infrastructure.md`).
ADR-0020's "hand the secret to a queue" alternative was rejected for **app passwords people use**; this credential is
never shown to anyone and is the job's own. Both ADRs get a dated "Update" note pointing here; neither decision changes.

## Decision

### 1. Mechanism

1. **A new process, the importer**, runs in its own container from the worker image (`apps/worker/src/importer.ts`,
   `npm run importer`; dev: started by `npm run dev` with labelled output). It holds **no Stalwart key** (the
   start-up check `credentialEnvProblems([], env)` refuses all three in production and the dev admin is refused
   there as everywhere). It needs Postgres, `SECRETS_KEYRING`, egress to the internet on TCP 993 and 143 only, and a
   route to Stalwart's **IMAPS mail port** only (`IMPORT_DESTINATION_IMAP=host:port`, TLS verified against the
   public client host name `CLIENT_ENDPOINTS` IMAP host via SNI). No route to Stalwart HTTP, the management proxy or
   Redis. The provisioning worker never runs import code; ESLint keeps `apps/worker/src/importer*.ts` off every
   `@anhourmail/stalwart-client` key client and keeps the rest of `apps/worker` off the IMAP adapter.
2. **The web app mints the destination credential in the request that starts (or resumes) an import**, with the
   operations key, under the mailbox's credential lock (`AppPasswordRepository.lockCredentials`, ADR-0024 §6):
   `x:AppPassword/set { accountId, create: { description: "AnhourMail import", expiresAt, permissions } }` where
   `permissions` is `importCredentialPermissions()` — `Disable` of every known and self-service permission except
   `IMPORT_CREDENTIAL_ALLOW`:
   `authenticate imapAuthenticate imapCapability imapId imapEnable imapNamespace imapList imapLsub imapStatus
imapSelect imapExamine imapCreate imapSubscribe imapAppend imapFetch imapSearch`. No STORE, COPY, MOVE, EXPUNGE,
   DELETE, RENAME, ACL, IDLE, POP3, SMTP, JMAP or DAV. `imapFetch` is needed only to read the destination folder's
   Message-IDs for dedupe (Stalwart can't search them, above); the importer fetches header fields only.
   `expiresAt` = start + `IMPORT.credentialDays` (7) or, with cut-over sync, + `IMPORT.syncWindowDays` (14).
   The secret is sealed at once (below) and never returned, logged or audited. If recording the import fails, the
   credential is destroyed again in the same request (the app-password pattern, ADR-0020 decision 2).
3. **Customer accounts get one more credential slot**: `CUSTOMER_APP_PASSWORD_QUOTA` 6 → **7** (five app passwords,
   the handoff's moment, one import). Existing mailboxes pick it up on their next `mailbox.ensure`; the deploy runs
   `job:mailbox-backfill`. One non-terminal import per mailbox (unique partial index), so one slot is enough.
4. **The importer copies over IMAP on both sides** with one library (§3): source `EXAMINE` (read-only) and
   `BODY.PEEK` so the source never changes; destination `CREATE`/`SUBSCRIBE`/`APPEND`. Mail lives in process memory
   one message at a time (≤ the per-message limit), never on disk, never in Postgres, Redis or logs.
5. **Destroying the destination credential** is a provisioning job `mail_import.credential_revoke` (subject: the
   import id) run by the worker with the **provisioning key** through `x:Account.credentials`
   (`revokeAppPasswordCredential(accountId, credentialId, createdAt)`, the existing revocation path), queued in the
   same transaction that ends the import. `expiresAt` is the backstop: Stalwart refuses the credential after it.
   Revoking also cuts off the importer's open IMAP session (verified behaviour for app passwords).

### 2. Secrets at rest (rules 16 and 23)

- **Source secret** (the old provider's app password): `mail_import.source_secret`, sealed with the key ring
  (`keyring.encrypt("mail-import-source", secret, "mail_import:<id>:source")`, AES-256-GCM, key id in the output).
- **Destination secret**: `mail_import.destination_secret`, `keyring.encrypt("mail-import-destination", secret,
"mail_import:<id>:destination")`.
- Both are **wiped (set to null) in the same transaction that makes the import terminal** — `completed`,
  `cancelled` or `failed` — together with `source_username`, and `credentials_wiped_at` is set. Cancel wipes them in
  the request itself, before the runner notices (the runner holds them in memory for at most the current message and
  can't reconnect). The hourly `job:import-expiry` wipes any terminal row that still has a secret (belt and braces)
  and ends paused or blocked imports whose destination credential has expired.
- The importer decrypts at the start of a slice and keeps the values in memory only for that slice. imapflow runs
  with `logger: false`; IMAP errors are mapped to our error codes, never logged raw (server text can contain the
  username). `REDACT_KEYS` gains `sourceSecret`, `destinationSecret`, `pass`, `accessToken`.
- Re-encryption (the planned key-rotation job) covers both columns.

### 3. Source IMAP client: `imapflow`, pinned **2.10.0** (MIT)

- One dependency: `imapflow@2.10.0` (MIT, Postal Systems; maintained, IMAP4rev2, CONDSTORE/QRESYNC, SPECIAL-USE with
  localized-name fallback, LITERAL+, XOAUTH2 via `accessToken`, `doSTARTTLS: true` to require STARTTLS, `readOnly`
  mailbox open, streaming downloads, `logger: false`). Transitive: `pino` 10.3.1, `libmime`, `libqp`,
  `libbase64`, `iconv-lite`, `encoding-japanese`, `socks` (all MIT) and `@zone-eu/mailsplit`
  (`MIT OR EUPL-1.1+`, passes the allowlist on MIT). `check:licenses` passes; `THIRD_PARTY_NOTICES.md` and
  `/credits` are regenerated in the same commit. It released four versions in the week before this ADR: pin exactly,
  review the diff on each bump, never range.
- Writing our own IMAP client was rejected: literals, mUTF-7 names, BODYSTRUCTURE and server quirks are a large,
  security-sensitive parser surface; the library is the boring choice.
- It lives only in the adapter folder `packages/adapters/src/imap/` (rule 38): `ImapSourceReader` and
  `ImapDestinationWriter` behind the core ports (§9). It is the only IMAP code in the repo besides the int-test helper
  `int-imap.ts`. Rule 21 holds: management calls stay in `stalwart-client` (the import credential's mint and permission
  set live there), JMAP stays in `jmap-client`; IMAP is a mail-app protocol, like a customer's mail app, and has one
  home.
- `proxy` and `transport` options are never set; `clientInfo` sends `{ name: "AnhourMail import" }` only.

### 4. Connecting to the source: TLS and SSRF guard

- **TLS always.** Port 993 = implicit TLS (`secure: true`); port 143 = STARTTLS required (`doSTARTTLS: true`; a server
  that doesn't offer it fails with `source_tls_required`). No other port (stops the importer being a port scanner).
  TLS ≥ 1.2, `rejectUnauthorized: true`, the system CA store, certificate checked against the host name the person
  typed. A self-signed or mismatched certificate fails with `source_certificate` and a message saying so.
- **Public addresses only, re-checked on every connect** (each slice and every reconnect): the guard in
  `apps/web/src/server/webmail/remote-image.ts` (`isPublicAddress`, `pinAddress`, the system resolver) moves to
  **`@anhourmail/server/net-guard`** (MIT, `packages/server/src/net-guard.ts`, with its tests); the image proxy
  imports it from there unchanged. The importer resolves the host, refuses if **any** answer is non-public or the name
  is internal-only (`localhost`, `.local`, `.internal`, `home.arpa`, no dot), and connects to the **pinned address**
  (`host: <ip>`, `servername: <name>`), so a DNS answer can't change between check and connect.
- Host names: ≤ 253 characters, IDN converted to punycode, no userinfo, no IP literals in private ranges (literals in
  public ranges are allowed, verified against the certificate like a name).
- **Development and tests only:** `IMPORT_DEV_ALLOW_SOURCES` (comma list of `host:port`) lets exactly those private
  addresses through and skips certificate verification for them (the dev Stalwart's certificate is self-signed,
  "rcgen self signed cert"); likewise `IMPORT_DEV_DESTINATION_INSECURE=true`. Both are **refused at start when
  `NODE_ENV=production`**. Unit tests prove the production path with an injected resolver and connector.

### 5. What gets copied

- **Planning (phase `verifying`, in the importer):** connect, `LIST` with special-use and `STATUS (MESSAGES UIDVALIDITY
UIDNEXT)`, total size from `STATUS=SIZE` where offered, else summed `RFC822.SIZE`; destination quota from
  `GETQUOTAROOT INBOX`. If the source is larger than the free quota the import is `blocked: quota_full` with both
  numbers; the person raises the mailbox's quota within the account's pool, excludes folders, or resumes anyway
  ("import what fits": stops cleanly at the first over-quota answer).
- **Folder mapping**, in order: (1) INBOX → INBOX; (2) RFC 6154 special-use from the server (`\Sent`, `\Drafts`,
  `\Junk`, `\Trash`, `\Archive`) → our role folders (Sent Items, Drafts, Junk Mail, Deleted Items, Archive); (3)
  imapflow's localized-name match for servers without SPECIAL-USE; (4) everything else kept as a custom folder with
  its hierarchy, delimiter translated to `/` (a `/` inside a source name becomes `-`). Virtual folders `\Flagged` and
  `\Important` are skipped. `\All` (an "all mail" folder on label-based providers) is copied **last, into Archive,
  deduplicated against the whole destination**, so mail that lives only there arrives once and everything else is
  skipped. Folder depth and count stay within the mail server's limits (`x:Email.maxMailboxDepth` 10,
  `maxMailboxes` 250, which Stalwart doesn't reliably enforce, ADR-0014), as shared facts `IMPORT.maxFolderDepth` and
  `IMPORT.maxFolders` counted together with the destination's existing folders: deeper levels are flattened into the deepest allowed parent as `Parent - Child`; folders beyond the count go into one `Imported`
  folder. Options at start: exclude Junk and Trash (default on), put custom folders under `Imported/` (default off).
- **Flags and dates:** INTERNALDATE → `APPEND` date (verified kept as `receivedAt`); `\Seen \Answered \Flagged
\Draft`, `$Forwarded`, `$MDNSent` and other valid keywords (atom, ≤ 64 characters, ≤ 20 per message) are kept;
  `\Recent` dropped; messages flagged `\Deleted` at the source are skipped; spam-training keywords (`$Junk`,
  `$NotJunk`, `Junk`, `NonJunk`) are dropped, since folder placement carries that meaning and Stalwart trains on
  them (slice 1 checks whether APPEND trains; if it doesn't, keeping them is a later choice).
- **Marker:** the importer prepends one header, `X-AnhourMail-Imported: <import id>`, to every message it appends.
  The webmail treats a message carrying it as **not verified by us** (`senderEvidence` in `sender-check.ts` returns
  no results and no internal marker), so a source mailbox can't plant mail that shows our own Authentication-Results
  or loads a safe sender's images (ADR-0027). Forging the header on ordinary mail only downgrades trust. The reader's
  "Original message" view says "Imported; these results come from the old provider".
- **Per-message limit:** `IMPORT.maxMessageBytes` = `ACCOUNT_POLICY.receiveMessageMb` (50 MB, under Stalwart's
  50 MiB request limit, verified). Larger messages are skipped and counted (`too_large`), per folder role.
- **Dedupe within the destination**, never by storing anything: before copying into a destination folder the importer
  reads that folder's `UID FETCH 1:* (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE FROM SUBJECT)])` into
  an in-memory set (rebuilt each slice). Key = the Message-ID without angle brackets and whitespace; for a message
  without one, SHA-256 of the raw `Date`, `From` and `Subject` values and the size. A source message whose key is in
  the set is skipped (`duplicates`); each appended message's key is added, so repeats within a source folder are
  skipped too. This also catches mail that reached the destination by forwarding during cut-over. For `\All` the set
  is the union over every destination folder.
- **Never at the source:** no STORE, EXPUNGE, DELETE, MOVE or flag change; `\Seen` stays as it was (`BODY.PEEK`,
  read-only open). Integration tests assert the source is byte-for-byte and flag-for-flag unchanged.
- **Imports never send mail** and never count toward sending limits (APPEND isn't submission). Delivery-time Sieve
  (forwarding, automatic replies) and spam filtering don't run on APPEND; slice 1 pins that in an int test.

### 6. Resumable runs, concurrency and throttles

- **Claiming:** the importer claims a `mail_import` row (not the provisioning queue, whose 5-attempt back-off and
  10-minute stale rule don't fit hours-long work): status `queued` or `running` with `run_after ≤ now` and no live
  lease, `FOR UPDATE SKIP LOCKED`, under a transaction-scoped advisory lock that also enforces the caps: at most
  `IMPORT.perAccountConcurrency` (2, a published fact) running per account and `IMPORT_GLOBAL_CONCURRENCY` (env,
  default 4) running in total; each importer process runs `IMPORT_PROCESS_CONCURRENCY` (env, default 2) at once.
- **Lease:** `lease_token` (fresh per claim) + `lease_until` = now + 2 min, renewed every 30 s; every checkpoint
  write is conditional on the token (a runner that lost its lease stops at once, the existing claim-token rule).
- **Slices:** a runner keeps a job at most `IMPORT_SLICE_MINUTES` (env, default 15), then checkpoints and releases it
  (`run_after = now`), so accounts take turns.
- **Checkpoints:** per source folder `uidvalidity` + `last_uid` + counters in `mail_import_folder`, written after
  every appended or skipped message, batched at most every 2 s or 20 messages. A crash between `APPEND` and the
  checkpoint re-reads that message on resume and the dedupe set skips it: **at-least-once copy, exactly-once result**.
  A changed `UIDVALIDITY` restarts that folder from UID 1 (dedupe again protects).
- **Throttles** so imports never slow the mail server: per job ≤ `IMPORT_MAX_MESSAGES_PER_SECOND` (default 20) and
  ≤ `IMPORT_MAX_BYTES_PER_SECOND` (default 10 MB/s), one source and one destination connection per job, sequential.
  These are capacity settings (env, ops repo), not abuse thresholds.
- **Pause / resume / cancel:** pause sets `pause_requested`; the runner stops at the next message boundary and sets
  `paused` (credentials kept until the credential expires). Resume clears it and, when the destination credential
  expires within 24 h or is gone, **mints a new one** (step-up; the old one's revoke is queued). Cancel is immediate
  in the request: status `cancelled`, secrets wiped, revoke queued, audit, one transaction.

### 7. Cut-over sync (new mail only)

- Option at start: "Keep copying new mail until I stop it" (default off). After the first full pass the import is
  `syncing`: `run_after` = now + `IMPORT.syncEveryMinutes` (30); each pass copies `UID > last_uid` per folder plus new
  folders, deduplicated as above.
- It stops when the person (or an admin with `.any`) clicks **Stop syncing**, or when the sync window ends
  (`sync_until` = start + 14 days, equal to the credential's expiry). Stopping runs one last pass, then `completed`
  and the wipe. The console shows "Your domain's mail now arrives here — stop syncing" once the mailbox's domain is
  active (MX verified); it doesn't stop by itself (a domain that was active before the import still benefits).
- The **forwarding helper** is public docs (per source: how to forward from the old account during the switch); dedupe
  makes forwarding and sync safe together.

### 8. Batch migration for admins (CSV)

- `POST /api/accounts/:accountId/imports/batch` (multipart, ≤ 256 KB, ≤ the account's mailbox count rows,
  `MAX_MAILBOXES`): columns `mailbox` (an address of a mailbox in this account), `source_host`, `source_port`
  (993 default), `source_username`, `source_password`, optional `exclude_junk_trash`, `sync`. Parsed in the request
  with the shared CSV parser (§10), **never stored**; each valid row's secret is sealed straight into its own
  `mail_import` row (with its own minted destination credential), all in one request; invalid rows come back as
  `{ row, code }` (no values echoed). Rows for a mailbox that already has an import → `import_running`.
- A `mail_import_batch` row groups them; the batch page shows per-row status, retries (resume) and a report CSV
  (`mailbox, status, messages, duplicates, too_large, failed, error`; cells starting like a formula get a `'`).

### 9. Interfaces (core ports, `packages/core/src/imports/`)

```ts
type SourceAuth = { kind: "password"; username: string; secret: string }; // later: { kind: "oauth2"; provider; accessToken }
type SourceEndpoint = { host: string; port: 993 | 143 };

interface MailSource {
  connect(endpoint: SourceEndpoint, auth: SourceAuth, signal: AbortSignal): Promise<SourceSession>;
}
interface SourceSession {
  folders(): Promise<SourceFolder[]>; // path, delimiter, specialUse + source, uidValidity, uidNext, messages, sizeBytes|null
  open(path: string): Promise<{ uidValidity: bigint }>; // read-only
  headers(afterUid: bigint, limit: number): Promise<SourceMessageMeta[]>; // uid, flags, internalDate, size, messageId|null, fingerprint
  body(uid: bigint, maxBytes: number): Promise<Uint8Array | "too_large">;
  close(): Promise<void>;
}
interface MailDestination {
  connect(address: string, secret: string, signal: AbortSignal): Promise<DestinationSession>;
}
interface DestinationSession {
  folders(): Promise<DestinationFolder[]>; // path, specialUse
  ensureFolder(path: string): Promise<void>; // CREATE (parents) + SUBSCRIBE; idempotent
  index(path: string): Promise<Set<string>>; // dedupe keys of the folder
  append(path: string, raw: Uint8Array, flags: string[], internalDate: Date): Promise<"ok" | "over_quota" | "rejected">;
  quota(): Promise<{ usedBytes: number; limitBytes: number | null }>;
  close(): Promise<void>;
}
interface ImportCredentialIssuer {
  // web app only (operations key); under the mailbox credential lock
  mint(stalwartAccountId: string, expiresAt: Date): Promise<{ id: string; createdAt: Date; secret: string }>;
  destroy(stalwartAccountId: string, id: string): Promise<void>; // clean-up when recording fails
}
```

Adapters: `packages/adapters/src/imap/` (imapflow), in-memory fakes `packages/adapters/src/memory/imports.ts` with
contract tests shared by both. `stalwart-client` gains `IMPORT_CREDENTIAL_DESCRIPTION`, `importCredentialPermissions()`,
`createImportCredential()` and `isImportCredential()`. Services: `startImport`, `startImportBatch`, `pauseImport`,
`resumeImport`, `cancelImport`, `stopImportSync`, `listImports`, `getImport`, `getImportBatch` (each takes the actor
and checks permission and scope itself); the runner `runImportSlice(deps, claim)`; `expireImports`,
`notifyFinishedImports`.

### 10. Contacts

- **Upload, in the webmail, from the person's own session** (the existing `POST /api/webmail/contacts/import`, ADR-0025
  pattern): no job, no credential, nothing at rest. Extended to:
  - **vCard 3.0/4.0** (today's `parseVcards`; 2.1 quoted-printable values are decoded too) and **CSV**;
  - limits raised to **5 MB and 5,000 cards** per file (`IMPORT.contactsMaxBytes`, `IMPORT.contactsMaxCards`), still
    capped by the 5,000 cards per mailbox;
  - **CSV**: a pure RFC 4180 parser in `packages/shared/src/csv.ts` (no dependency; quoted fields, embedded
    newlines, `,` `;` or tab delimiter detected from the header line, UTF-8 with or without BOM, UTF-16 with BOM;
    other encodings refused with "save it as UTF-8"). **Column auto-detect** by normalized header name
    (`IMPORT_CSV_COLUMNS` in shared: given/first name, surname/last/family name, full/display name, e-mail and
    "E-mail N", phone/mobile/home/business and "Phone N", company/organization, notes, birthday, categories/groups/
    labels). The browser parses the first rows for a **preview with the detected mapping**, which the person can
    change per column (or ignore); the BFF re-parses the whole file with the submitted mapping (never trusts the
    preview).
  - **Merge by email:** every card's addresses are matched case-insensitively against existing cards' `emails` (read
    in 500-card batches; the `email` query filter lags, `research/stalwart.md`) and against earlier cards in the same
    file. A match **fills only empty fields** (extra addresses, phones, organisation, notes, birthday, labels) and
    never overwrites or deletes; no email → skipped when a card with the same full name and the same phone exists.
    Written with `ContactCard/set` in batches of 100 to My contacts. Answer: `{ created, merged, duplicates, invalid,
overCap }`.
  - Audited `data.contacts_imported` (counts and format only) in the mailbox's account, as `data.mail_exported` is.
- **CardDAV source and providers' contacts APIs: later**, with OAuth (§11). Every contacts app exports vCard today;
  a CardDAV source needs a DAV client, an HTTPS SSRF guard and a destination credential with `dav` scope, which isn't
  worth it before the beta.

### 11. OAuth import from large hosted providers: pluggable now, built later

- The design is pluggable: `SourceAuth` is a union; `mail_import.source_kind` is text (`imap_password` today); the
  IMAP adapter passes `accessToken` (XOAUTH2) when the kind is `imap_oauth`; presets carry `oauth: null`.
- **Not built in Phase 5.** It needs maintainer-registered OAuth applications per provider (client id and secret in
  `.env` / the ops repo, never in this repo), redirect URIs on `app.`, each provider's app verification, and for at
  least one large provider's full-mail scope a periodic third-party security assessment — work and cost outside the
  code. Tokens would be sealed like the source secret, revoked at the provider and wiped when the import ends.
- Consequence to accept: a large provider's business mailboxes no longer accept password IMAP, so those customers can't
  import until OAuth lands; the docs say so plainly. Everyone whose provider offers app passwords can import now.

### 12. Data model (one migration, next free number at build time; **Safe**, additive)

- `mail_import`: `id` uuid, `account_id` (→ `customer_account`, cascade), `mailbox_id` (→ `mailbox`, cascade),
  `batch_id` (→ `mail_import_batch`, set null), `requested_by` (→ `auth_user`, set null), `requested_as`
  (`own`/`admin`), `source_kind` text (`imap_password`), `source_host`, `source_port`, `source_username` (null after
  the wipe), `source_secret` (sealed, null after the wipe), `destination_secret` (sealed, null after the wipe),
  `destination_credential_id`, `destination_credential_created_at`, `destination_credential_expires_at`, `options`
  jsonb (`excludeJunkTrash`, `intoSubfolder`, `sync`; zod-validated), `status` (`queued`/`running`/`paused`/
  `blocked`/`syncing`/`completed`/`cancelled`/`failed`), `phase` (`verifying`/`copying`), `blocked_reason`
  (`quota_full`/`source_auth`/`source_unreachable`/`source_certificate`/`source_tls_required`/
  `destination_credential`/`mailbox_unavailable`), `error_code`, `pause_requested`, counters (`folders_total`,
  `messages_total`, `bytes_total`, `messages_done`, `bytes_done`, `duplicates`, `too_large`, `failed`),
  `lease_token`, `lease_until`, `run_after`, `attempts` (consecutive transient failures), `sync_until`,
  `last_pass_at`, `created_at`, `started_at`, `finished_at`, `credentials_wiped_at`, `notified_at`. Unique partial
  index on `mailbox_id` where status isn't terminal; index on (`status`, `run_after`).
- `mail_import_folder`: `id`, `import_id` (cascade), `role` (null/`inbox`/`sent`/`drafts`/`junk`/`trash`/`archive`/
  `all`), `source_path` (sealed, purpose `mail-import-folder`, AAD `mail_import_folder:<import id>`; **null after the
  import ends**, so finished history keeps roles and counts only), `uidvalidity` bigint, `last_uid` bigint,
  `messages_total`, `messages_done`, `duplicates`, `too_large`, `failed`, `bytes_done`, `status`
  (`pending`/`copying`/`done`/`skipped`), `updated_at`. The importer decrypts the paths of one import to map folders
  on resume; the console decrypts them for the progress list while the import runs.
- `mail_import_batch`: `id`, `account_id` (cascade), `created_by` (set null), `rows`, `created_at`.
- No mail content anywhere (rule 24): no subjects, Message-IDs or senders; folder names only sealed and only while
  running. `04-data-model.md` and `migration.md` updated in the same change. Rollback: drop the three tables (import
  history is lost; nothing else depends on them).

### 13. Roles (`packages/shared/src/rbac`, `roles.md`, RBAC harness, e2e role journeys)

| Permission           | Scope   | Who                                                    | What                                                                                                                                                         |
| -------------------- | ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mailbox.import.own` | account | Owner, Domain Admin, User Admin, Billing Admin, Member | Start, see and control imports into mailboxes whose person is them                                                                                           |
| `mailbox.import.any` | account | Owner, User Admin (**critical**)                       | The same for any mailbox in the account (an Owner's or admin's mailbox: Owners only, the `mailbox.manage` rule), shared and person-less mailboxes; CSV batch |

- Starting, resuming (it mints) and batch need a **fresh step-up** (`stepUpFresh`), as app passwords do. Never while
  acting as someone (**403** `act_as`, checked first; the Auditor role staff hold has neither permission anyway).
  Never in an account waiting for deletion (403 `account_deleting`) or a suspended account. Mailbox not active,
  suspended, deleting, or owing its first-sign-in password change → **409** `mailbox_unavailable`. Another account's
  mailbox or import id → **404**. Pause, cancel and stop-sync need the same permission as starting, no step-up (safe
  direction).
- An admin starting an import into someone else's mailbox emails that person at once (who, when, from which host), and
  the person sees it on their own import page (rule 49 in spirit).
- "Make this a user", mailbox suspension and mailbox deletion cancel a running import into that mailbox in the same
  transaction (`cancelled`, reason in meta, wipe, revoke queued). The importer also re-checks the mailbox access gate
  at each slice start and every 500 messages (`blocked: mailbox_unavailable`).
- Contacts upload is the webmail session's own mailbox only (no new permission); refused for a delegated mailbox
  (ADR-0026).

### 14. Audit (catalogue `packages/core/src/audit/catalogue.ts`, `audit.md`)

`data.import_started` and `data.import_finished` already exist in the catalogue; this adds the rest of the family. All
in the mailbox's account log, metadata only: import id, mailbox id, source host and port, options, counts, sizes,
codes. **Never** the source username, any secret, folder names, subjects or Message-IDs.

| Action                          | Actor                | Result / meta                                                                                                                                     |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data.import_started`           | person               | success; denied `act_as`/`not_found`/`mailbox_unavailable`/`import_running`/`account_deleting`/matrix refusal; failed `credential_mint`           |
| `data.import_paused`            | person               | success                                                                                                                                           |
| `data.import_resumed`           | person               | success (meta `credentialRenewed`)                                                                                                                |
| `data.import_cancelled`         | person or system     | success (meta `reason`: `person`/`mailbox_handover`/`mailbox_suspended`/`mailbox_deleted`)                                                        |
| `data.import_blocked`           | system               | failed (meta `reason`)                                                                                                                            |
| `data.import_sync_stopped`      | person or system     | success (meta `reason`: `person`/`window_ended`)                                                                                                  |
| `data.import_finished`          | system               | success (counts) or failed (`error_code`)                                                                                                         |
| `data.import_credentials_wiped` | system               | success (meta `sealedCleared`, `credentialRevoked`); failed when the revoke job gives up (alert, `platform.provisioning_failed` as other jobs do) |
| `data.import_batch_created`     | person               | success (meta `rows`, `valid`, `invalid`)                                                                                                         |
| `data.contacts_imported`        | system (the mailbox) | success (meta `format`, `created`, `merged`, `duplicates`, `invalid`, `overCap`)                                                                  |

Every status change and its audit row commit together (rule 46); the runner's checkpoint writes aren't audited
(progress, not mutations of intent).

### 15. Rate limits (`rate-limits.md`, `LIMITS`)

| Tier            | Limit                                                                        | Fail mode  | Routes                                                                                       |
| --------------- | ---------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `importStart`   | 10 / hour per user; inside the handler 30 / day per account (`enforceLimit`) | closed     | `POST …/imports`, `POST …/imports/:importId/resume`                                          |
| `importBatch`   | 3 / hour per user                                                            | closed     | `POST …/imports/batch`                                                                       |
| `write`         | (existing)                                                                   | open       | `POST …/imports/:importId/{pause,cancel,stop-sync}`                                          |
| `read`          | (existing)                                                                   | open       | `GET …/imports`, `GET …/imports/:importId`, `GET …/import-batches/:batchId` (and its report) |
| `webmailUpload` | (existing)                                                                   | (existing) | `POST /api/webmail/contacts/import`                                                          |

Both new tiers fail closed: each start mints a mail-server credential.

### 16. Worker, scheduler and importer jobs

- **Importer** (new container): claims and runs import slices (§6). Heartbeat file like the worker's.
- **Worker** (provisioning queue): new kind `mail_import.credential_revoke` (provisioning key, credential lock,
  matches id **and** creation time; 5 attempts then `platform.provisioning_failed` + `data.import_credentials_wiped`
  failed; Stalwart's `expiresAt` still ends it).
- **Scheduler:** `job:import-expiry` (hourly: terminal rows with a secret → wipe; paused/blocked past the credential's
  expiry → `failed: expired` + wipe + revoke; syncing past `sync_until` → stop), `job:import-notify` (every minute:
  finished imports with `notified_at` null → summary email). The **reconciler** treats a credential as an import
  credential only when description, exact permissions **and** a matching non-terminal `mail_import` row
  (`destination_credential_id` + created time) all agree; an expired or orphaned one is reported as drift and its
  revoke queued (never deleted silently).
- **Summary email** (transactional, our own domain, rule 62 allows it): to the person who started it and, for an
  admin-started import, the mailbox's person — counts per role ("Inbox 1,204 copied, 3 duplicates skipped"), "other
  folders" as one line, too-large and failed counts, how long it took, a link to the console. No folder names,
  subjects or addresses from the mail.

### 17. Console UI (`apps/web`, skeletons next to every page, rule 11)

- `/accounts/[accountId]/import` — "Import mail": the caller's imports (all of the account's for `.any`), status chips,
  progress bars, "New import", and for admins "Import many mailboxes (CSV)". Nav entry next to App passwords.
- `/accounts/[accountId]/import/new` — mailbox picker (own mailboxes, or any for admins), source preset
  (`IMPORT_SOURCE_PRESETS` in shared: provider name, host, port, the docs page for making an app password — naming
  providers is user-facing setup text, rule 57 exception — plus "Other IMAP server"), username, app password
  (write-only field), options, step-up in place. Explains that the old account isn't changed.
- `/accounts/[accountId]/import/[importId]` — live progress (polled every 5 s while open): phase, per-folder list by
  role with custom folders by (decrypted) name while running, counts, blocked reason with the fix (new source
  password, raise quota, resume), Pause / Resume / Cancel / Stop syncing, the cut-over banner.
- `/accounts/[accountId]/import/batch/new` and `/accounts/[accountId]/import/batch/[batchId]` — CSV upload with a
  template download, per-row validation result, per-row status, report CSV.
- Webmail **Contacts → Import**: file picker for `.vcf` or `.csv`; for CSV the column-mapping preview; the result
  counts.

### 18. Public docs (`docs/public/`, facts from `packages/shared`, rule 31)

`import/index.mdx` (what moves and what doesn't, limits, privacy: the old account is only read; credentials are deleted
when the import ends), `import/imap.mdx` (any IMAP server), one page per preset provider (making an app password,
IMAP host and port, quirks such as "all mail" folders; may name the provider as setup text), `import/contacts.mdx`
(exporting vCard/CSV from common apps, the mapping step, merge rules), `import/many-mailboxes.mdx` (admins' CSV),
`import/switching-a-domain.mdx` (forwarding helper, sync, MX change, stop syncing), a changelog entry, FAQ lines.
Limits shown come from `IMPORT` (per-message size, per-account concurrency, sync window, contacts caps).

### 19. Failure modes

| Failure                                      | Behaviour                                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Source login refused                         | `blocked: source_auth` at once (no retries, so the provider doesn't lock the account); resume with a new password re-seals it                  |
| Source unreachable / dropped / timed out     | Retry with back-off (1, 2, 4 … 30 min) up to 10 consecutive failures, then `blocked: source_unreachable`; a successful slice resets `attempts` |
| Source certificate or STARTTLS missing       | `blocked: source_certificate` / `source_tls_required`; never downgraded                                                                        |
| Source throttles downloads                   | Treated as a drop; back-off; the person sees "the old provider is slowing the copy"                                                            |
| Destination refuses login                    | `blocked: destination_credential`; resume mints a new credential                                                                               |
| Over quota (`APPEND` NO [OVERQUOTA])         | `blocked: quota_full` with numbers; nothing lost; resume after raising the quota                                                               |
| One message rejected by the destination      | Counted `failed`, continue; the role is in the summary                                                                                         |
| Message over the limit                       | Counted `too_large`, continue                                                                                                                  |
| Importer killed mid-message                  | Lease expires in ≤ 2 min; another runner resumes from the checkpoint; dedupe skips what was already appended                                   |
| Mailbox suspended / deleting / handed over   | `blocked: mailbox_unavailable`, or cancelled with the wipe for deletion and handover                                                           |
| Key ring can't decrypt (rotated key missing) | `failed: secret_unreadable`, wipe, revoke; ops alert                                                                                           |
| Revoke job gives up                          | Audited failure and alert; the credential expires by itself at `expiresAt`; the reconciler keeps reporting it                                  |
| Postgres down                                | The importer stops at the next checkpoint (it can't renew its lease) and exits non-zero; the container restarts                                |

### 20. Test plan

- **Unit (≥ 90 % core):** services — success, 403 matrix, 404 cross-account mailbox and import ids, 403 `act_as`,
  step-up required, 409 one active import per mailbox, 409 mailbox unavailable, 403 deleting account, credential
  destroyed when recording fails, audit rows in the same unit of work, secrets sealed with the right purpose and AAD
  and wiped on every terminal path; runner with the in-memory fakes — folder mapping (special-use, names, `\All`,
  depth and count limits), flags and dates, `\Deleted` skipped, spam keywords dropped, marker prepended, dedupe by
  Message-ID and fallback, duplicates inside one source folder, too large, over quota, UIDVALIDITY reset, lease loss,
  pause and cancel at a message boundary, throttles, slice release, sync passes; net guard (private/reserved ranges,
  mixed DNS answers, IDN, ports, internal names, the dev allow-list refused in production); CSV parser (quotes,
  newlines, delimiters, BOMs, encodings) and column auto-detect; contact merge rules.
- **Contract tests:** in-memory `MailSource`/`MailDestination` and the imapflow adapters pass the same suite.
- **Integration (compose stack, rule 19: no external network).** The dev Stalwart is the source: `npm run db:seed --
--demo` seeds `import-source@dev.test` over IMAPS (nested custom folders, a non-ASCII folder name, Sent/Drafts/Junk/
  Trash, `\Seen \Flagged \Answered $Forwarded` and a custom keyword, INTERNALDATEs in 2015, a duplicate Message-ID in
  one folder, a message without Message-ID, one message already present in the destination, a `\Deleted` one) and
  writes it into `credentials.md` (rule 50). `packages/adapters/src/imap/import.int.test.ts` runs the real core
  service with real keys (operations key mints, provisioning key revokes) and the importer against it, and asserts:
  folders, flags, dates, duplicates skipped, the source unchanged, the marker present; with a test-lowered size limit,
  a too-large message skipped. **Restart:** the importer runs as a child process, is `SIGKILL`ed after N appends,
  restarted, and the final destination has exactly the expected messages, no duplicates. **No credentials left:**
  both sealed columns null, `credentials_wiped_at` set, no import credential in `x:Account.credentials`, no secret in
  the captured log lines. **Incremental:** new source mail after the first pass is copied by the next pass, and a copy
  delivered to the destination over SMTP first is skipped. Stalwart behaviour pins (rule 22): APPEND keeps dates and
  keywords, doesn't run Sieve or spam training, Message-ID stays unsearchable (if an upgrade makes it searchable, the
  test says so), the import credential can't STORE/EXPUNGE/DELETE, POP3, SMTP or JMAP. Contacts:
  `apps/web/src/server/adapters/contacts-import.int.test.ts` — vCard 3.0 and 4.0, CSV (comma, semicolon, UTF-16 BOM)
  through the BFF into Stalwart, merge-by-email, the 5,000 cap.
- **RBAC harness:** every new route × role (incl. 404 cross-account, 403 act-as, 429 per tier).
- **e2e (local, `npm run test:e2e`):** a Member imports their own mailbox from the seeded source and sees it finish;
  a User Admin runs a two-row CSV batch; the webmail Contacts CSV import with a mapping change; light/dark, 1440/390.

## Consequences

- Customers can move mail from any IMAP server with an app password, keep folders, flags and dates, re-run safely,
  sync during cut-over, and import contacts from any contacts app — without us storing mail or holding a key that
  reads mailboxes.
- **A sealed, IMAP-only, read-and-append credential per active import exists in Postgres** for up to 7 days (14 with
  sync). With the database and the key ring an attacker could read that one mailbox over IMAP until the credential
  expires or is revoked, and, from inside the internal network, exchange it at `/api/auth` for an account-wide token.
  Accepted: the same theft already yields active webmail sessions' sealed tokens; the importer itself has no route to
  `/api/auth`; NGINX doesn't publish it; the credential dies at the end. `07-security.md` gets a threat-table row.
- Admins with `mailbox.import.any` cause a read-capable credential to exist on a member's mailbox; the person is told.
  (An admin can already reset that mailbox's password.)
- A new container (the importer) with internet egress on 993/143 — the first app process that connects to
  customer-chosen hosts besides the image proxy. The private ops compose gives it no route to Stalwart HTTP, the
  management proxy or Redis.
- One new dependency (imapflow and its tree) to watch.
- `CUSTOMER_APP_PASSWORD_QUOTA` becomes 7; the reconciler learns a third credential kind.
- Imported mail is never "verified by us" in the webmail (marker header).
- Re-verify on every Stalwart upgrade (rule 22): `import.int.test.ts`.
- Docs to update across the slices: `01-architecture.md` (importer row, its "must not"), `02-mail-infrastructure.md`
  (import credential), `04-data-model.md`, `05-webmail.md` (contacts import, imported marker), `07-security.md`
  (threat row, rules 16/23 entries), `08-operations.md` (importer container, egress, env), `codemap.md`, `roles.md`,
  `audit.md`, `rate-limits.md`, `migration.md`, `research/stalwart.md` (the probes above), ADR-0020 and ADR-0025
  "Update" notes, `deploy/` self-hosting guide, `AGENTS.md` (imapflow pinned), README "Works today".

## Alternatives

- **Import from the webmail session** (option A for mail): rejected above; kept for contacts.
- **Worker key with mail scope** (option C): rejected.
- **JMAP `Email/import` destination:** rejected above; kept in mind if Stalwart lifts the upload window and allows
  customer folder creation.
- **A ledger of imported Message-ID hashes in Postgres** for dedupe: misses mail that arrived by forwarding or other
  means, and keeps a per-message trace of people's mail in our database; reading the destination folder's headers
  at slice start is complete and stores nothing.
- **mbox/archive file upload** as a source: useful for providers without IMAP access; a later `MailSource` adapter
  (the upload would need sealed temporary storage — its own decision).
- **Deleting messages at the source after copying** ("move"): never; the old account stays untouched.

## Slice plan

Each slice ships with its tests, docs and handoff entry, in small commits (rule 3).

1. **Stalwart import credential and behaviour pins** — `stalwart-client`: `importCredentialPermissions`,
   `createImportCredential`, `isImportCredential`, `CUSTOMER_APP_PASSWORD_QUOTA` 7; int tests pinning the probes above
   plus "APPEND runs no Sieve / no spam training", the credential's refusals and revocation cutting the session;
   `research/stalwart.md`, ADR-0020 update note.
2. **Net guard to a package** — `@anhourmail/server/net-guard` (moved with its tests; image proxy re-imports), port
   rules for IMAP, the dev allow-list with its production refusal.
3. **Shared facts and roles** — `packages/shared/src/import.ts` (`IMPORT`, presets, CSV column aliases),
   `packages/shared/src/csv.ts` (parser), `mailbox.import.own` / `.any` in the matrix, `roles.md`, harness entries.
4. **Data model** — migration (three tables), Pg and in-memory repositories, contract tests, `04-data-model.md`,
   `migration.md`.
5. **IMAP adapter** — `imapflow@2.10.0` (licences, notices, `/credits`, `AGENTS.md`), `ImapSourceReader` and
   `ImapDestinationWriter` with guarded connect and TLS, unit tests with an injected connector, int tests against the
   dev Stalwart.
6. **Start and control** — core services (start, resume with re-mint, pause, cancel, stop sync, list, get), sealing,
   gates, audit actions, `importStart` tier, API routes, RBAC harness rows.
7. **Runner and importer process** — `runImportSlice` (planning, mapping, dedupe, checkpoints, leases, slices,
   throttles, failure modes), `apps/worker/src/importer.ts`, start-up env checks, `npm run dev` wiring, Dockerfile
   entrypoint; unit tests with fakes.
8. **Wipe, revoke and lifecycle hooks** — `mail_import.credential_revoke`, `job:import-expiry`, reconciler
   recognition, cancel on handover/suspension/deletion, `data.import_credentials_wiped`.
9. **Phase 5 exit test** — demo seed source mailbox + `credentials.md`, `import.int.test.ts` with kill/restart,
   no-credentials-left and incremental pass; `npm run stack:verify` untouched.
10. **Console pages and emails** — list, new, detail pages with skeletons; progress polling; summary email
    (`job:import-notify`) and the admin-started notice; e2e for a Member.
11. **Admin CSV batch** — `importBatch` tier, batch route and pages, report CSV, e2e for a User Admin.
12. **Webmail: imported marker and contacts** — `sender-check.ts` treats imported mail as unverified (with the
    original-message note); contacts CSV with mapping preview, vCard merge-by-email, raised caps,
    `data.contacts_imported`; contacts int test and e2e.
13. **Docs and ops** — public import guides and changelog, internal docs listed under Consequences, self-hosting
    guide and ops notes for the importer container (egress 993/143, IMAPS-only route, env), README.

**Update (2026-11-05): slices 1–5 built** (credential and pins, net guard, facts and roles, tables, IMAP adapter;
uncommitted at the time of writing). Where the build went beyond or differs from the text above:

- **APPEND trains the spam classifier** (slice 1's check, `research/stalwart.md` "Mail import over IMAP"): every
  appended message becomes an `x:SpamTrainingSample` — into Junk, or with `$Junk`, as spam; anywhere else as ham,
  whatever the keywords. There is no per-credential or per-command switch. The importer drops spam-training keywords
  (`IMPORT_DROPPED_KEYWORDS`) so a source can't mark Inbox mail as spam, but folder placement still trains, so an
  import feeds the classifier with mail from someone else's server. Answered in the run-64 update below (shared model;
  slice-7 prerequisite). The int test pins the behaviour so an upgrade that changes it is noticed.
- Refused commands: with the import credential `STORE`, `EXPUNGE`, `DELETE` and `RENAME` get no tagged reply (the
  server closes the connection or stays silent). After revocation an open session's next mail command gets no OK (on
  2026-11-04 a `NOOP` still answered once). Both pinned in `import-credential.int.test.ts`.
- `createImportCredential(accountId, expiresAt)` rounds the expiry **down** to whole seconds and returns the
  creation time Stalwart recorded; `isImportCredential` accepts a lifetime up to 14 days plus a minute.
- **Net guard API** (`@anhourmail/server/net-guard`): `isPublicAddress`, `pinHost`, `hostName` (normalisation),
  `guardTarget({ host, port }, { ports, allow })`, `parseDevAllowList(value, env, name)`. The allow-list overrides the
  address check for exact `host:port` pairs only; the port rule (993/143) still applies, so a dev importer on the host
  needs the dev server's IMAP ports reachable as 993/143 (the integration tests map them with a test-only
  `connectTo` hook; slice 7 decides the dev wiring).
- **The destination doesn't go through the public-address guard**: it is our own configured endpoint
  (`IMPORT_DESTINATION_IMAP`, an internal address), always implicit TLS, the certificate checked against the public
  IMAP host name; `insecureDevCertificate` (`IMPORT_DEV_DESTINATION_INSECURE`) throws in production.
- **Ports use numbers for UIDs** (IMAP UIDs are 32-bit); `uidValidity` and the folder checkpoint (`last_uid`) stay
  `bigint` as in §12.
- **Dedupe across our marker:** a copy carries `X-AnhourMail-Imported`, so its stored size is larger than the
  original's; the destination index subtracts the marker line before fingerprinting (`destinationDedupeKey`), so a
  message without a Message-ID copied in one slice is recognised in the next (int-tested).
- **Repository:** `MailImportRepository.end()` is the only way to a terminal status and wipes both secrets, the source
  username and every folder path in the same write; Postgres also enforces it (`mail_import_wiped` check). Claims run
  under one transaction-scoped advisory lock with `FOR UPDATE SKIP LOCKED`; "running" for the caps means "holds a
  live lease" (a `syncing` import keeps its status while a pass runs). `mail_import_folder` has a `created_at` (the
  order folders were recorded). The memory repository is `memory/mail-imports.ts` (§9's `memory/imports.ts` stays
  free for the source and destination fakes).
- **Presets:** `IMPORT_SOURCE_PRESETS` holds only "Other IMAP server" for now; provider presets (named as setup
  text) come with the public guides (§17–18).
- **CSV:** `parseCsv` keeps values exactly (a `+` phone number stays); `toCsv` / `csvCell` prefix formula-like cells
  with `'` for every CSV we write. `IMPORT_CSV_COLUMNS` and `detectCsvColumns` give the auto-detected mapping.
- `REDACT_KEYS` also gains `sourceUsername` and `sourcePath`. ESLint keeps `imapflow` inside
  `packages/adapters/src/imap` (the rest of the adapters package, core, apps and the worker can't import it).
- Migration **0041** (`0041_mail_import`), after ADR-0032's 0039 and 0040.

**Update (2026-11-05, run-64 pre-commit review of slices 1–5):** no confirmed vulnerability; hardening done in the
same change, and three items become conditions for later slices.

- **Done:** `createImportCredential` refuses an expiry in the past or more than `IMPORT_CREDENTIAL_MAX_LIFETIME_MS`
  ahead (SA-64-02). `claim()` and `end()` each run in their own transaction (a savepoint inside a unit of work) and the
  claim's UPDATE re-checks `status` and `lease_until <= at`; a contract test runs three claimers at once (SA-64-03).
  `sourceHost` joins `REDACT_KEYS`; the folder path AAD is now `mail_import_folder:<import id>:<folder id>` (SA-64-04).
  `destinationPath` refuses paths under `Shared Folders` or any other/shared namespace the server announces, ignoring
  case, and empty levels (SA-64-05).
- **Source host in finished history (decision, SA-64-04):** while an import is live the full host is kept (the
  importer needs it); the write that ends it keeps only the registrable domain (`finishedSourceHost`: the last two
  labels, three for `co.uk`-style suffixes; IP literals become `IP address`). Audit meta keeps host and port as §14
  says (metadata; the account's own admins see it).
- **Deploy gate (ops repo, before the importer runs anywhere):** the importer's network reaches only Stalwart's IMAPS
  port and public TCP 993/143; a connection from the importer container to Stalwart HTTP (`/api/auth`, the management
  listener, the management proxy) and to Redis **must fail** — checked by the deploy, not assumed — and the importer
  image runs with `NODE_ENV=production`, so the dev allow-list and the dev destination flag are refused at start.
  Threat T17 in `07-security.md`.
- **Spam training, answered:** `x:SpamClassifier` is one server-wide model with a per-account component; the samples an
  APPEND creates carry the account id and so train both (`research/stalwart.md`). The model is shared, so the reviewer's
  plan is a **slice-7 prerequisite**: (1) never APPEND into Junk — copy the source's Junk as an ordinary
  `Imported Junk` folder, or skip it (`excludeJunkTrash` stays on by default); (2) a narrowly scoped key that can only
  get and destroy `x:SpamTrainingSample` (`sysSpamTrainingSample{Get,Query,Destroy}`), behind the management proxy, so
  the importer's samples are removed when the import ends (an ADR-0020 key-split update and a rule-27
  `security-reviewer` pass); (3) per-import message caps below the trusted tiers until that removal exists. Ham samples
  from ordinary folders remain until (2) is built.
- **Slice-7 prerequisite (SA-64-01):** the webmail must treat a message whose topmost header is our import marker
  (`X-AnhourMail-Imported`) as not verified: `original.ts` (`ourAuthResultsHeader`, `authResults`) and
  `sender-check.ts` (`isInternalMail`) must not count a `Received` / `Authentication-Results` pair or the internal
  marker inside an imported message, since the old provider (or whoever wrote the source mailbox) controls every
  header below ours. Built and tested before the runner appends anything.

**Update (2026-11-05): the slice-7 prerequisites and slices 6–9 built** (uncommitted at the time of writing). Where the
build went beyond or differs from the text above:

- **SA-64-01 done:** `isImportedMail` in `apps/web/src/server/webmail/original.ts`: a message carrying our marker is
  never verified — `ourAuthResultsHeader`/`authResults` answer null and `isInternalMail` false, so `senderEvidence`,
  `fromVerified` and the image proxy's `senderVerified` see nothing of ours in it. A marker **anywhere** counts
  (look-alike spellings too), not only the topmost: one lower down was written by a sender and only downgrades that
  sender's own mail. Int-tested on the dev server (`apps/web/src/server/adapters/imported-marker.int.test.ts`): a
  forged `Received … by mail.dev.test` + `Authentication-Results: mail.dev.test … dmarc=pass` pair and an internal
  marker appended below ours over IMAP read back unverified; the same headers without our line would have passed; an
  APPEND adds nothing of the server's own above our marker. (The "Original message" note is slice 12.)
- **Spam training done (all three parts):** (1) never into Junk — `planFolders` (`packages/core/src/imports/folders.ts`)
  skips the source's Junk by default and otherwise maps it to the ordinary folder `Imported Junk`; a custom folder that
  would land on (or under) the destination's Junk goes under `Imported/`; the runner checks `isJunkDestination` once
  more before each folder. (2) **A fourth, training key** (`STALWART_TRAINING_KEY`, `svc-train`, `authenticate
impersonate sysSpamTrainingSample{Get,Query,Destroy}`; ADR-0020 update) held by the **queue worker**, not the
  importer: each importer slice that appended anything queues `mail_import.training_cleanup` (subject `<import id>:<from
ms>:<to ms>`, due a minute after the slice) in the transaction that gives the import back; the worker destroys that
  account's **ham** samples created in the window (± 2 min; `expiresAt − holdSamplesFor`, `STALWART_SPAM_SAMPLE_HOLD_MS`,
  default 180 days; a sample expiring later than the setting allows fails the job loudly). A runner that dies mid-slice
  queues nothing, so the next claim of that import (`claim()` now reports the abandoned lease) queues a backstop window
  `[lease end − lease − slice, lease end]`. Verified on the dev server with the real key: it finds and destroys exactly
  that account's ham samples of the window and can do nothing else. Trade-offs: the person's own ham samples created in
  a window (their own mail app's APPENDs, auto-learn on delivery) go too; spam samples never do. A model training run
  (`trainFrequency`, 12 h by default) that falls between an APPEND and its clean-up has already learnt from it (≤ about
  16 minutes per slice). (3) **Message caps by trust tier** of the person who started it
  (`IMPORT_MESSAGE_CAPS`, e.g. `new=<n>,standard=<n>,restricted=0`; per destination mailbox over a rolling 30 days
  since the run-65 review, SA-65-05, summed over its imports so restarting one can't reset it; required in production for `new`, `standard` and
  `restricted`; a tier not listed has no cap): at the cap the import ends `completed` with `error_code` `message_cap`.
  Trust tiers aren't assigned yet (everyone is `new`), so the `new` cap is the one that applies today.
- **Start and control (slice 6):** `packages/core/src/imports/service.ts` — `startImport`, `resumeImport`,
  `pauseImport`, `cancelImport`, `stopImportSync`, `listImports`, `getImport`; checks in the order act-as (403) →
  mailbox in scope (404) → own / `.any` (an Owner's or admin's mailbox: Owners only; 403 for people who see mailboxes,
  else 404) → source (`importSource`: 400) → fresh step-up (403) → account and credential locks with the role and
  mailbox read again → mailbox importable (409 `mailbox_unavailable`) → one live import (409 `import_running`) → mint →
  seal → insert; a failure after the mint destroys the credential. Outside production only the development allow-list
  (`IMPORT_DEV_ALLOW_SOURCES`, default the dev mail server: `127.0.0.1`/`localhost`/`import-edge` on 993/143) is
  accepted, at the web app and again at the importer, so dev and CI never reach a real provider. Resume renews the
  credential when less than a day is left (or it was refused) and queues the old one's revoke; it may take a new source
  password. Pause stops a running import at the next checkpoint; stop-sync moves the window to now (one last pass);
  cancel ends and wipes at once. Routes under `/api/accounts/:accountId/imports` (`GET`, `POST`, `GET /:importId`,
  `POST /:importId/{pause,resume,cancel,stop-sync}`); tiers `importStart` (10 / h per caller), `importStartAccount`
  (30 / day per account, counted only for callers who hold `mailbox.import.own` there) and `importBatch` (3 / h, for
  slice 11), all fail closed; HTTP 409 for `mailbox_unavailable`, `import_running`, `import_finished`. The admin-started
  notice email (`apps/web/src/server/imports.ts`) goes to the mailbox's person. **Audit metadata carries the source's
  registrable domain (`sourceDomain`), not the full host** (§14 said host): `sourceHost` is a redacted key, and the
  domain is what finished history keeps anyway.
- **Runner and importer (slice 7):** `runImportSlice` / `runNextImportSlice` (`packages/core/src/imports/runner.ts`) as
  §5–§6 and §19 describe; checkpoints after every message are batched (20 messages or 2 s), and a stop for any reason
  (slice end, pause, session error) writes the current folder first. After a kill, messages appended after the last
  checkpoint are found in the destination on resume and **counted as duplicates** (the result is exact; the counters
  shift by at most one batch). Session errors back off 1, 2, 4 … 30 min, 10 in a row block `source_unreachable`.
  `apps/worker/src/importer.ts` (`npm run importer`; `importer-config.ts` checks settings): no Stalwart key (and in
  production no `STALWART_URL`, `REDIS_URL` or the web app's grant keys), `IMPORT_DESTINATION_IMAP` required in
  production, the dev switches (`IMPORT_DEV_ALLOW_SOURCES`, `IMPORT_DEV_DESTINATION_INSECURE`,
  `IMPORT_DEV_SOURCE_PORTS`, `IMPORT_MAX_MESSAGE_BYTES`) refused there, lease `IMPORT_LEASE_SECONDS` (default 120,
  renewed every quarter). Dev: `npm run dev` runs it on the host (label `importer`); `docker compose --profile import
up -d importer` runs it from the worker image on `importnet` (internal, no internet) behind `import-edge`, which
  forwards only Postgres and the mail server's 993/143 — checked from inside the container: Stalwart HTTP, Redis,
  Postgres directly and the internet all unreachable. ESLint keeps `apps/worker/src/importer*.ts` off every Stalwart
  client and transport and the rest of `apps/worker` off `@anhourmail/adapters/imap`.
- **Wipe, revoke, lifecycle (slice 8):** `endImport` (`lifecycle.ts`) is the one way to a terminal status and queues
  `mail_import.credential_revoke`, whose subject is the import; the job takes **every** import credential off the
  mailbox's account except the one a live import of that mailbox holds, so it also serves a resume's replaced
  credential and an orphan. Suspending or deleting a mailbox and "Make this a user" cancel its live import in the same
  transaction (`data.import_cancelled` reasons `mailbox_suspended` / `mailbox_deleted` / `mailbox_handover`), and so do
  a staff, person or account-deletion hold (`holdMailboxes`, `mailbox_suspended`) and releasing a leaver's or a
  converted mailbox (`releaseMailboxOwner` from removing someone or "Convert to shared mailbox", `mailbox_released`;
  run-65 SA-65-01: the mailbox stays active there, so the importer's gate would never stop a leaver's sync). The
  importer's mailbox gate (`blocked: mailbox_unavailable`) remains the backstop for anything else. Ending an import
  that another runner holds (cancel, the sweep, a mailbox change) also queues a training-sample clean-up for what that
  runner may have appended, `[lease end − lease − slice, max(lease end, now)]` (SA-65-02): a terminal import is never
  claimed again, so the abandoned-lease backstop wouldn't fire. `job:import-expiry` (scheduler, hourly; `packages/core/src/imports/expiry.ts`) wipes terminal
  leftovers, fails paused or blocked imports past their credential (`expired`) and completes syncs past their window (a
  person-stopped sync gets an hour for its last pass). The reconciler (`reconcileAppPasswords`) lists import credentials
  apart (`credentialInventory().importCredentials`), expects one only when a live import recorded it (id and creation
  time), reports others as `importCredentialsOrphaned` and queues the latest import's revoke. The summary email
  (`job:import-notify`) stays with slice 10.
- **Phase 5 exit test (slice 9):** `packages/adapters/src/imap/import.int.test.ts` — the seeded source (nested and
  non-ASCII folders, Sent, Junk, flags and keywords, 2015 dates, a duplicate Message-ID, one without, a `\Deleted` one,
  one already in the destination), the real service and operations key, the importer as a child process SIGKILLed after
  three appends and restarted, exact destination contents, the source unchanged, revoke and training clean-up with the
  real provisioning and training keys (no import credential left, sealed columns and folder names null, the
  destination's ham samples gone and the source account's untouched), an incremental sync that copies only new mail and
  skips a copy delivered over SMTP first, and no secret, sign-in name or folder name in the importer's log. The demo
  seed's `import-source@dev.test` and its `credentials.md` entry are left for the console slice (10), since `db:seed`
  isn't run from here; the test seeds its own throwaway source.
- **No migration:** the windows ride on the job subject and the abandoned lease on the claim, so 0041 is unchanged.

**Update (2026-11-05, run-65 review of slices 6–9):** SA-65-01 and SA-65-02 fixed as described in the update above.
Maintainer decisions built as defaults: the message cap counts per destination mailbox over a rolling 30 days, summed
over its imports (SA-65-05); imported copies are never own Sent mail for images (SA-65-06, ADR-0027 update); config
examples show placeholders for cap values (SA-65-07). Hardening: the destination's folders in other or shared
namespaces are left out of `dest.folders()`, so role folders and the `\All` index never pick a delegated folder. Open
items recorded by the coordinator, not code: the importer's own key ring and database role (SA-65-03), the one-way
`holdSamplesFor` check (SA-65-04), and customers' own IMAP APPENDs training the shared model.

**Update (2026-11-05): slices 10–13 built** (uncommitted at the time of writing). Where the build went beyond or
differs from the text above:

- **Console (slice 10):** pages as §17, with one change of shape: the list page lives in a `(list)` route group so the
  batch pages' `mailbox.import.any` layout answers a real 403 (a parent `loading.tsx` would have streamed a 200 first).
  The detail page polls the import's `GET` every 5 s while it is live and visible; the list and batch pages refresh the
  server render on the same beat. A syncing import shows 100 % (its first pass is done; the source total also counts
  messages that are never copied, e.g. `\Deleted` ones). After the end, custom folders (names wiped) show as one
  "Other folders" row. `getImport` gains `domainActive` (the mailbox's domain is one of the account's own and
  `active`) for the cut-over banner; the free platform domain never shows it. `importTargets` lists the mailboxes the
  form offers, with why one can't take an import (`mailbox_unavailable`, `import_running`) and whether it has a person.
- **Presets:** `IMPORT_SOURCE_PRESETS` now names Gmail, Yahoo Mail, iCloud Mail and AOL Mail (published IMAP hosts, port
  993, a per-provider guide) plus "Other IMAP server" (setup text, rule 57's exception). Each has a `usernameHint`.
  Outside production a preset is still refused by the dev allow-list.
- **Texts as facts:** what each blocked reason means and its fix (`IMPORT_BLOCKED_TEXT`), what an end code means
  (`IMPORT_END_TEXT` / `importEndText`), role labels (`IMPORT_ROLE_LABELS`), the batch columns, row codes and their texts
  and the batch template live in `packages/shared/src/import.ts`, shared by the console, the summary email and the docs.
- **Summary email (`job:import-notify`, every minute):** `claimImportSummaries` claims each ended import with
  `markNotified` **before** sending, so two runs never send twice; a failed send is logged and not retried (the
  console has the result). Emails go for `completed` and `failed` only; **cancelled imports are claimed without an
  email** (the person cancelled it, or the mailbox change that cancelled it has its own notice). Counts per role with
  custom folders as one line, too-large and refused totals, duration, the end code's text; never folder names.
- **Batch (slice 11):** the body is the **raw CSV** (`text/csv`, capped at `IMPORT.batchMaxBytes` while reading),
  not multipart — the contacts upload's pattern. At most `MAX_MAILBOXES` rows (a flat bound, not the account's current
  mailbox count, so a file with a typo still gets per-row answers). Header names are matched case-insensitively,
  spaces and hyphens read as `_`, any column order; `source_port` defaults to 993; booleans `yes/no/true/false/1/0/y/n`
  or empty. File-level problems (encoding, missing columns, no rows, too many rows) are 400 **before** the step-up is
  asked for, so the admin fixes the file first. Row codes: `mailbox_not_found`, `duplicate_mailbox`, `forbidden` (a
  User Administrator naming an Owner's or admin's mailbox), `mailbox_unavailable`, `import_running`, `invalid_host`,
  `invalid_port`, `invalid_username`, `invalid_password`, `invalid_option`. No valid row: nothing recorded
  (`batchId: null`), the attempt still audited. Each started row is minted, sealed and recorded exactly as a single
  start (`createImport`, shared with `startImport`) and audited `data.import_started` (meta `batchId`) beside
  `data.import_batch_created`; a mint failure destroys every credential the request minted and records nothing. Each
  valid row is charged to the `importStartAccount` daily budget before anything is minted (run-66, below).
- **Contacts and the imported note (slice 12):** see `../05-webmail.md` "Contacts"; the reader's details and
  Original message say the results come from the old provider; contacts CSV (mapping preview, re-parsed by the BFF with
  `?columns=`) and vCard 2.1–4.0 merge by email with additions-only patches; a file over 5,000 cards is refused, not
  cut.
- **Demo and e2e sources:** the demo seed creates `import-source@dev.test` (filled once over IMAPS by
  `scripts/seed/import-source.ts`, 25 messages covering every case in §20); the e2e fixtures make one per browser
  project with the same content.

**Update (2026-11-05, run-66 review of slices 10–13):** fixed in the same change.

- **SA-66-01 (forged import marker):** the display of an imported copy — the "Imported" rows and the old provider's
  results on Original message, the reader's "Imported; not checked" — now needs the message's **first** header to be
  exactly our marker as the importer writes it (`X-AnhourMail-Imported: <import id>`, exact name, a UUID value;
  `isImportedCopy` in `original.ts`). A marker anywhere else, or a look-alike, still refuses verification and image
  trust (`isImportedMail`, SA-64-01 / SA-65-06 unchanged) but shows as not checked, never with results a sender wrote.
  The marker is also **removed from all SMTP mail** by the two Sieve system scripts in
  `packages/stalwart-client/src/sender.ts`: `sender-identity` (authenticated submissions, 465/587 and JMAP) and
  `inbound-headers` (port 25, `MtaStageData.script` for unauthenticated sessions) each `deleteheader
"X-AnhourMail-Imported"`. So the only way the header reaches a mailbox is our importer's APPEND (or a customer's own
  IMAP APPEND into their own mailbox, which only fools themselves). Verified on v0.16.27
  (`apps/web/src/server/adapters/import-marker-strip.int.test.ts`): the marker on top of a message sent to port 25 from
  outside and of one submitted on 587 (STARTTLS, signed in) is gone from the stored copy; before the scripts were
  reapplied and reloaded, both copies kept it. The scripts take effect on `ReloadSettings` (the dev plan applies and
  reloads them; production needs the same apply and reload with its next Stalwart bootstrap — an ops-repo step).
- **Rule 27, batch budget:** the batch charges `importStartAccount` once per valid row before anything is minted, only
  for callers who hold `mailbox.import.own` in the account (as a single start), fail closed; when fewer starts are left
  than valid rows the whole batch is refused with 429 (the check counts one, like a refused single start).
- **SA-66-04:** a row whose import can't be recorded after its credential was minted (e.g. another import of the
  mailbox landed in between) has that credential destroyed at once; the other rows go ahead.
- **SA-66-02 / SA-66-03 (contacts):** vCard quoted-printable soft breaks are joined once and stop growing past 8 KB per
  value (a 5 MB soft-break file parses in well under a second); the no-address duplicate check uses a set of
  full-name + phone-digit keys kept current as cards are created or merged, one lookup per phone instead of a scan.

## Questions for the maintainer (defaults this ADR builds)

1. **OAuth sources are deferred**, so business mailboxes at the largest provider that refuses password IMAP can't be
   imported in Phase 5. Default: defer; ship password IMAP; decide on registering OAuth apps once beta customers ask.
2. **Admins may import into members' mailboxes** (`mailbox.import.any`: Owners and User Admins, critical, step-up, the
   person emailed). Default: yes.
3. **Cut-over sync window 14 days**, stopped by hand, never automatically on MX. Default: as written.
4. **Free plan** may import into its own mailbox, within its quota. Default: yes (same code path, quota decides).
