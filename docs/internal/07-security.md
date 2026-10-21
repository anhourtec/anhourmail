# 07 — Security

Last updated: 2026-10-21.

## Threat model

| #   | Threat                                                  | Asset                                   | Controls                                                                                                                                                                                            |
| --- | ------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Malicious email HTML runs script (XSS)                  | Webmail session, mailbox data           | Server sanitiser + sandboxed iframe without scripts or same-origin; strict CSP; webmail on its own origin (`mail.`), separate from the console (`app.`); attachments never inline (`05-webmail.md`) |
| T2  | Tracking via remote content                             | User privacy (IP, open times)           | Remote images blocked by default; image proxy without cookies or referrer                                                                                                                           |
| T3  | Account takeover (credential stuffing, phishing)        | Accounts, sending reputation            | Rate limits on auth (`rate-limits.md`), lockout, TOTP/passkeys, new-device alerts, app passwords for clients, compromised-account detection                                                         |
| T4  | Cross-account data access (IDOR)                        | All account data                        | Permission + scope checks in services; 404 for out-of-scope ids; RBAC harness with cross-account tests on every route (rule 25)                                                                     |
| T5  | Privilege escalation (member → admin, customer → staff) | Account control                         | One RBAC matrix; critical permissions non-delegable; last-owner guard; harness tests escalation attempts                                                                                            |
| T6  | Staff abuse                                             | Customer trust                          | Act-as Global/Support only, time-limited, reason required, banner, audited, visible to the customer; no mail-content access path in the console                                                     |
| T7  | Spam/abuse from our platform                            | IP and domain reputation, CASL exposure | Sign-up gating, phone verification, trust tiers, fail-closed send counters, Stalwart throttles, outbound scanning (`03-anti-spam-and-abuse.md`)                                                     |
| T8  | Stalwart management API exposure                        | Every mailbox                           | Internal network only; scoped API key with IP allow-list; never the recovery admin in prod; NGINX blocks `/api`, `/admin`, raw `/jmap` publicly                                                     |
| T9  | Token or secret leakage                                 | Stalwart tokens, Stripe keys, DKIM keys | Key ring encryption with AAD; write-only secrets; redaction list in logs and audit; no tokens in the browser                                                                                        |
| T10 | Mail content leaking into logs, analytics or errors     | Privacy promise                         | Content keys redacted by the logger; no third-party error reporting; rule 24 checks in review                                                                                                       |
| T11 | CSRF / cross-origin abuse of cookie sessions            | Console actions                         | Same-origin check on unsafe methods; `SameSite=Lax` host-only cookies; no CORS                                                                                                                      |
| T12 | SSRF via user-supplied hosts (IMAP import, image proxy) | Internal network                        | Allow public addresses only (block private, loopback and link-local ranges after DNS resolution); port allow-list; timeouts; no redirects to internal hosts                                         |
| T13 | Audit tampering                                         | Accountability                          | Append-only DB grants; per-scope hash chain; daily verification job (`audit.md`)                                                                                                                    |
| T14 | Supply chain                                            | Everything                              | Pinned versions and lockfile; licence allowlist; `npm audit` and gitleaks in CI; Stalwart pinned by digest                                                                                          |
| T15 | Lawful access / foreign legal process                   | User data                               | No hosting-region claims; data minimisation; transparency report; legal-request runbook                                                                                                             |
| T16 | Signup enumeration and spam                             | Users, reputation                       | Generic responses; fail-closed rate limits; console behind the firewall IP allow-list before launch; `SIGNUP_MODE=closed` refuses sign-ups                                                          |

## Standards

- OWASP ASVS L2 as the baseline for the console and BFF. OWASP Top 10 reviewed per release.
- Passwords: salted argon2id only ("Password storage" below), zxcvbn strength check, breach-list check (k-anonymity, Phase 3 decision).
- TLS 1.2+ only with AEAD suites (Stalwart cannot negotiate 1.0/1.1), no AUTH before STARTTLS. HSTS with preload once stable. MTA-STS enforce, TLS-RPT, DANE when DNSSEC is in place, REQUIRETLS advertised. Encryption layers, zero-access mode and the claims we may make: `12-encryption-and-security-posture.md` (ADR-0016).
- Sign-in: TOTP + WebAuthn security keys/passkeys + recovery codes for the console; per-device scoped app passwords for mail protocols (Stalwart has no WebAuthn).
- Cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, host-only (separate for `app.` and `mail.`).
- Secrets: AES-256-GCM, key ring with key ids, HKDF-derived keys, AAD per row, required in production, re-encryption job (`research/reference-patterns.md` pattern 5).
- Logging: JSON, request ids, redaction list (`packages/server/src/log.ts`), and no `console.*` in server code (`check:logging`).
- Dependencies: exact versions, licence allowlist, weekly update review.

## Password storage

Decision 2026-10-21 (maintainer): passwords are stored only as **salted hashes from a deliberately slow
algorithm — argon2id**.

| Secret                                 | Where                            | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console password (better-auth)         | Postgres `auth_account.password` | argon2id PHC string, random 16-byte salt per hash, OWASP baseline `m=19456 KiB, t=2, p=1`, 32-byte output (`packages/adapters/src/auth/password.ts`, wired into better-auth via `emailAndPassword.password`). `needsRehash()` flags weaker parameters for upgrade on next sign-in.                                                                                                                                                                                                           |
| Mailbox password (IMAP/POP3/SMTP/JMAP) | Stalwart's store                 | The control plane hashes with the same argon2id parameters and sends the **PHC string**, never the plaintext, to Stalwart's management API; Stalwart stores and verifies it as-is (verified 2026-10-21: IMAP 993, POP3 995, SMTP 465 AUTH and JMAP sign-ins pass with pre-hashed credentials — `npm run stack:verify`). Because Stalwart's own strength check only runs on plaintext, password-strength rules (min 12 chars + breached/weak checks) run in the control plane before hashing. |
| App passwords                          | Stalwart                         | Generated by Stalwart for the user, shown once, stored hashed by Stalwart; never stored by us.                                                                                                                                                                                                                                                                                                                                                                                               |
| API keys / invite / reset tokens       | Postgres                         | Only a SHA-256 of a high-entropy random token is stored (tokens are not passwords; slow hashing is unnecessary).                                                                                                                                                                                                                                                                                                                                                                             |
| Third-party secrets                    | Postgres                         | AES-256-GCM with a key ring (CLAUDE.md rule 16) — encryption, not hashing, because we must use them.                                                                                                                                                                                                                                                                                                                                                                                         |

Never: plaintext, reversible encryption, unsalted or fast hashes (MD5/SHA-x) for passwords; never log or audit
password material (redaction list).

## Review process

1. Every change: the author runs `/security-review` on what they wrote (rule 5) and the full test suite (rule 37).
2. Before every commit: the `security-audit` skill as a scoped run over the pending diff with the `quick` profile. `confirmed` findings are fixed; `needs_validation` items are reported to the owner.
3. Changes to auth, RBAC, sending limits, signup gating, abuse logic, secrets, the JMAP proxy or the HTML renderer require a **`security-reviewer` agent pass** (read-only) before merge (rule 27).
4. A full `standard` audit before beta (Phase 8) and before public launch (Phase 9); an external pentest before public launch if budget allows.
5. Disclosure: `SECURITY.md` → security@anhourmail.com, acknowledge within 72 h, fix critical issues within 7 days.
