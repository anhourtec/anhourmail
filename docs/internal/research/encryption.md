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
| **Disk / service encryption at rest** (BitLocker, LUKS, AES on storage) | Stolen disks, decommissioned hardware | **The provider** — the running service can read mail |
| **Per-user encryption at rest with a key derived from the password** (Purelymail model) | Provider staff and storage access while the user is offline | Derived from the user's password; the server sees the password at login |
| **Zero-access / user public-key encryption at rest** (Proton, Stalwart OpenPGP/S/MIME) | Provider, storage breaches, later legal demands for stored mail | **The user's private key, never on the server**. The server still sees each message in plaintext once, when it arrives |
| **End-to-end encryption** (OpenPGP/S/MIME between people) | Every server on the path | Sender and recipient devices only |

No hosted service that receives ordinary internet mail can avoid seeing an incoming message in plaintext at
delivery time: senders deliver plaintext over (hopefully) TLS. Zero-access protects mail **after** it is stored.

## 2. Provider comparison (verified facts only)

| | Gmail / Google Workspace | Microsoft 365 / Outlook | Purelymail | Fastmail | Proton Mail |
| --- | --- | --- | --- | --- | --- |
| TLS in transit | Yes; Google reports ~99% outbound / 100% inbound TLS [S1] | Yes | "All protocols (IMAP/SMTP/POP), webmail, and admin pages are SSL enabled"; delivery "uses SSL whenever possible" [S3] | TLS mandatory on all client connections, TLS 1.3 + PFS [S7] | Yes |
| MTA-STS | Supported for customer domains; Gmail honours enforced policies when sending [S2] | Supported | Not stated [S3] | Not stated in sources read | Not stated in sources read |
| DANE (outbound) | No public announcement found (2020 report: opportunistic TLS only) [S11] | On by default for Exchange Online outbound; inbound DANE now GA [S5][S12] | Not stated | Not stated | Not stated |
| At rest | Google-held keys (AES on storage) [S10]; Workspace CSE gives customer-held keys on Enterprise Plus / Education tiers only, not personal Gmail [S2] | BitLocker + service encryption with Microsoft-managed keys by default; Customer Key for tenant-held root keys [S4] | "All data is encrypted at rest"; mail content "encrypted with your password" (XSalsa20-Poly1305 / AES-128-GCM); can be configured so staff can't read mail without the password; search index may hold partial content (can be disabled) [S3][S8] | Encrypted disks; provider-held keys [S7] | Zero-access encryption of stored mail; incoming non-Proton mail is readable briefly before encryption [S9] |
| End-to-end | Workspace CSE (paid enterprise tiers); S/MIME | S/MIME, Purview Message Encryption | Not offered ("Serverside end-to-end encryption at time of delivery" listed under "What we don't do"); S/MIME planned [S3] | Not offered in its own apps (by choice) [S7] | Between Proton users; password-protected mail to others [S9] |
| 2FA | Yes (incl. security keys) | Yes | TOTP and security keys; no SMS; backup codes; app passwords with per-protocol scopes [S6][S8] | Two-step verification; passkeys [S7] | TOTP + U2F/FIDO2 keys (up to 4) [S13] |
| Login password over IMAP/SMTP | — | — | "IMAP and SMTP protocols currently send your password to our servers unencrypted" [S3] (meaning: not additionally protected beyond TLS) | — | Needs Bridge for IMAP |
| Open source | No | No | Not stated | Partly (JMAP, Cyrus) | Clients open source |
| Logs | — | — | System logs deleted after one month; event metadata [S3] | — | — |

Notes:
- Google and Microsoft encrypt everything at rest, but **with keys they hold**: the provider (and anyone who can
  compel it) can read mail. Customer-held keys exist only on enterprise tiers (Google CSE, Microsoft Customer Key —
  and Customer Key still lets the service process data; it is a compliance/key-control tool) [S2][S4].
- Purelymail's password-derived encryption is a real step beyond provider-held keys, but its docs list no
  MTA-STS/DANE, no open source, no audits, and no zero-access/public-key mode; S/MIME-at-delivery is "planned" [S3][S8].

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
- [S1] Gmail TLS share (Google Transparency Report, via): https://www.adaptivesecurity.com/blog/how-to-encrypt-email-gmail
- [S2] Google Workspace — MTA-STS and TLS reporting: https://knowledge.workspace.google.com/admin/gmail/advanced/about-mta-sts-and-tls-reporting ; Client-side encryption for Gmail GA: https://workspaceupdates.googleblog.com/2023/02/client-side-encryption-for-gmail-generally-available.html
- [S3] Purelymail — Security: https://purelymail.com/docs/security ; https://support.purelymail.com/support/solutions/articles/159000408882-security-at-purelymail
- [S4] Microsoft — Service encryption and key management: https://learn.microsoft.com/en-us/purview/microsoft-365-service-encryption ; Customer Key overview: https://learn.microsoft.com/purview/customer-key-overview
- [S5] Microsoft — How SMTP DANE works: https://learn.microsoft.com/en-us/purview/how-smtp-dane-works
- [S6] Purelymail — Two-factor authentication: https://purelymail.com/docs/twoFactorAuthentication
- [S7] Fastmail — Security: https://www.fastmail.com/features/security/ ; DPA Annex 2: https://www.fastmail.com/policies/dpa/annex2/ ; passkeys: https://www.fastmail.com/blog/introducing-passkeys/
- [S8] Purelymail — Features: https://purelymail.com/docs/features
- [S9] Proton — Zero-access encryption: https://proton.me/security/zero-access-encryption
- [S10] Google — Default encryption at rest: https://docs.cloud.google.com/docs/security/encryption/default-encryption (Google Cloud; Workspace has a separate whitepaper — Gmail specifics not confirmed on this page)
- [S11] RIPE DNS WG (2020), Google opportunistic TLS not DANE: https://ripe.net/ripe/mail/archives/dns-wg/attachments/20200409/2f7f8bc2/attachment.html — dated, unconfirmed for 2026
- [S12] Petri — Exchange Online inbound SMTP DANE with DNSSEC: https://petri.com/exchange-online-inbound-smtp-dane-with-dnssec-2/
- [S13] Proton — security keys: https://proton.me/support/de/2fa-security-key ; https://proton.me/blog/es-419/security-keys
- [S14] Stalwart — Encryption at rest: https://stalw.art/docs/encryption/ ; blog: https://stalw.art/blog/encryption-openpgp-smime/
- [S15] Stalwart — Managing encryption: https://stalw.art/docs/encryption/manage/

Unverified / to confirm: Gmail DANE status in 2026; Microsoft mandatory outbound DANE date; Purelymail MTA-STS
(absent from its docs, may still be deployed); Tuta, mailbox.org (Guard), Posteo (crypto mailbox) specifics came
only from community threads and are therefore left out of the table.
