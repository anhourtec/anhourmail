# Encryption and account security: what providers do, and what Stalwart can do

Date: 2026-10-21

Scope: how mainstream and privacy-focused mail providers protect mail in transit, at rest and at sign-in, and
what the pinned Stalwart v0.16.27 Community edition can deliver, **verified on the running dev server**.
Every claim is tagged `[Sn]`; URLs are in **Sources**. "Unknown" means the provider's own pages don't say.

---

## 1. Key terms (what "encrypted" actually means)

| Layer | What it protects against | Who holds the key |
| --- | --- | --- |
| **TLS in transit** (client ↔ server, server ↔ server) | Network eavesdroppers between hops | Each hop; message is plaintext on every server it passes through |
| **MTA-STS / DANE** | Downgrade/stripping attacks on server-to-server TLS | — (they make TLS mandatory and authenticated) |
| **Disk / service encryption at rest** (LUKS, provider storage encryption) | Stolen disks, decommissioned hardware | **The provider** — the running service can read mail |
| **Per-user encryption at rest with a key derived from the password** (a low-cost-provider model) | Provider staff and storage access while the user is offline | Derived from the user's password; the server sees the password at login |
| **Zero-access / user public-key encryption at rest** (privacy-focused providers, Stalwart OpenPGP/S/MIME) | Provider, storage breaches, later legal demands for stored mail | **The user's private key, never on the server**. The server still sees each message in plaintext once, when it arrives |
| **End-to-end encryption** (OpenPGP/S/MIME between people) | Every server on the path | Sender and recipient devices only |

No hosted service that receives ordinary internet mail can avoid seeing an incoming message in plaintext at
delivery time: senders deliver plaintext over (hopefully) TLS. Zero-access protects mail **after** it is stored.

## 2. Provider comparison (verified facts only, anonymised)

Providers are anonymised in this public doc (CLAUDE.md rule 57). The named version, with every source link, is kept
locally in `docs/internal/private/competitors/encryption.named-2026-10-22.md` (gitignored).

| | Provider A (large free provider + business suite) | Provider B (large business suite) | Provider C (low-cost) | Provider D (established JMAP provider) | Provider E (privacy-focused) |
| --- | --- | --- | --- | --- | --- |
| TLS in transit | Yes; reports ~99% outbound / 100% inbound TLS | Yes | "All protocols (IMAP/SMTP/POP), webmail, and admin pages are SSL enabled"; delivery "uses SSL whenever possible" | TLS mandatory on all client connections, TLS 1.3 + PFS | Yes |
| MTA-STS | Supported for customer domains; honours enforced policies when sending | Supported | Not stated | Not stated in sources read | Not stated in sources read |
| DANE (outbound) | No public announcement found (2020 report: opportunistic TLS only) | On by default outbound; inbound DANE now GA | Not stated | Not stated | Not stated |
| At rest | Provider-held keys (AES on storage); customer-held keys only on top enterprise / education tiers, not personal accounts | Disk + service encryption with provider-managed keys by default; tenant-held root keys as an option | "All data is encrypted at rest"; mail content "encrypted with your password" (XSalsa20-Poly1305 / AES-128-GCM); can be configured so staff can't read mail without the password; search index may hold partial content (can be disabled) | Encrypted disks; provider-held keys | Zero-access encryption of stored mail; incoming external mail is readable briefly before encryption |
| End-to-end | Client-side encryption (paid enterprise tiers); S/MIME | S/MIME, a proprietary message-encryption service | Not offered ("Serverside end-to-end encryption at time of delivery" listed under "What we don't do"); S/MIME planned | Not offered in its own apps (by choice) | Between its own users; password-protected mail to others |
| 2FA | Yes (incl. security keys) | Yes | TOTP and security keys; no SMS; backup codes; app passwords with per-protocol scopes | Two-step verification; passkeys | TOTP + U2F/FIDO2 keys (up to 4) |
| Login password over IMAP/SMTP | — | — | "IMAP and SMTP protocols currently send your password to our servers unencrypted" (meaning: not additionally protected beyond TLS) | — | Needs a paid local bridge for IMAP |
| Open source | No | No | Not stated | Partly (JMAP, Cyrus) | Clients open source |
| Logs | — | — | System logs deleted after one month; event metadata | — | — |

Notes:
- The large providers encrypt everything at rest, but **with keys they hold**: the provider (and anyone who can
  compel it) can read mail. Customer-held keys exist only on enterprise tiers, and even those let the service
  process data; they are compliance/key-control tools.
- Provider C's password-derived encryption is a real step beyond provider-held keys, but its docs list no
  MTA-STS/DANE, no open source, no audits, and no zero-access/public-key mode; S/MIME-at-delivery is "planned".

## 3. Stalwart v0.16.27 Community — verified on the dev server (2026-10-21)

### 3.1 Edition
The schema served by the running server (`GET /api/schema`) flags Enterprise objects explicitly. Enterprise-only:
`x:AiModel, x:Alert, x:ArchivedItem, x:MaskedEmail, x:MetricsStore, x:SpamLlm, x:Tenant, x:Trace, x:TracingStore`.
**`x:AccountSettings` (encryptionAtRest), `x:PublicKey`, `x:Email` (encryptAtRest), `x:MtaTlsStrategy`, `x:MtaSts`
and `x:MtaExtensions` (requireTls) carry no Enterprise flag → available in Community.** Docs agree [S14][S15].

### 3.2 Encryption at rest — end-to-end test (what was run, what was seen)
1. Created throwaway domain `crypto-probe.test` and user `probe@crypto-probe.test` (admin JMAP `x:Domain/set`,
   `x:Account/set`).
2. Generated a throwaway **S/MIME** certificate + RSA-2048 key with `openssl req -x509 … extendedKeyUsage=emailProtection`
   in a scratch directory. (OpenPGP via `gpg --batch` was attempted first; the agent socket path exceeded macOS's
   limit in the scratch dir, so S/MIME was used. Stalwart supports both [S14].)
3. **As the user (self-service, user's own credentials — no admin):** `x:PublicKey/set` create `{key: <PEM cert>,
   description, emailAddresses}` → created; `x:AccountSettings/set` update `singleton` with
   `encryptionAtRest: {"@type":"Aes256","publicKey":<id>,"encryptOnAppend":false,"allowSpamTraining":false}` → updated.
4. `alice@dev.test` sent a message over JMAP submission with the body marker `SECRET-BODY-MARKER-4471`.
5. As the probe user, fetched the stored message: `bodyStructure.type = application/pkcs7-mime`, `preview = null`;
   the raw blob downloaded via `/jmap/download/…` (2,108 bytes) **did not contain the marker**; headers **From, To
   and Subject remained plaintext**.
6. Search: `Email/query filter.text = marker` → **0 hits**; `filter.subject` → 1 hit (headers only are indexed).
7. `openssl smime -decrypt` with the user's private key (never given to the server) recovered the marker.
8. Cleanup: destroyed the account, its DKIM keys and the domain; deleted the scratch directory. Verified no
   leftover domain or public key.

Conclusions: per-user zero-access encryption at rest **works in Community**, is **self-service over JMAP**, uses the
user's **public** key only (no private key on the server), keeps **headers in clear** (subject, from, to, date),
disables **body search** server-side, and `encryptOnAppend` controls whether client-saved mail (Sent, Drafts via
IMAP/JMAP) is encrypted too. Algorithms (enum `EncryptionAtRestType`): `Aes128`, `Aes256` (OpenPGP + S/MIME),
`Aes256Gcm` and `ChaCha20Poly1305` (S/MIME only). Docs: disabling does not decrypt stored mail; enabling does not
re-encrypt old mail [S14][S15].

### 3.3 Transport security available
- **Client/server TLS versions:** enum `TlsVersion` has only `tls12` and `tls13` → TLS 1.0/1.1 are not possible at
  all. Listeners expose `tlsDisableProtocols` (can drop 1.2) and `tlsDisableCipherSuites` (enum `TlsCipherSuite`:
  TLS1.3 AES-256-GCM / AES-128-GCM / ChaCha20-Poly1305 and ECDHE-ECDSA/RSA AES-GCM/ChaCha20 for 1.2).
- **Outbound:** `x:MtaTlsStrategy` fields `startTls`, `dane`, `mtaSts` each `require | optional | disable`, plus
  `allowInvalidCerts`. **REQUIRETLS** (RFC 8689) is an advertised SMTP extension (`x:MtaExtensions.requireTls`).
- **Inbound policy publishing:** `x:MtaSts` singleton (`mode` enforce/testing/none, `maxAge`, `mxHosts`) and
  TLS-RPT (`x:TlsReportSettings`, `x:TlsExternalReport`).
### 3.4 Sign-in factors
- Schema has `x:OtpAuth` (TOTP: `otpUrl`, `otpCode`) on the password credential, app passwords (`x:AppPassword`
  with IP allow-lists, expiry, scoped permissions) and API keys. **No WebAuthn/passkey/FIDO object anywhere in
  the schema** → hardware keys/passkeys must be implemented in our console (better-auth) for the console login,
  and are not available for mail-protocol logins (those use app passwords).

## 4. What this means for AnhourMail
See `../12-encryption-and-security-posture.md` and ADR-0016.

## Sources
- Provider sources (A–E): see the named local copy in `docs/internal/private/competitors/` (gitignored).
- [S14] Stalwart — Encryption at rest: https://stalw.art/docs/encryption/ ; blog: https://stalw.art/blog/encryption-openpgp-smime/
- [S15] Stalwart — Managing encryption: https://stalw.art/docs/encryption/manage/

Unverified / to confirm: Provider A's DANE status in 2026; Provider B's mandatory outbound DANE date; Provider C's
MTA-STS (absent from its docs, may still be deployed). Other privacy-focused providers' specifics came only from
community threads and are therefore left out of the table.
