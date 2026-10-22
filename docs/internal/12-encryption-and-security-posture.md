# Encryption and security posture

Goal (maintainer, 2026-10-21): be **more secure than the low-cost providers we're priced against**, and honest about what each layer protects.
Evidence: `research/encryption.md` (provider comparison, Stalwart Community verified on the dev server).
Decision record: ADR-0016. Related: `07-security.md` (threat model, password storage), `02-mail-infrastructure.md`
(TLS/MTA-STS/DANE settings), `05-webmail.md` (zero-access UX).

## 1. Principles

1. **Say exactly what is encrypted, with which key, against whom.** Every public claim maps to a row in §8.
2. **Defence in layers:** transport (TLS everywhere, authenticated server-to-server), storage (disk + backups), and
   an opt-in **zero-access** layer where only the user's key can read stored mail.
3. **No keys where the data is.** Disk/backups keys are not on the same machine/medium as the data; zero-access
   private keys never reach our servers.
4. **Accounts are the real attack surface:** phishing-resistant sign-in (passkeys/security keys), visible sessions
   and sign-ins, per-device app passwords.
5. **Open source and verifiable:** the code that handles mail is public; the engine (Stalwart) runs unmodified.

## 2. In transit

| Path                                                                                | Baseline (launch)                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients ↔ AnhourMail (IMAP 993/143, POP3 995/110, SMTP 465/587, ManageSieve, HTTPS) | **TLS 1.2+ only** (Stalwart cannot negotiate 1.0/1.1 at all), TLS 1.3 preferred, AEAD cipher suites only (AES-GCM, ChaCha20-Poly1305), ECDHE forward secrecy                                                                                                                                      | Plain 143/110/587 accept credentials **only after STARTTLS**. Verified 2026-10-21 (ADR-0018): 143 `LOGINDISABLED`, 110 refuses USER/PASS, 25 refuses AUTH; 587 offered OAUTHBEARER/XOAUTH2 in clear text by default — removed (`saslMechanisms` only when `is_tls`), checked by `stack:verify`. |
| Web (console, webmail, site)                                                        | HTTPS only, HSTS (2 years, includeSubDomains, preload after a stable period), TLS 1.2+                                                                                                                                                                                                            | NGINX terminates.                                                                                                                                                                                                                                                                               |
| Inbound server → us                                                                 | **MTA-STS `enforce`** (after `testing` + clean TLS-RPT), **TLS-RPT**, **DANE** TLSA on `mx1` with a DNSSEC-signed zone                                                                                                                                                                            | `x:MtaSts`, `x:TlsReportSettings`. DANE needs DNSSEC (open item: DNS provider with DNSSEC).                                                                                                                                                                                                     |
| Us → other servers                                                                  | `MtaTlsStrategy`: `startTls: optional`, `dane: optional`, `mtaSts: optional` globally — which **enforces** TLS (and certificate validity) whenever the destination publishes MTA-STS or DANE; opportunistic otherwise. **REQUIRETLS** (RFC 8689) advertised so senders can demand TLS end-to-end. | Requiring TLS everywhere would bounce mail to legacy servers; `require` is used per destination policy, which is what MTA-STS/DANE express. Reported via TLS-RPT.                                                                                                                               |

Better than the low-cost provider we compared: its docs state only "SSL … whenever possible" and list no MTA-STS/DANE/REQUIRETLS.

## 3. At rest (provider side)

| Data                                  | Protection                                                                                                                                                  | Key holder                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Mail store (Stalwart RocksDB / blobs) | Full-disk encryption (LUKS2, AES-XTS) on the mail volume; unlocked at boot from a key **not stored on that disk** (remote unlock / sealed in the ops vault) | Anhourtec ops                                       |
| Backups                               | Encrypted client-side before upload (e.g. restic/age with a key held offline), off-server, versioned; monthly restore drill (`08-operations.md`)            | Anhourtec ops — backup key never on the mail server |
| Control-plane Postgres                | Disk encryption + no mail content (rule 24); third-party secrets AES-256-GCM with key ring (rule 16)                                                        | Anhourtec ops                                       |
| Passwords                             | argon2id only (console in Postgres; mailbox passwords sent to Stalwart as PHC strings) — `07-security.md`                                                   | n/a (one-way)                                       |
| Logs                                  | No mail content, subjects or recipient lists (rule 24); short retention                                                                                     | —                                                   |

This layer protects against stolen hardware and leaked backups. It does **not** stop a running server (or someone
who compels us) from reading mail — that is what §4 is for.

## 4. Zero-access mode (opt-in, per user) — verified working on Stalwart Community

**What it is:** the user registers an OpenPGP public key or S/MIME certificate; from then on Stalwart encrypts each
incoming message **with the user's public key before it is written to disk**. The private key stays on the user's
devices. Verified end-to-end on v0.16.27 Community (`research/encryption.md` §3.2), and **re-verified in Phase 1
(2026-10-21) as a self-service flow**: authenticated as the mailbox user (not an admin), `x:PublicKey/set` (S/MIME
certificate) then `x:AccountSettings/set {encryptionAtRest: {"@type":"Aes256", publicKey, encryptOnAppend: true,
allowSpamTraining: false}}`; a message delivered over SMTP 25 was stored as `application/pkcs7-mime` — the Subject
header stayed readable, the body marker was absent from the stored blob fetched via `/jmap/download`, and
`openssl smime -decrypt` with the user's private key recovered it. This becomes an automated integration test when
the BFF exposes the setting (Phase 4).

**Honest trade-offs (shown to users before they turn it on):**

- The server still sees each message **once in plaintext at delivery** (unavoidable for mail from the internet).
- **Headers stay readable** (From, To, Subject, Date) — needed for routing, threading and listing.
- **Server-side search covers headers only**; body search happens on the device (webmail indexes decrypted
  bodies in IndexedDB, encrypted with a device key).
- Spam training on encrypted mail is off (`allowSpamTraining: false`) — filtering still runs **before** encryption.
- **Losing the private key = losing the mail stored while encrypted.** Recovery: the key is the user's
  responsibility; we offer (a) exporting an encrypted key backup protected by a passphrase, (b) a printed recovery
  sheet. We never escrow keys.
- Turning it off doesn't decrypt old mail; turning it on doesn't encrypt old mail (we offer a one-off
  "encrypt existing mail" job later, run with the public key only).
- IMAP/POP clients receive the S/MIME/PGP-encrypted messages: desktop and phone mail apps with S/MIME or OpenPGP
  support decrypt locally with the user's key.

**Product shape:**

- Plus/Supporter feature at launch of webmail v1.1; Free later.
- Setup wizard in the console: generate an OpenPGP key **in the browser** (OpenPGP.js; key never uploaded), download
  the passphrase-protected backup, register the public key via our BFF → `x:PublicKey/set` + `x:AccountSettings`
  (`Aes256`, `encryptOnAppend: true` so Sent/Drafts are encrypted too).
- Webmail decrypts in the browser: private key in IndexedDB wrapped by a passphrase-derived key (argon2id via
  WASM), unlocked per session; never sent to the server. CSP and the sandboxed renderer stay as in `05-webmail.md`.

## 5. End-to-end (later)

- Between AnhourMail users: automatic OpenPGP with keys from §4 (Phase "Later").
- To the outside world: publish public keys via **WKD** (Web Key Directory) at `openpgpkey.<domain>` and support
  **Autocrypt** headers, so other OpenPGP users can encrypt to us; send encrypted when the recipient has a key.
- Never claim E2EE for ordinary mail to other providers.

## 6. Account security

| Control              | Plan                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password storage     | argon2id (done)                                                                                                                                                                                 |
| 2FA                  | TOTP + **WebAuthn security keys and passkeys** + one-time recovery codes for the console (better-auth plugins); SMS never (phishable, SIM-swap)                                                 |
| Phishing resistance  | Passkeys offered at sign-up; admins of Plus accounts can **require** a security key/passkey for their people                                                                                    |
| Mail-protocol logins | Per-device **app passwords** (Stalwart `x:AppPassword`: scoped permissions, optional IP allow-list, expiry) with last-used time; the account password never works over IMAP/SMTP once 2FA is on |
| Sessions             | Session list with device/IP/last-seen, sign out one or everywhere; new-device sign-in email                                                                                                     |
| Visibility           | User security page + account audit log (done, hash-chained); staff actions always visible (rule 49)                                                                                             |
| Brute force          | Fail-closed rate limits on auth (done); Stalwart IP+username fail2ban; lockout with notification                                                                                                |
| Stalwart gaps        | No WebAuthn in Stalwart → passkeys apply to the console/webmail login (our BFF); IMAP/SMTP use app passwords. Header-From spoofing gap (`10-collaboration.md`) fixed in Phase 1                 |

## 7. Application and operations

- Webmail: strict nonce CSP, sandboxed HTML (no scripts), remote images blocked + proxied, no third-party requests,
  `Referrer-Policy: no-referrer` (`05-webmail.md`).
- `security.txt` at `/.well-known/security.txt` → `security@anhourmail.com`, private disclosure (SECURITY.md);
  bug bounty after launch.
- **Independent penetration test before public launch** (Phase 8 exit criterion); publish a summary.
- Transparency report (lawful requests, takedowns), first one 6 months after launch.
- Dependency audit + gitleaks in CI (done); signed releases and reproducible builds later.
- Stalwart pinned by digest; security patch releases applied within 7 days (`08-operations.md`).

## 8. Comparison and claims

|                                           | AnhourMail (target)                                | Low-cost provider (its docs)                                          | Privacy-focused provider | Large free provider (personal)                   |
| ----------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| TLS to clients                            | 1.2+ only, AEAD                                    | "SSL enabled"                                                         | Yes                      | Yes                                              |
| MTA-STS / TLS-RPT                         | Enforce / yes                                      | Not stated                                                            | Not stated               | MTA-STS honoured outbound                        |
| DANE                                      | Inbound (with DNSSEC) + outbound when published    | Not stated                                                            | Not stated               | No announcement found                            |
| At rest                                   | Disk + encrypted off-server backups                | All data encrypted; mail encrypted with password-derived key          | Zero-access              | Provider-held keys                               |
| Zero-access option                        | Opt-in OpenPGP/S/MIME, private key never on server | "Even we can't access" when password reset disabled; S/MIME "planned" | Default                  | No (customer-held keys only on enterprise tiers) |
| 2FA                                       | TOTP, security keys, passkeys, recovery codes      | TOTP, security keys, backup codes                                     | TOTP, FIDO2 keys         | Yes, incl. keys                                  |
| App passwords                             | Per device, scoped, last used                      | Yes, per-protocol scopes                                              | Paid local bridge        | Yes                                              |
| Open source                               | Yes (AGPL/MIT; Stalwart AGPL)                      | Not stated                                                            | Clients                  | No                                               |
| User-visible audit log incl. staff access | Yes                                                | Not stated                                                            | Partial (sessions)       | Activity page                                    |

The providers are anonymised here (rule 57); `research/encryption.md` has the sources.

**Claims we may make now (true in code today):** open source; passwords stored as salted argon2id; no tracking or
ads in our pages; staff actions are visible to your account; mail content is never written to our logs.

**Claims only after they ship and are verified in production:** TLS 1.2+ only; MTA-STS enforced; DANE; encrypted
off-server backups; zero-access mode; passkeys/security keys; independent pentest.

**Never:** "end-to-end encrypted" for ordinary mail; "we can't read your mail" without zero-access turned on;
"military-grade"; any hosting-region claim.

## 9. Phase placement

Phase 1: TLS listener hardening (no AUTH before TLS, cipher list), MTA-STS `testing` + TLS-RPT, REQUIRETLS on,
zero-access prototype automated test. Phase 3: TOTP + passkeys + recovery codes, sessions page, app passwords UI.
Phase 4.1: zero-access wizard + browser decryption. Phase 6: LUKS + encrypted off-server backups + restore drill,
DNSSEC + DANE, MTA-STS `enforce`. Phase 8: independent pentest. Later: WKD/Autocrypt, E2EE between users,
reproducible builds, bug bounty.
