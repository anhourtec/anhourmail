# 07 — Security

Last updated: 2026-10-31 ("App passwords": no file storage on customer mailboxes; "Forwarding guard"; "Authentication results in the webmail": the internal-mail marker; "Delegation": sending as and on behalf of a delegated mailbox, the tag never stored and its five-minute expiry, slice 13; opening delegated mailboxes in the webmail and the gate; delegation grants and Convert to shared mailbox, ADR-0026; leavers lose mailbox sign-in; data export and account deletion; staff support access; profile photos).

## Threat model

| #   | Threat                                                  | Asset                                   | Controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Malicious email HTML runs script (XSS)                  | Webmail session, mailbox data           | Server sanitiser + sandboxed iframe without scripts or same-origin; strict CSP; webmail on its own origin (`mail.`), separate from the console (`app.`); attachments never inline (`05-webmail.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T2  | Tracking via remote content                             | User privacy (IP, open times)           | Remote images blocked by default; image proxy without cookies or referrer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T3  | Account takeover (credential stuffing, phishing)        | Accounts, sending reputation            | Rate limits on auth (`rate-limits.md`), lockout, TOTP/passkeys, new-device alerts, app passwords for clients, compromised-account detection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T4  | Cross-account data access (IDOR)                        | All account data                        | Permission + scope checks in services; 404 for out-of-scope ids; RBAC harness with cross-account tests on every route (rule 25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T5  | Privilege escalation (member → admin, customer → staff) | Account control                         | One RBAC matrix; critical permissions non-delegable; last-owner guard; harness tests escalation attempts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T6  | Staff abuse                                             | Customer trust                          | Act-as (ADR-0023) Global/Support only, read-only (Auditor role in one account, platform roles set aside), fresh step-up, written reason, 30 min (4 h cap), bound to one console session, never into staff accounts, banner, every action audited with `on_behalf_of`, visible to the account's admins and emailed to its Owners; no mail-content access path in the console and no webmail while acting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T7  | Spam/abuse from our platform                            | IP and domain reputation, CASL exposure | Sign-up gating, phone verification, trust tiers, fail-closed send counters, Stalwart throttles, outbound scanning (`03-anti-spam-and-abuse.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T8  | Stalwart management API exposure                        | Every mailbox                           | Internal network only; three scoped API keys, one per job (web: app passwords + managed Sieve; worker: directory, no mailbox access; scheduler: + read-only script audit — ADR-0020 "Credential split"), IP allow-lists, start-up scope checks. The provisioning key's `sysAccountUpdate` can still set a password on any account (→ read mail, or master-user via `svc-ops`/`svc-audit`), so in production an internal **management proxy** refuses credential writes (except a mailbox password replacement on a User-role customer account carrying the web app's HMAC grant — residual: web and worker compromised together can set a customer password) and app-password writes on service accounts, the per-minute service-account check and the app-password reconciler report any that slip through, and NGINX refuses `svc-*`/`%`/Bearer logins publicly. Never the recovery admin in prod; NGINX blocks `/api`, `/admin`, raw `/jmap` publicly |
| T9  | Token or secret leakage                                 | Stalwart tokens, Stripe keys, DKIM keys | Key ring encryption with AAD; write-only secrets; redaction list in logs and audit; no tokens in the browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T10 | Mail content leaking into logs, analytics or errors     | Privacy promise                         | Content keys redacted by the logger; no third-party error reporting; rule 24 checks in review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T11 | CSRF / cross-origin abuse of cookie sessions            | Console actions                         | Same-origin check on unsafe methods; `SameSite=Lax` host-only cookies; no CORS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T12 | SSRF via user-supplied hosts (IMAP import, image proxy) | Internal network                        | Allow public addresses only (block private, loopback and link-local ranges after DNS resolution); port allow-list; timeouts; no redirects to internal hosts (image proxy built 2026-10-29: "Image proxy (SSRF)")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T13 | Audit tampering                                         | Accountability                          | Append-only triggers (migration 0001); per-scope hash chain; verification job every 6 hours (`audit.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T14 | Supply chain                                            | Everything                              | Pinned versions and lockfile; licence allowlist; `npm audit` and gitleaks in CI; Stalwart pinned by digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| T15 | Lawful access / foreign legal process                   | User data                               | No hosting-region claims; data minimisation; transparency report; legal-request runbook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T16 | Signup enumeration and spam                             | Users, reputation                       | Generic responses; fail-closed rate limits; console behind the firewall IP allow-list before launch; `SIGNUP_MODE=closed` refuses sign-ups                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Standards

- OWASP ASVS L2 as the baseline for the console and BFF. OWASP Top 10 reviewed per release.
- Passwords: salted argon2id only ("Password storage" below), zxcvbn strength check (not built), breached-password check with k-anonymity ("Breached-password check" below; built 2026-10-23).
- TLS 1.2+ only with AEAD suites (Stalwart cannot negotiate 1.0/1.1), no AUTH before STARTTLS. HSTS with preload once stable. MTA-STS enforce, TLS-RPT, DANE when DNSSEC is in place, REQUIRETLS advertised. Encryption layers, zero-access mode and the claims we may make: `12-encryption-and-security-posture.md` (ADR-0016).
- Sign-in: TOTP + WebAuthn security keys/passkeys + recovery codes for the console ("Sign-in factors" below); per-device scoped app passwords for mail protocols (Stalwart has no WebAuthn).
- Cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, host-only (separate for `app.` and `mail.`).
- Content-Security-Policy: every page on every origin (console, webmail, site) gets a per-request nonce policy with
  `'strict-dynamic'` from its app's `src/proxy.ts`; no `next.config` CSP, so a response carries exactly one. Console
  and site: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'` (`apps/web/src/server/console-csp.ts`, `apps/site/src/lib/csp.ts`); the webmail adds
  `frame-src 'self'`, `worker-src 'self'`, `blob:` images and `data:` fonts (`server/webmail/csp.ts`). Dev adds
  `'unsafe-eval'` only. API responses get `default-src 'none'; frame-ancestors 'none'` (webmail print, preview and
  raw routes set their own `sandbox` policy). The site therefore renders per request (a prerendered page can't carry
  a fresh nonce). `tests/e2e/csp.spec.ts` pins the headers; the e2e `consoleErrors` fixture fails any journey with a
  `securitypolicyviolation`.
- Secrets: AES-256-GCM, key ring with key ids, HKDF-derived keys, AAD per row, required in production, re-encryption job (`research/reference-patterns.md` pattern 5). Implemented in `packages/server/src/keyring.ts` (`SECRETS_KEYRING="id:base64key,…"`, first = active; dev derives a key from `BETTER_AUTH_SECRET`); first user: webmail session tokens. The re-encryption job is still to come (`keyIdOf` finds values under a retired key).
- Logging: JSON, request ids, redaction list (`packages/server/src/log.ts`), and no `console.*` in server code (`check:logging`).
- Dependencies: exact versions, licence allowlist, weekly update review.

## Password storage

Decision 2026-10-21 (maintainer): passwords are stored only as **salted hashes from a deliberately slow
algorithm — argon2id**.

| Secret                                 | Where                            | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console password (better-auth)         | Postgres `auth_account.password` | argon2id PHC string, random 16-byte salt per hash, OWASP baseline `m=19456 KiB, t=2, p=1`, 32-byte output (`packages/adapters/src/auth/password.ts`, wired into better-auth via `emailAndPassword.password`). `needsRehash()` flags weaker parameters for upgrade on next sign-in.                                                                                                                                                                                                                                                                                                                                      |
| Mailbox password (IMAP/POP3/SMTP/JMAP) | Stalwart's store                 | The control plane hashes with the same argon2id parameters and sends the **PHC string**, never the plaintext, to Stalwart's management API; Stalwart stores and verifies it as-is (verified 2026-10-21: IMAP 993, POP3 995, SMTP 465 AUTH and JMAP sign-ins pass with pre-hashed credentials — `npm run stack:verify`). Because Stalwart's own strength check only runs on plaintext, the rules run in the control plane before hashing (`mailboxPasswordProblem`, the console's 12-character minimum plus what breaks sign-in), then the breached-password check ("Breached-password check"). See "Mailbox passwords". |
| App passwords                          | Stalwart                         | Generated by Stalwart (`app_` + 36 random lowercase letters and digits) when the control plane asks, stored hashed by Stalwart, shown to the person once in the create response; never stored, logged or audited by us ("App passwords" below).                                                                                                                                                                                                                                                                                                                                                                         |
| API keys / invite / reset tokens       | Postgres                         | Only a SHA-256 of a high-entropy random token is stored (tokens are not passwords; slow hashing is unnecessary).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Third-party secrets                    | Postgres                         | AES-256-GCM with a key ring (CLAUDE.md rule 16) — encryption, not hashing, because we must use them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Never: plaintext, reversible encryption, unsalted or fast hashes (MD5/SHA-x) for passwords; never log or audit
password material (redaction list).

## Breached-password check

Decision 2026-10-23 (maintainer): every **new** password is checked against the public Pwned Passwords corpus and
refused when it appears there ("This password has appeared in a data breach. Choose a different one.";
`BREACHED_PASSWORD` in `packages/shared/src/security.ts`). No count or count bucket is shown: the fact of the breach is
what matters, and a number invites "only 3 times, fine".

- **Where:** console sign-up, password reset (including the emailed set-password link a new platform administrator
  gets), change password and set password (better-auth plugin `packages/adapters/src/auth/breached-plugin.ts`, a
  `hooks.before` on those endpoints, error code `PASSWORD_BREACHED`); invite acceptance that creates a login
  (`acceptInvite`); mailbox create and free-address claim (`createMailbox`), "Add a user" with a chosen password (`addUser`; both the console and the mailbox password), admin reset (`resetMailboxPassword`) and
  the webmail's own change (`changeOwnMailboxPassword`) — core error `BreachedPasswordError` (`password_breached`, 400).
  Sign-in and step-up never check (existing passwords aren't re-judged).
- **How (k-anonymity):** the port is core `BreachedPasswords` (`packages/core/src/security/breached-passwords.ts`); the
  adapter (`packages/adapters/src/breached-passwords`) takes the SHA-1 of the UTF-8 password server-side, sends only the
  first 5 hex characters to `https://api.pwnedpasswords.com/range/<prefix>` with `Add-Padding: true` and
  `User-Agent: AnhourMail`, no redirects, a 2 s timeout covering the body, a 256 KiB body cap, and compares suffixes
  locally (padding lines have count 0). The password, the full hash and the prefix are never logged, audited, cached
  or sent anywhere else. The browser never calls the service (rule 29); the mailbox password is checked while it
  still exists only in the request, before hashing.
- **Order:** the length and shape rules first (their message wins), then the breach check. In core services the
  lookup runs **before** the unit of work (no row lock is held across a network call) and only for an actor who has
  the permission, so a 403 actor causes no outbound request; the answer is applied after the rules, inside the
  mutation, so a refusal is audited as `failed` with `password_breached` (never the password).
- **Fail open (decision):** unreachable, slow (> 2 s), non-200, oversized or malformed answer → `unknown` → the
  password is accepted, with a `warn` log `breached-password check unavailable; password accepted` carrying only
  `reason` (`network` | `timeout` | `status` | `too_large` | `malformed`), `status`, `errorName` and `durationMs`. The
  check is advice on top of the length rules; a third-party outage must not block sign-up or a locked-out person's
  reset. No metric or audit entry for it.
- **Config:** `BREACHED_PASSWORD_CHECK` = `on` | `off` | `fake` (web only). Unset = `on`, except `NODE_ENV=test`
  (`off`). `fake` (memory list in `packages/adapters/src/memory/breached-passwords.ts`, no network) is for dev and CI —
  `.cicd/lib.sh` exports it so CI never calls out — and production refuses it at start-up. `.env.example` has `on`.
- **Egress:** only the **web** container calls out. The staging compose gives web the `egress` network; a deployment
  without HTTPS egress from web fails open on every check (watch for the warning). Node's `fetch` ignores
  `HTTP(S)_PROXY`; an egress proxy would need explicit support.
- **Why not better-auth's own `haveIBeenPwned` plugin:** it fails closed (500 when the service can't be reached), has
  no timeout, fetches by itself (no port, no fake) and only covers better-auth endpoints, not mailbox passwords.

## Sign-in factors

Built 2026-10-22 (console only; mailbox sign-ins are Stalwart's). Code: `packages/adapters/src/auth/*`,
`packages/core/src/security`, `apps/web/src/server/auth/*`, `apps/web/src/components/security/*`. Facts:
`packages/shared/src/security.ts`.

| Factor                   | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | At rest                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticator app (TOTP) | better-auth two-factor plugin: RFC 6238, SHA-1, 6 digits, 30 s, ±1 step. Enrol: password → QR (drawn in the browser by `components/security/qr.ts`, no image service) + key for manual entry → first code turns it on. Each code is accepted once: a valid code is claimed with one atomic Redis `SET … NX PX 120000` (key = hash of user id + code; `packages/server/src/one-time.ts`) before the plugin accepts it, so of concurrent requests with the same code only the claimer gets through; a Redis error refuses the code (fail closed). Turning it off needs the password **and** a current code or a recovery code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `auth_two_factor.secret`: the plugin's encryption with `BETTER_AUTH_SECRET`, sealed again with the key ring (AES-256-GCM, purpose `auth.two_factor.secret`, AAD = user id) by a wrapped database adapter, so a value copied to another row fails to decrypt       |
| Recovery codes           | 10 codes, 16 characters (80 bits) from a 32-letter alphabet, shown once (copy/download in the browser), single use, any case and dashes. New codes replace the old ones (password required). Warning at 3 or fewer. Used at sign-in or to turn 2FA off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | SHA-256 hashes (`h1:…`) in `auth_two_factor.backup_codes`; typed input is always hashed before the plugin compares and anything containing `:` (a stored value) is refused, so reading the database never yields a usable code; consumption is a compare-and-swap |
| Passkeys / security keys | `@better-auth/passkey` (SimpleWebAuthn). RP ID = the console host (`APP_URL`, `localhost` in dev), origin = `APP_URL` only, so the webmail origin can never use them. Discoverable credentials, user verification **required** (checked server-side after verification: a key without PIN/biometrics is refused). A passkey is a complete sign-in on its own; it's offered on the second step too. Adding one needs a **step-up** in the last 5 minutes — a sign-in that proved the person's strongest factor (a password-only sign-in counts only for someone with no second factor), or `POST /api/auth/step-up` with a current code or a recovery code (used up; the password only when they have no second factor; wrong attempts count toward the second-step lockout, and a session that fails 5 step-ups is signed out, audited `auth.session_revoked` reason `step_up_failures`, so a stolen session can't keep the real person locked out) — recorded server-side (`auth_verification` `step-up-<session id>`) and used up by the registration; `createSession` is refused. The person is emailed when a passkey is added. Rename/remove through core services (404 for others' ids). Passkeys survive a password reset: the Security page then asks the person to check them (with Remove), and both the reset page and "sign out everywhere else" offer "also remove all passkeys" (unchecked by default, audited as `passkeysRemoved`), refused (400 on reset, 409 otherwise) when an account requirement depends on them (if a requirement changes between that check and the reset completing, the passkeys are kept, the sessions and trusted browsers still go, and the entry records `passkeysRemovalRefused`) — a mailbox-only attacker can't strip them. The first factor someone sets up while an account requires one is recorded in that account's log (`account.sign_in_factor_added`; "first" is decided from the factors the person had before the request, so concurrent additions still notify) and emailed to them and the account's Owners. | Public key, credential id, counter, AAGUID, name                                                                                                                                                                                                                  |
| Trusted browser          | Optional "trust this browser for 30 days" on the second step (plugin: signed cookie + server-side record, rotated on each use). Forgotten for all browsers by "sign out everywhere else" and by turning 2FA off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `auth_verification` `trust-device-*`                                                                                                                                                                                                                              |

Lockout: 5 wrong codes per challenge (challenge ends), 10 consecutive wrong codes per account → second step locked 15
minutes (plugin `accountLockout`), on top of the `authFactor` rate tier (10 / 5 min per IP, fail-closed). Every
sign-in, failure, refusal (`denied` with the code: `invalid_code`, `code_reused`, `account_temporarily_locked`, …) and
factor change is audited (`auth.*`, platform scope, target = the person) and shown on their Security page with the
network part of the address and a browser/system summary only.

Account requirement (`customer_account.sign_in_policy`, `account.security.manage` ★): `two_factor` (TOTP or a passkey)
or `passkey`. The Owner must meet it first. Everyone else is gated (`UserActor.mustEnrol` → 403 `enrolment_required`
for every non-`self` permission; pages redirect to `/security?setup=required`) until they enrol. The gate also
checks **how the session signed in** (`auth_session.sign_in_method`: `password`, `password+trusted_device`,
`password+totp`, `password+recovery_code`, `passkey`; set when the session is created, upgraded to `passkey` when a
passkey is added in it): once the person has a qualifying factor, `two_factor` refuses the password alone and
`passkey` accepts only a passkey sign-in (maintainer default, 2026-10-22). A refused sign-in is stopped at the identity
layer (the new session is deleted, 403 `SIGN_IN_METHOD_REQUIRED`, audited `denied`); a session that stops meeting a
requirement later is ended on its next request (`endSessionForRequirement`, audited). Someone with nothing set up yet
may sign in with the password and is kept on their Security page until they enrol. A session the requirement refuses
can't use any signed-in auth endpoint either (step-up, two-factor setup, passkey registration): the security plugin
ends it and answers 401. An Owner can't set a requirement
their own session doesn't meet.

Password reset and change: afterwards every other session is signed out (all of them for a reset) and every trusted
browser forgotten, in one unit of work with the audit entry (`afterPasswordChange` in `packages/core/src/security`,
`auth.password_reset` / `auth.password_changed`, meta counts). `/api/auth/change-password` is on the allow-list
(`sensitive` tier) for the console's first-sign-in password change (`/change-password` page, `UserActor
.mustChangePassword`); it needs the session and the current password, and the hook clears the flag
(`auth.password_changed` meta `firstPasswordReplaced`).

Responses: session tokens, `session` objects and passkey material (public key, credential id, counter) are stripped
from the auth endpoints' answers to the browser (it has the cookie). `disableSession` on recovery-code sign-in is
refused.

Not reachable: better-auth endpoints the console doesn't use or replaces (`get-session`, which returns the session token to page script, `list-sessions`, `revoke-*`,
`passkey/delete|update|list`, `two-factor/get-totp-uri|send-otp|…`) answer 404 (`server/auth/endpoints.ts`).

Session addresses: better-auth reads `X-Forwarded-For` only when `TRUST_PROXY=true` (otherwise a header nobody sends,
so a client can't plant an address).

Documented deviation (maintainer decision): the identity plugins write their tables outside our unit of work, so their
audit rows are written right after (in the same request) rather than in the same transaction; an audit failure is
logged. Changes made through core services (sessions, passkey names/removal, the account requirement, the follow-up to
a password reset or change) commit with their audit row.

## Pending custom domains

A pending domain is put on Stalwart once its ownership TXT and MX records are found (for its DKIM keys), and Stalwart
then treats the name as local. Two risks follow, both handled in the control plane (`02-mail-infrastructure.md`
"Pending domains don't hold a name for good"):

- **An abandoned claim holding the name** (blocking the real owner and keeping our other customers' mail for it
  inside Stalwart): released when another account proves the name and the claim's own ownership TXT is gone, or by
  the daily `domain-expiry` job when it isn't verified within `PENDING_DOMAIN.onMailServerDays` or its ownership or MX
  record is gone; never on a failed lookup. Unverified rows never put on Stalwart are deleted after
  `PENDING_DOMAIN.unverifiedDays`. Audited by the system in the released account (`domain.released`,
  `domain.expired`), never with the other account's details. The numbers are public (custom-domain guide).
- **Two claims racing onto Stalwart:** the Stalwart id is recorded under a per-name advisory lock with a re-check in
  the same transaction; removal leaves the name on Stalwart while another row is recorded there.

Open: there is no account deletion path yet. When one is built it must queue `domain.remove` for every domain on
Stalwart (active and pending) before the rows cascade (`04-data-model.md`).

## Mailbox passwords

Built 2026-10-23 (ADR-0020 "Mailbox passwords"). Code: `packages/core/src/mailboxes/{password,password-hash}.ts`,
`packages/shared/src/security.ts` (`MAILBOX_PASSWORD`, `mailboxPasswordProblem`, `generateMailboxPassword`),
`packages/stalwart-client/src/management.ts` (`replacePassword`), `apps/web/src/server/webmail/password.ts`,
`apps/web/src/components/mailboxes/{mailbox-password-field,reset-mailbox-password}.tsx`,
`apps/web/src/components/webmail/settings/password-form.tsx`; proxy rule in the private ops repo (`mgmtproxy/`).

- **Hash shape (run-26 L2):** only `$argon2id$v=19$m=19456,t=2,p=1$<salt 16–64 b64>$<hash 32–128 b64>`
  (`MAILBOX_PASSWORD_PHC`, stalwart-client `ARGON2ID_PHC`, the proxy) — no weaker parameters can be smuggled in.
- **Rules:** 12–128 characters (code points), no leading/trailing spaces, no control characters, not starting `app_`
  (the webmail sign-in refuses those as app passwords), not the address or its local part. "Generate" makes 20
  characters from a 56-symbol alphabet in the browser (Web Crypto, no modulo bias), shown once.
- **Where the password goes:** the request handler passes it to the core service, which checks and hashes it at once
  (argon2id, rule 23 parameters). Only the PHC string is kept, in `mailbox.pending_password_hash`, until the worker has
  given it to Stalwart; it is never logged (`REDACT_KEYS`: `mailboxpassword`, `passwordhash`, …), queued in a job row,
  audited or put in an email. Creation: the worker sets it inside `x:Account/set create`. Reset or change: job
  `mailbox.password` with the **provisioning key** patches only `credentials/<n>` of the one Password credential
  (app passwords stay; verified on v0.16.27), with the marker header `X-AnhourMail-Credential-Write: replace`.
- **Admin reset:** `mailbox.password.reset` ★ (Owner, User Admin), fresh step-up, guard rail 8, refused during act-as;
  audited `mailbox.password_reset` (masked owner, never a secret); the mailbox's person is emailed at their console
  address. Webmail sessions end (Stalwart derives OAuth tokens from the password, so every token is revoked).
- **Make this a user** (a shared, person-less mailbox becomes someone's, `mailboxes/make-user.ts`): fresh step-up,
  asked **before** anything is looked up about the address (otherwise a session without one could learn which
  addresses have a console login); then a new generated password for the console and the mailbox. Whoever used the
  shared address keeps no way in: its webmail sessions and OAuth tokens end when the `mailbox.password` job applies
  (as for a reset; tokens are derived from the password, verified in `passwords.int.test.ts`), and its app passwords,
  which survive a password replacement, are moved to `revoking` with an `app_password.revoke` job in the same
  transaction (`mailbox.made_user` meta `appPasswordsRevoked`).
- **Handover window (security review 2026-10-28, needs_validation #1):** until the new password is on Stalwart, the
  old shared password still signs in, so anyone who knew it could otherwise (a) pass the webmail first-password step
  using it as "current" and overwrite the administrator's waiting hash, locking the new person out, or (b) ask for a
  console password reset for the new login, whose email is the mailbox address, and read the link in the mailbox.
  Closed in three places:
  1. `changeOwnMailboxPassword` refuses (409 `password_change_pending`, audited `mailbox.password_changed` denied)
     while an administrator's password is waiting (`pending_password_hash` set, `pending_password_by_owner` false) —
     after any admin reset, "Add a user" or "Make this a user", not only handovers.
  2. Console resets are held (`consoleResetHeld` in `mailboxes/password.ts`, wired as better-auth `sendResetPassword`
     → `holdPasswordReset` in `packages/adapters/src/auth/index.ts`) while the login's address is a mailbox with
     `must_change_password` set or an administrator's password waiting. Nothing is sent; the endpoint answers exactly
     as for an unknown address (`auth.int.test.ts`); a failing check also holds it (fail closed). Audited as
     `auth.password_reset_requested` denied `mailbox_password_pending` with the user id only (never the address) and
     logged with the user id. The unused reset token better-auth already stored is never delivered and expires
     after an hour.
  3. If the `mailbox.password` job gives up on an administrator's password, its hash is **kept** (not dropped as
     before), so (1) and (2) stay in force; the first-sign-in step stays; the console's Password tab says "The new
     password wasn't applied to the mail server … Set it again" (`getMailbox` `passwordApplyFailed`: a waiting hash
     whose latest password job failed); `platform.provisioning_failed` meta `adminPasswordKept`. Setting a password
     again replaces it. The person's own change that gives up is still dropped (they keep their password).
- **Sessions that outlive a password change (verified 2026-10-28 on v0.16.27, pinned in `passwords.int.test.ts` and
  `app-passwords.int.test.ts`):** an IMAP session signed in with the account password **keeps working** after the
  password is replaced — by our reset, out of band, and even after the Password credential is removed and re-added
  (`NOOP`, `SELECT`, `STATUS` still answer); suspension doesn't end it either (above). It ends only when the client
  disconnects or the session times out (an IDLE client can keep it open). An IMAP session signed in with an **app
  password** is cut off when that app password is revoked (its next mailbox command gets no answer and the connection
  closes; a `NOOP` still answers). OAuth tokens (webmail) stop at once; HTTP Basic re-checks every request.
  **Residual (accepted, we can't end IMAP sessions):** after "Make this a user" or a reset, a person who was already
  signed in over IMAP with the old password keeps reading the mailbox — including new mail and, once the new person
  has chosen their own mailbox password (which lifts the reset hold), a later console reset email — until their
  client disconnects. App passwords made for the shared address are revoked in the same transaction (their sessions
  end). Admins handing over a mailbox that was shared widely should treat the old holders as able to read it for a
  while; the console copy says what happens to old sessions.
- **Own change (webmail):** customer accounts can't change their own Password on Stalwart (`sysAccountPassword*` is in
  `CUSTOMER_DENIALS` — kept: otherwise a stolen webmail token could change the password). So the BFF proves the current
  password with a Stalwart sign-in (wrong ones count towards `webmailSignInAddress`), the control plane queues the
  hash like a reset (`mailbox.password_changed`, written as the mailbox), waits up to 20 s for the worker, then signs
  this session in again with the new password: this session stays, every other one ends.
- **Grant (run-26 M1):** a reset or change is signed in the web app with `MAILBOX_PASSWORD_GRANT_KEY` (web +
  management proxy only; the worker refuses to start with it): `<expiry>.<HMAC-SHA256(key, stalwartId |
sha256(phc) | expiry)>`, expiry ≤ 1 h, stored beside the waiting hash and sent by the worker as
  `X-AnhourMail-Password-Grant`. The proxy recomputes it (constant-time) and refuses without it. A compromised
  worker (provisioning key + database) therefore can't set a customer's password; the initial password at creation
  needs no grant (the account doesn't exist yet). **Residual:** a compromised web app _and_ worker together can.
- **Proxy (production):** credentials writes stay refused except exactly the shape above (one call, only `update`,
  one account that is a **User-role customer** — not a service account (`SERVICE_ACCOUNT_IDS`) and not a system
  mailbox (`SYSTEM_MAILBOX_IDS`: no-reply, postmaster; run-26 H1) — one `credentials/<n>` key, value exactly
  `{"@type":"Password","secret":<pinned argon2id>}`, slot n is the account's one Password per an `x:Account/get`
  subrequest, and a valid grant). At most 20 marked replacements a minute in total; each one is logged with the
  account id only. The marker header is not a control by itself.
- **Webmail session (run-26 L1/L3):** the own-change route needs the page's `X-Webmail-Account` to equal the
  session's active account, and moves the session to a new id (old one deleted, new cookie). The mailbox's person is
  emailed at their console address on every change, own or admin.
- **First-sign-in change (Add a user / Make this a user):** `mailbox.must_change_password` is enforced on the webmail
  **API**, not only the page. `route()` asks `PasswordChangeGate` (`packages/core/src/webmail/password-change-gate.ts`,
  via `apps/web/src/server/webmail/password-gate.ts`) for every route with `session: "webmail"` and answers 403
  `password_change_required` while the session's active mailbox has the flag; only the own-change route and sign-out
  opt out (`passwordChange: "allowed"`, pinned by a test against the route files). The original-message page checks
  it too. "Required" is never cached; "not required" for at most 30 s. The flag clears only when the worker has
  applied the person's own password (`mailbox.pending_password_by_owner` on the waiting hash; `runNextJob` clears it
  in the same unit of work as `passwordApplied`), never when the change is queued; an admin's reset never clears it,
  and a job that gives up leaves it set (the step then says the person's last change didn't go through; for an
  administrator's password that never applied, the change itself is refused with 409 `password_change_pending`).
  **Residual (accepted):** Stalwart has no "must change" state, so IMAP, POP3 and SMTP submission keep accepting the
  administrator-set password until the person changes it. We don't disable the mailbox's protocols for it; the
  wizard says so ("Until they change it, the password also works in mail apps").
- **Leavers (2026-10-30):** removing someone from an account (`removeMember`) gives each of their mailboxes there a
  new generated password nobody is shown and revokes its app passwords, so a person who knew the password loses
  webmail, IMAP, POP3 and SMTP access once the worker applies it. Removal answers 409 while one of their mailboxes is
  still being created (the create could still use the password they were given). An administrator's waiting hash is
  never dropped because a mailbox is being deleted (the job and its give-up keep it); a resume or restore queues it,
  and `mailbox.ensure` keeps an existing account off while one waits, so turning it back on never revives the old
  password; the resume or restore signs the proxy grant again, since the stored one only lasts a short while. If an
  administrator's password job gives up on a person-less mailbox (a leaver's, or a shared address), the mailbox is
  suspended rather than left open with the old password (audit meta `suspended`); setting a password again and
  resuming brings it back. The handoff redemption takes the account lock, which removal holds. **Needs checking on the pinned
  server:** whether Stalwart closes IMAP IDLE / SMTP / EventSource connections already authenticated when the
  password changes (OAuth tokens are revoked; open connections may last until they disconnect). The same release
  (`mailboxes/release.ts`) backs **Convert to shared mailbox** (ADR-0026: `mailbox.manage`, step-up, guard rail 8). The
  leaver's own delegation grants go with the removal, audited one by one; "Give full access to …" (`delegateTo`) grants
  in the same transaction and needs `delegation.manage.any`, the plan flag and a fresh step-up, or the whole removal is
  refused.
- **Detection:** the worker records the Password `credentialId` after every create/reset/change
  (`mailbox.password_credential_id`); the hourly reconciler reports a mailbox whose credential differs
  (`passwordReplaced`) or was never recorded (`passwordUntracked`) as `platform.reconciler_drift`, never fixes it.
  **Limit (verified 2026-10-23):** Stalwart changes the id on the first replacement after creation but keeps it on
  later ones, so a replacement after one of our own resets isn't visible this way. Needs a better signal (open item).

## Webmail sign-in and suspension

Built 2026-10-28. Code: `apps/web/src/server/webmail/known-mailboxes.ts`, `apps/web/src/app/api/webmail/auth/route.ts`,
`apps/web/src/server/webmail/access-block.ts`, `packages/core/src/webmail/access.ts`.

- **The problem:** Stalwart refuses a suspended account's **right** password exactly like a wrong one (`/api/auth`
  answers `200 {"type":"failure"}` for both, and for unknown addresses; verified on v0.16.27 with a throwaway domain,
  2026-10-28). So a fresh sign-in can't prove the password, and our post-sign-in check never runs.
- **Options weighed:** (1) name the suspension to anyone who types a suspended address — an enumeration oracle for
  outsiders (which addresses exist, which are suspended) without knowing any password; (2) prove the password some
  other way — we hold no mailbox password or hash (rule 23) and reading Stalwart's credential secrets would widen the
  management surface; (3) name it only to a browser that has **already proven** a sign-in to that address.
- **Chosen: (3).** A successful webmail sign-in sets `am.webmail_known`: up to 5 tags, each HMAC-SHA256 of the
  normalised address under the server secret, cut to 128 bits — never the address; it can't be read back or forged for
  another address. HttpOnly, SameSite=Lax, `Path=/api/webmail/auth` (sent nowhere else), Secure on https, 180 days.
  When Stalwart refuses a sign-in and the browser holds the address's tag, the control plane is asked; if the mailbox
  is blocked (`person_suspended`, `suspended`, `deleting`, `gone`) the answer is `401 mailbox_unavailable` with that
  reason's message (support address for a person's suspension). Otherwise — and for every browser without the tag —
  the generic "Mailbox address or password is wrong." The control-plane lookup happens only when the tag matches, so
  its timing tells an outsider nothing. The failed attempt still counts against the per-address wrong-password limit.
- **Residual risk (accepted):** someone using a browser where the mailbox signed in before (a shared computer) learns
  the mailbox is blocked without the password — information the mailbox's own user had there anyway. A person on a
  new device sees the generic error; the public docs tell them what a suspension looks like and whom to ask.
- **Already signed in:** a session whose mailbox becomes blocked ends on its next request (`route()` + the BFF,
  ≤ 30 s cache) and the sign-in page names the reason (05-webmail.md "Who may use the webmail"). The reason reaches
  the page only from the short-lived notice cookie or a `?reason=` our own pages signed (`reason.expiry.mac`,
  HMAC-SHA256 under the server secret, 60 s), so a crafted link can't show a suspension or deletion notice. A genuine
  signed link forwarded within its minute shows the same fixed text elsewhere (accepted: it needs one's own blocked
  session and grants nothing).

## Webmail handoff (ADR-0024)

The console's **Open webmail** signs the person in to their own mailbox without its password (flow: 05-webmail.md
"Console handoff").

- **No mailbox password anywhere.** The web app's operations key mints a throwaway app password on the mailbox
  (description `AnhourMail webmail handoff`, `Disable` of every known and self-service permission except
  `authenticate`, `expiresAt` 60 s), the BFF exchanges it once at Stalwart's OAuth endpoint and destroys it in a
  `finally`; the token it leads to is an ordinary webmail token (verified on v0.16.27: it survives the destroy, a
  password change revokes it). The secret lives only in that function; it isn't logged (`secret` is redacted) or
  audited. A destroy that fails leaves a credential Stalwart refuses after 60 s; the next handoff clears it; the
  reconciler leaves out only credentials matching description, exact permissions and a lifetime ≤ 120 s.
- **Bound to the browser.** The code (32 random bytes, 60 s, one use via `GETDEL`, stored under its SHA-256) is bound
  to the SHA-256 of a verifier that only this browser's webmail-origin cookie holds (HttpOnly, `SameSite=Strict`,
  `__Host-`). The code travels only in a URL fragment, never in a query string, a log line or a `Referer`; the page
  drops it from history at once. A copied code is useless elsewhere, even to script on the console origin (the cookie
  belongs to the webmail origin).
- **Bound to the console session and the person.** Minting needs `webmail.open.own` (every account role but Auditor —
  which is also what staff hold while acting, so act-as never reaches mail; also refused explicitly) and a mailbox
  whose `userId` is the person (404 otherwise). Redemption rebuilds the person from the database and needs the same
  console session to still exist, without support access open and still meeting the account's sign-in requirements.
- **Respects every gate:** the webmail access gate (suspended person or mailbox, staff suspension, deleting, gone; read
  uncached), the first-sign-in password change (refused: the person signs in with the given password), the
  console's own gates (console password change, required factors, account suspension) through the matrix.
- **Step-up and the console session (security review, 2026-10-29):** minting needs a recent step-up on the console
  session, as app passwords do (a fresh sign-in counts; the console page asks "Confirm it's you" in place), and the
  redemption checks it is still fresh. The console page continues by itself only for a navigation the browser marks
  same-site (`Sec-Fetch-Site`), so a link from another site can't make it mint. A code presented without the right
  verifier is used up. The webmail session it opens ends with its console session (sign-out, sign out everywhere,
  revoke, password reset; ≤ 30 s), and is deleted again if the audit entry can't be written. Mail-server writes scale
  with webmail opens (one create + destroy each), bounded by the rate limits; each runs under the mailbox's credential
  lock, so it can't shift the list position a revocation patches.
- **No new key scope, no management proxy change:** `x:AppPassword/set` on customer accounts, `/api/auth` and
  `/auth/token` were already allowed for the web app; the proxy still refuses service accounts and `%`.

## Delegation (ADR-0026)

Grants (read and manage, send as, send on behalf) are rows in `mailbox_delegation`, made and removed only by Owners and
User Administrators (guard rail 8, step-up, plan gate; "Mailbox passwords" above for leavers and the cascades). Using
one needs no permission of its own: the grant is the authorisation, checked against the database **now** every time.

- **How a delegated mailbox is opened.** The webmail BFF gets that mailbox's own token exactly as the console handoff
  does (ADR-0024 decision 4): the operations key mints a credential with every permission but `authenticate` off and a
  60 s expiry, the BFF exchanges it once at `/api/auth` with the delegate's client address forwarded (a 5 s exchange
  timeout, as the locks are held), and destroys it in a `finally`, under the mailbox's credential lock and in the
  reserved slot. Only Stalwart's `overQuota` answer counts as "slot taken": the open retries once (expired leftovers
  are cleared before every mint), then answers 503. No new key scope, no management-proxy
  change, no mailbox password anywhere. The tokens are sealed into the delegate's own webmail session (AES-256-GCM, the
  session key as AAD) and never reach the browser. The mail server must name exactly that mailbox in its JMAP session.
- **Checked at open** (core `openDelegatedMailbox`, one unit of work under the account lock, so a removal and an open
  serialise): act-as on the console session a handoff-born webmail session came from (403, before any lookup); the
  delegate's own mailbox is still theirs and usable; they are still a member and not suspended, the account isn't
  suspended or being deleted and its plan has `delegation`; they hold the right; the mailbox is active, on the mail
  server and passes the webmail access gate. Audited `delegation.mailbox_opened` (success, denied, failed).
- **Checked on every use** (core `DelegationGate`): the same checks, in `route()` for every webmail route and again in
  `WebmailService.session()` before any use or refresh of the token. "Has the right" is cached at most 10 s per
  session and mailbox; "no right" is never cached, so a revoke, a removal, a suspension or a plan downgrade stops use
  within 10 s. A failed check refuses the request (503) without dropping anything.
- **No oracle.** Every refusal of a delegated mailbox — no grant, a send-only grant, an address that doesn't exist or
  belongs to another account, the plan, the mailbox's state — is the same 404 "You don't have access to this mailbox.",
  audited only in the person's own account (another account's mailbox is never named there). Opens are rate-limited
  (`webmailDelegatedOpen`, 20 per 10 min per webmail session and again per own mailbox, so signing in again doesn't
  reset it; fail closed). Residual (low, accepted): the open's timing differs slightly between an address with no
  mailbox and one in the account without a grant (a few more database reads); it says nothing an attacker can't
  learn from the account's own people list, and another account's addresses take the same path as unknown ones.
- **Read and manage is not send, decided where the token is picked.** The service layer is the control: every
  server-built call refuses a delegated entry's token unless it is one of the read-and-manage paths (message views,
  downloads, folder roles, the JMAP proxy), checked on the very entry whose token the call uses, and `#call` also
  refuses a delegated entry for the contacts, submission and quota capabilities. Callers that act on "the session's
  mailbox" from one read (settings, the mailbox password, the profile photo, mail export) refuse a delegated entry on
  that same read (`ownMailbox`). So switching the active mailbox while a slow request is under way (security review
  2026-10-30: a body streamed to an own-only route, a switch, then the rest of the body) can't aim an own-only action at
  a shared mailbox. `route()`'s gate is defence in depth on top: while a delegated mailbox is active, every webmail route
  not marked `delegated: "full_access"` or `"allowed"` answers 403 `own_mailbox_only`, and a route-file test lists the
  marked ones. The JMAP proxy refuses `Identity/get` there. The token itself could do more; the BFF is the enforcement
  point (ADR-0026 "Consequences").
- **It rides on the person's own sign-in, proven at the mail server.** Before every open, and on a gate check at most
  every 10 s, the BFF calls the mail server's JMAP session with the token of the person's own mailbox the grant comes
  through (refreshing it when due). A refused token or refresh — their own password was reset or changed, or the
  account was disabled — ends the **whole** webmail session (401, cookie cleared), so a stolen session can neither keep
  reading shared mailboxes with their own tokens nor open new ones. Remaining window: at most 10 s after the reset, per web process
  (the proof's cache).
- **Sender fields from the client are refused.** The proxy refuses any `Email/set` or `Email/import` carrying a
  `sender` property, a `header:*` property or the `X-AnhourMail-On-Behalf` header, so no session can attach a `Sender:`
  or an on-behalf tag; delegated sending builds both server-side only, from the structured draft (`DraftInput` has no
  such fields).
- **Sending from a delegated mailbox** (slice 13, `05-webmail.md` "Sending from one"). Always from the mailbox itself:
  its token, its own identity (its address, never an alias) and its address as envelope sender, so its Sent folder gets
  the copy and DKIM aligns with `From` (P5, P10). The right is checked **uncached before any work in that mailbox** and
  the send is audited (`delegation.sent_as` / `delegation.sent_on_behalf`, a recipient count only) at that point — if
  the audit append fails nothing is done; it is checked once more, uncached, right before `Sender:` and the tag are
  built, so a revoke at any point before the submission is refused (tested). A send stopped after its audit entry, for
  any reason including a lost answer, is recorded `delegation.send_failed` and leaves no copy behind. Send as wins when
  both send rights are held. Limits: the **stricter of the shared mailbox's and the sender's own trust tier** (a
  `restricted` sender can't send through a shared mailbox), charged to the shared mailbox's windows and the sending
  session's, both fail closed, plus the mail server's own throttles. Read and manage alone never sends (404, like every
  other refusal).
- **No stored message holds an on-behalf tag.** The tag and its expiry go only on a temporary copy that is submitted
  with `onSuccessDestroyEmail` in the same request as its creation; the copy kept in Sent is created separately without
  them (same Message-ID); a refused or failed send destroys both, and the BFF destroys the temporary copy itself if the
  mail server didn't (retried once; else recorded `delegation.tagged_copy_left`). The tag is bound to a Message-ID the BFF makes (`<uuid>@<mailbox domain>`) and to an expiry five
  minutes ahead (`X-AnhourMail-On-Behalf-Expires`, checked by the script against the server's `currentdate`, fail
  closed: only a comparison proving "now ≤ expiry" passes; both headers removed from every submission). This closes ADR-0026's "leftover gap": a tag seen during the moment the
  temporary copy exists (a mail app syncing Drafts) or left by a crash is useless after five minutes, even with the
  same Message-ID; the remaining window — the mailbox's own person reusing a tag they saw, within five minutes, for
  the same Message-ID with any body — is accepted (owner-only; nobody can sign in as a shared mailbox; key rotation
  ends every tag). The script also refuses a Message-ID not in the web app's `local@host` form before hashing,
  because the pinned server reads an unreadable one (`<>`, empty) as `""` instead of failing the expression (probed
  2026-10-30), which would have hashed to a per-pair constant.
- **Received mail's tag means nothing.** Inbound mail doesn't run the sender script; the webmail never reads, shows or
  trusts an `X-AnhourMail-On-Behalf` header on received mail ("on behalf of" comes only from `Sender:`).
- **Revocation.** A revoke deletes the row; the next use is refused and the entry dropped from that session. Tokens
  stay valid at the mail server until they expire (≤ 1 h access, 30 days refresh) unless the mailbox's password
  changes; only our sealed session store holds them (residual 3). A refused refresh or a mail-server 403 drops only
  that entry; the delegate's own session goes on.
- **Residual, accepted (maintainer decision 2, residual 4):** a delegated mailbox opens from any webmail session of the
  delegate's own mailbox, including password sign-ins that don't pass the console's two-factor requirement.

## App passwords

Built 2026-10-22 (ADR-0020). Code: `packages/core/src/app-passwords`, `packages/stalwart-client/src/app-passwords.ts`
(permission sets), `packages/adapters/src/stalwart` (`stalwartAppPasswords`, `stalwartAppPasswordInventory`), `apps/web/src/app/(console)/accounts/[accountId]/app-passwords`,
`apps/web/src/components/app-passwords/*`. Facts: `packages/shared/src/security.ts`.

- **Who:** only the person a mailbox belongs to creates its app passwords (`app_password.manage.own`, every role but
  the Auditor). People with `mailbox.read` see their names and dates on the mailbox panel; people with `mailbox.manage`
  revoke them (an Owner's or admin's mailbox: Owners only, as for suspending). Nobody ever sees a secret after the
  create response. Never while staff act as the person (403, audited `denied` `act_as`): an app password opens mail.
- **Step-up:** creating one needs the session's step-up marker (`auth_verification` `step-up-<session id>`, written by
  a sign-in that proved the person's strongest factor or by `POST /api/auth/step-up`, valid `STEP_UP_MINUTES`). It is
  read, not used up, so several app passwords can be made in the window. Missing → 403 `step_up_required`, audited.
  The account sign-in requirement still applies (the permission is account-scoped, so `mustEnrol` blocks it).
- **Credentials** (ADR-0020 "Credential split"): created by the web app with the **operations key** (`impersonate` +
  `sysAppPassword*`, no account or mail objects); listed for the reconciler and revoked by the worker's job with the
  **provisioning key** through `x:Account.credentials` (no owner access to the mailbox).
- **Secret:** generated by Stalwart (≈186 bits), returned once by `x:AppPassword/set`, passed through to the browser
  and never written anywhere by us: not the database (metadata only: name, protocols, Stalwart credential id and its
  creation time), not logs, not the audit entry (`auth.app_password_created` meta: name, protocols). Shown grouped in
  fours for reading; copying (button or selection) yields it without spaces. The person is emailed a notice (name,
  mailbox, time; to their console address, not into the mailbox the password opens).
- **Allow-list per credential** (`SCOPE_ALLOW`, `appPasswordPermissions`): only `authenticate` plus the chosen
  scopes stay on — `imap` (all IMAP but `imapAclSet`), `pop3`, `smtp` (`emailSend`), `jmap` (mail over HTTPS: email,
  mailboxes, threads, submission, quota, blobs, push, `emailSend`; identities read-only) and `dav` (CardDAV/CalDAV
  and their JMAP objects; no mail, files, ACLs or principal search). Every other permission the server knows
  (`KNOWN_PERMISSIONS`: all non-`sys*` names from `/api/schema` on v0.16.27, plus the self-service ones) is turned
  off with `Disable`. That is a `Replace` allow-list in effect: real `Replace` can only grant what the operations key
  holds itself, so it would need a key that reads every mailbox (verified). New permission names in an upgrade fail
  the integration test until they're classified. Default: IMAP, SMTP, contacts and calendars; POP3 and JMAP opt-in.
  Never: Sieve and vacation writes, principal look-ups, sharing, alias sign-in, invitations or alarms sent by mail.
- **On the account too** (`CUSTOMER_DENIALS` in `CUSTOMER_PERMISSIONS`, also in `SUSPENDED_PERMISSIONS`; the reconciler's `sieveLocked` drift check covers the whole list): every self-service permission
  (`sysAccountPassword*`, `sysAppPassword*`, `sysApiKey*`, masked email, …) and the principal look-ups are off for the
  whole customer account, whatever signs in — the mailbox password, an OAuth token, an app password. Verified: a
  token minted from an app password straight at Stalwart answers `forbidden` to `x:AppPassword/set`,
  `x:ApiKey/set` and `x:AccountPassword/set`; `Principal/query` (which listed every account on the server before)
  is `forbidden`; mail, identities and contacts still work; the operations key still creates, lists and destroys
  app passwords there. The webmail never calls `x:*` or `Principal/*` with a user's token.
- **No file storage** (`FILE_STORAGE_PERMISSIONS`, part of `CUSTOMER_DENIALS`; 2026-10-31): Stalwart's JMAP File
  Storage (`FileNode/*`, capability `urn:ietf:params:jmap:filenode`) and WebDAV files (`/dav/file/`) were open to any
  customer with the mailbox password, and `FileNode/set { "shareWith/<id>": … }` shared a file with **any** account on
  the server (it then appeared in that account's session; verified on the dev stack). We don't offer file storage, so
  all 18 file permissions (`jmapFileNode{Get,Query,QueryChanges,Changes,Create,Update,Destroy,Copy}`,
  `davFile{Get,Put,Delete,Copy,Move,MkCol,Lock,PropFind,PropPatch,Acl}`) are off on every customer and system mailbox
  and in no app password scope. Verified: create, share, get and query answer `forbidden`, `/dav/file/` PROPFIND, PUT
  and MKCOL answer 403, with the password and with app passwords. A file another account shared **before** the change
  is unreadable to the recipient by every path tried — `FileNode/get`, `Blob/get` and `Blob/lookup` on the sharer's
  account (`forbidden`), `Blob/copy` from it (`notCopied`), `/jmap/download` (404), WebDAV GET and PROPFIND (403) —
  except Stalwart's WebDAV `sync-collection` REPORT (`davSyncCollection`, a generic permission CardDAV/CalDAV sync
  needs), which still lists the shared files' names, sizes and types (never content), and the sharer still shows in
  the recipient's raw JMAP session (address only; the webmail builds its own session list). Both end when the share
  is removed: the Stalwart bootstrap removes every file share with the administrator credential (`clearFileStorage`;
  `PLAN_PURGE_FILES=true` also destroys stored files, which users can no longer see or delete). Share notifications
  (`jmapShareNotification*`, the record of who shared what) are denied too; the webmail never reads them. No clean
  server-wide switch exists: a per-account `maxFiles: 0` quota is accepted but means no limit, and `x:FileStorage`
  limits start at 1 (verified). Email attachments are blobs of the email (`jmapBlob*`, `Email/*`, `emailSend`):
  upload, send, delivery and download still work (integration tests). Existing accounts get the denials from
  migration 0032 (one `mailbox.ensure` per mailbox on the mail server) and the reconciler's `sieveLocked` check (every
  status but `provisioning`); `no-reply`/`postmaster` from the bootstrap, which now always writes their lockdown and
  checks it. An upgrade that adds a file permission name fails the integration test until it is denied.
- **Never a webmail or OAuth sign-in:** Stalwart mints an account-wide OAuth token from an app password at
  `/api/auth` (verified), so `StalwartOAuth.signIn` refuses any secret starting `app_` (Stalwart also accepts an app
  password with a `$…` suffix, so nothing tighter is safe). **Production NGINX must not expose Stalwart's `/api/*`,
  `/auth/*` or `/admin`** on the public JMAP/CardDAV host (`deploy/README.md`).
- **Directory and sharing** (same list, review run-22): DAV `principal-property-search`/list/match are off (it found
  accounts on every domain); CardDAV/CalDAV discovery still works. Sharing has no permission of its own, so folder and
  calendar create/update over JMAP and every ACL method are off for customers; `AddressBook/set { shareWith }` stays
  open because the webmail writes address books (open item). App password scopes never include any object
  create/update that carries `shareWith`.
- **Managed scripts** (`reconcileManagedScripts`, hourly, the scheduler's read-only **audit key**): each active
  mailbox's script must carry our settings line, redirect only to its confirmed forwarding target, use no extension
  the webmail never writes (notify, variables, extprograms, …) and be the active one. Drift is reported
  (`platform.reconciler_drift`, counts only) and `mailbox.ensure` re-queued (not for a script only switched off: the
  worker can't re-activate it; the next settings save does); the script is never deleted or rewritten. Matters because
  the operations key can write Sieve on any account.
- **Service accounts** (`reconcileServiceAccounts`, hourly, provisioning key): the owners of the management keys on
  the infrastructure domains must hold API keys only; a password (any key that can update accounts can set one, and
  it signs in with that key's role, `impersonate` included) or an app password is reported and audited
  (`platform.reconciler_drift`, counts only), never removed.
- **Reconciler** (`reconcileAppPasswords`, hourly, provisioning key): lists every mailbox's app passwords and API keys
  from `x:Account.credentials` and reports
  credentials with no row, with permissions that aren't what their row's protocols give, rows the server lost, and any
  API key (end users never get one); re-queues pending revocations whose job gave up (ones still queued or running count as in flight, not drift). Report and audit
  (`platform.reconciler_drift`, counts only) — never revokes or deletes by itself (rule 26).
- **Per mailbox:** at most `APP_PASSWORDS_PER_MAILBOX` (5, Stalwart's default `maxAppPasswords`), counting ones being
  revoked; suspended, deleting and not-yet-provisioned mailboxes can't get new ones (409). Suspension blocks them
  (Stalwart's `authenticate` is off for the account) and resuming restores them; deletion destroys them with the
  account at purge.
- **Revocation:** `active → revoking` in the request (audited), then the worker's `app_password.revoke` job removes
  each credential from `x:Account.credentials` (provisioning key), matching id **and** creation time (Stalwart reuses
  ids) and checking afterwards that nothing else went with it, then deletes the row. Revoke one or all;
  revoking a row that is already `revoking` re-queues the job (the retry path if a job gave up).
- **Removal from the account** revokes the app passwords on the removed person's mailboxes (in the same unit of
  work as `account.member_removed`, meta `appPasswordsRevoked`): they're credentials that person holds.
- **Creation re-checks under the account lock** (the lock removal also takes): a person removed, or no longer holding
  the mailbox, by then gets 404 and nothing is issued.
- **Suspended console users:** a suspended person can't sign in, so can't create or list; their existing app passwords
  keep working while their mailbox is active. Abuse handling suspends the mailbox (which blocks every app password at
  once, reversible). A person-level suspension action doesn't exist yet (Phase 6): when it lands it must revoke the
  app passwords on that person's mailboxes, as removal does (open item).
- **Rate limits:** create `sensitive` (fail closed); revoke `write`; list `read`.
- **Known gap:** replacing an account's credential list on Stalwart (setting a mailbox password with
  `credentials: {0: Password}`) drops every app password (verified). The dev seed accounts for it; a future "set
  mailbox password" feature must patch only the password entry.

## Invites

Decision 2026-10-22 (security review of the people slice):

- **Accepting an invite creates a verified console login even when `SIGNUP_MODE=closed`.** Intended: the single-use
  link was emailed to that address, so opening it proves the address. It is bounded by the account's plan
  (`addPeople`), `MAX_PEOPLE` per account (members + unexpired invites, re-checked under the account lock at
  acceptance) and `INVITE_EMAILS_PER_DAY` per account (a send log that counts resends; revoking gives nothing back).
  No personal Free account is created for such a login.
- Invite emails have a generic subject; the account and inviter names (chosen by people) appear only in the body,
  escaped, and never inside one of our sentences: they are quoted mono facts (`Account: "…"`, `Invited by: "…"`), so
  they read as data and can't pose as our wording (XSS audit run-28 C2). Sending is rate-limited per caller (`invite`
  tier) on top of the daily cap.

## Names people choose

Decision 2026-10-23 (XSS audit run-28 N3): first, last and display names (sign-up, profile edits, logins created from
an invite) and personal account names follow one shared rule set, `nameProblem` in `packages/shared/src/names.ts`:
no C0/C1 control characters or DEL, no bidirectional-text controls (U+200E/F, U+202A–U+202E, U+2066–U+2069), no `@`
(ASCII or fullwidth), and nothing URL-like (`://`, `www.`, or a dotted token whose last label looks like a top-level
domain, e.g. `evil.example`). These names reach invite and notice emails and other people's consoles. Console: 400
`INVALID_NAME` with the rule's sentence (`refuseBadNames` in `packages/adapters/src/auth/index.ts`); core: a
`ValidationError` (`loginNames`). A personal account name that breaks the rules (e.g. a dotted email local part as the
fallback) becomes "My account". Known false positives (accepted): a name written like `Mr.Smith` (no space).

## Redirect targets at the identity endpoints

Decision 2026-10-23 (XSS audit run-28 N2): better-auth 1.7.12 accepted an off-site `redirectTo` on
`/request-password-reset` (the emailed link then carried it) and redirected `GET /reset-password/<token>?callbackURL=`
to any URL. Our first plugin, `redirectGuardPlugin` (`packages/adapters/src/auth/redirect-guard.ts`), checks
`callbackURL`, `redirectTo`, `errorCallbackURL` and `newUserCallbackURL` in the body and query of every identity
endpoint before it runs: a same-origin path (one leading `/`, no `//`, backslashes, whitespace or control characters)
or an absolute http(s) URL on our own `baseURL`/trusted origins, no credentials; anything else is 403
`INVALID_REDIRECT`. The forgot-password form sends the relative `/reset-password`. Integration tests prove
`https://evil.example`, `//evil.example`, `/\evil.example` and `https:evil.example` are refused on request-password-reset,
the emailed reset link and verify-email.

- Tokens: 256-bit, only the SHA-256 is stored, the token travels in the URL path (`/invite/<token>`) and in the
  sign-in `next` query, never in an API response or our logs (`logPath` redacts it). Pages carrying it send no
  referrer. **Production NGINX must not log the `/invite/<token>` path or the `next` query** (`deploy/README.md`).

## Outgoing HTML

Decision 2026-10-24: HTML the webmail sends goes through one allow-list sanitiser, `sanitizeOutgoingHtml` in
`apps/web/src/server/webmail/outgoing-html.ts`. It is a pure function shared by the composer (paste, drop, Insert
HTML, every save) and the drafts route, which sanitises again because the client is never trusted. Other people's
mail apps render what we send, so the list is stricter than the reader's (`sanitize.ts`):

- **Elements:** structural and text formatting, tables, `img`, `a`, `font`, `center` only. Script, `style` (dropped
  with its content: mail apps strip or rewrite it and it carries `@import` and remote fonts), `template`, form
  controls, frames, `object`/`embed`/`applet`, SVG, MathML, `noscript` and `summary` go with their content; unknown
  and custom elements are unwrapped and keep their text. Comments and CDATA are dropped.
- **Attributes:** an allow-list per element (`href`, `src`, `alt`, `title`, sizes, table layout, colours, `dir`,
  `lang`, `style`, and `type` on `blockquote` with the single value `cite` — the quoted-reply mark mail apps fold);
  no `on*`, `class`, `id`, `srcdoc`, `formaction` or `data-*`. The reading view's folded quote (`details
data-am-quote`) becomes `blockquote type="cite"` again when a reply quotes it. The text/plain part prefixes quoted
  lines with "> " per level, under the "On … wrote:" line.
- **URLs:** links http, https, mailto, tel (control characters and entities decoded first; relative and
  protocol-relative removed), always `target="_blank" rel="noopener noreferrer"`. Images https, `cid:` or raster
  `data:` (PNG, JPEG, GIF, WebP) up to `WEBMAIL_HTML.inlineImageKb`; an image without a valid source is removed.
- **CSS:** escapes and comments decoded first; declarations split outside quotes and parentheses; a property
  allow-list; values with `<>{}@\`, unbalanced quotes, a `;` outside `url()`, `expression()`, `javascript:`,
  `vbscript:`, `behavior`, `-moz-binding`, `image-set()` or `element()` are dropped; `url()` only for https and
  raster data images; `position` only `static`/`relative`; `var()`, `env()` and `attr()` anywhere are dropped (they
  would let the recipient's app style the message). Style attributes over 8 KB are dropped.
- **Value grammars for the composer's styles (2026-10-29, `STRICT_CSS`):** the properties the toolbar writes, and
  their close relatives in pasted mail, are kept only when the whole value matches: `color`, `background-color`,
  `text-decoration-color` — `#hex` (3/4/6/8 digits), `rgb()`/`rgba()` of numbers or percentages, or a letters-only
  colour word; `font-family` — up to 8 plain names (letters, digits, space, `-`, `_`, optionally quoted, 40
  characters each); `font-size` — size keywords or a positive length ≤ 96px / 72pt / 6em / 6rem / 12ex / 600%;
  `text-align` — left, right, center, justify, start, end; `margin`, `margin-*` (also `auto`) and `padding`,
  `padding-*` — one to four non-negative lengths ≤ 400px / 300pt / 25em / 25rem / 50ex / 100%;
  `text-decoration` — line and style keywords plus at most one colour; `text-decoration-line` and
  `text-decoration-style` — keywords. The legacy attributes get the same grammar: `color`/`bgcolor` as colours,
  `<font face>` as a family list, `<font size>` 1–7 or ±1–6. `<strike>` becomes `<s>`. So no function, unit trick or
  negative offset (content laid over other content) gets through the toolbar's properties.
- **Size:** input over `WEBMAIL_HTML.maxMb` is refused (the drafts schema and the composer both check).
- **In the editor:** sanitised HTML sits in the page's own document while it is edited; the webmail CSP (nonce
  scripts only, same-origin images) is the backstop, so a sanitiser miss can't run script or fetch remote images
  there. Remote images are counted and the person is warned they may be trackers; they are sent as written.
- Tests: `outgoing-html.test.ts` (XSS corpus: script/SVG/MathML, encoded and whitespace `javascript:` variants,
  `data:text/html`, `srcdoc`, `formaction`, CSS `url(javascript:)` and escapes, mutation-XSS nesting, comments and
  CDATA, idempotence; the toolbar's output kept unchanged; every grammar's accepted and rejected values, decoded
  escapes and comments, `var()`/`env()`/`attr()`; `<font>` attributes; indents vs quotes in the text part).

## Signatures

Decision 2026-10-29 (05-webmail.md "Signatures", ADR-0014): signatures are untrusted HTML that is stored, shown in the
editor, inserted into every message and copied to the mail server's identities, so they get the strictest mode of the
outgoing sanitiser (`cleanSignature` in `apps/web/src/server/webmail/signature-html.ts`, `embeddedImagesOnly`):

- **Sanitised on the server on every save** (the editor runs the same code only to show what is kept), and again by
  the composer before it inserts one (with the same options), and again with the whole message when the draft is
  saved. Everything the outgoing sanitiser removes from messages is removed.
- **No remote anything:** https and `cid:` images are removed, and so is every CSS declaration with a `url()`
  (backgrounds too). A signature never makes the reader's app fetch from a server, so it can't carry a tracking
  pixel, and the editor never fetches either.
- **Embedded images only:** `data:` PNG, JPEG, GIF or WebP whose decoded first bytes match the declared type
  (`dataImageMatchesType`; an HTML or SVG payload labelled `image/png` is removed), each at most 64 KB as a file, at
  most 3, the whole signature at most 300 KB of HTML and a mailbox's signatures at most 1 MB together
  (`WEBMAIL_SIGNATURES`). The request body is read with a cap
  before it is parsed; the core service re-checks the size and the name (1–32 characters, control and format
  characters removed); Postgres `CHECK`s back both.
- **Scope:** every route is the session's own active mailbox (account pinned with `X-Webmail-Account`); another
  mailbox's signature id is not found (404), the same as an unknown one. Writing the identity copy uses the person's
  own session through the BFF; the browser's JMAP proxy still refuses `Identity/set`.
- **Logs and audit:** never the name or content — ids, sizes, image counts and which fields changed only. A refused
  identity copy is logged with the mail server's error type only.
- Tests: `signature-html.test.ts` (remote, `cid:`, `http:` and mislabelled images removed, CSS `url()` removed,
  scripts, styles and handlers removed, caps), `signatures.test.ts` (names, count, defaults, other mailboxes 404,
  audit without content), `settings.test.ts` (server-side sanitising, identity copy), the routes' 401/403 test and
  the integration test against Stalwart.

## Authentication results in the webmail

Decision 2026-10-28: "Show original" (SPF, DKIM, DMARC) and the reader's "mailed-by" / "signed-by" show only the
`Authentication-Results` header our own mail server wrote (RFC 8601 section 5); anything else reads "Not checked".
Validated on the dev stack against Stalwart v0.16.27:

- **Mail from outside (port 25):** Stalwart prepends `Delivered-To`, `X-Spam-Status`, its `Received` (`by` its
  hostname), then its `Authentication-Results`, `Received-SPF`, `X-Spam-*` and `Return-Path`, above the sender's own
  headers. A forged `Authentication-Results` carrying our authserv-id stays in the message, below that block; Stalwart
  does not remove it.
- **Authenticated submission (SMTP 465/587 and JMAP `EmailSubmission`) to a local mailbox:** Stalwart adds no
  `Received` and no `Authentication-Results` (`MtaStageData.addReceivedHeader` / `addAuthResultsHeader` are
  `local_port == 25`), so before this change a sender's forged header with our authserv-id was the topmost one and
  the recipient saw "PASS" for a domain the sender doesn't control.

Two layers:

1. **Parser** (`ourAuthResultsHeader` in `apps/web/src/server/webmail/original.ts`): the topmost `Received` must be
   stamped `by` one of our authserv-ids and be followed directly (ARC headers aside) by an `Authentication-Results`
   with our authserv-id; otherwise nothing is trusted. The reader fetches the ordered `headers` list for this.
2. **Strip on submission:** the sender identity Sieve script (`@anhourmail/stalwart-client` `sender.ts`, run at DATA
   for authenticated sessions in dev and production) deletes every `Authentication-Results` header, so a submitted
   message can't carry a forged `Received` plus results pair into a local mailbox either. `npm run stack:verify`
   checks it.

Residual: messages delivered before the strip was applied could still carry a planted `Received` + results pair at
the top of the sender's headers; the reader would trust it. Mail from outside with a forged header below ours is
handled by the parser; stripping those on port 25 would need a hostname-aware inbound script and is not done.

Delivery paths re-checked on the dev stack 2026-10-28 (security review needs_validation #2), pinned in
`catch-all.int.test.ts`, `webmail-settings.int.test.ts` and `app-passwords.int.test.ts`:

- **Port 25 direct and through a catch-all:** `Delivered-To`, `X-Spam-Status`, our `Received`, our
  `Authentication-Results` directly below it — the pair the parser trusts; a forged results header with our id in the
  sender's headers stays below and is ignored.
- **Forwarding (our managed Sieve `redirect`, keeping a copy):** the kept copy is as above. The forwarded copy gets
  two `DKIM-Signature`s and a new `Received … by <our host> with LMTP` on top, with no results below it, so the parser
  returns nothing ("Not checked") — never a wrong answer. No path found where our `Received` sits directly above a
  results header Stalwart didn't write.
- **Submission:** JMAP `EmailSubmission` (an `Email/set` with `header:Received` and `header:Authentication-Results`)
  and SMTP 465 with header-name variants (`Authentication-Results :`, lower case, folded value, tab before the colon)
  all reach the recipient without any results header: the submission Sieve strips them. A planted `Received` stays
  but has nothing trusted below it.
- **Writing into someone else's folder:** not possible for customers — IMAP `SETACL` ends the connection
  (`imapAclSet` off) and `Mailbox/set { shareWith }` is `forbidden` (`CUSTOMER_PERMISSIONS`). File storage, which could
  share files with any account, is off entirely (`FileNode/*`, `/dav/file/`; above).
- **Writing into one's own mailbox:** IMAP `APPEND` (and JMAP `Email/import`) store a planted `Received` + results pair
  as is, with any internal date, which becomes the JMAP `receivedAt`. So the parser would trust it.

Decision: no further parser rule. A check that `receivedAt` agrees with our `Received` timestamp was considered and
rejected: the appender chooses both (verified above), and genuine mail can legitimately disagree (Stalwart writes
`Received` at DATA and `receivedAt` at delivery, which can be hours apart after a deferred local delivery), so it
would add false "Not checked" without stopping a deliberate plant. The remaining exposure is people who hold the
mailbox's own credentials: they can only mislead themselves, or the others sharing that mailbox — including the new
owner after "Make this a user" (messages planted before the handover, or through an IMAP session that outlives it;
"Mailbox passwords" above). A robust fix would be cryptographic: have the mail server ARC-seal inbound mail and
verify the seal (our key, configured, no DNS) in the webmail before trusting the results. Open item, not built.

### Internal mail (ADR-0019 update 2026-10-30)

Locally submitted mail has no results of ours, so for the remote-images "verified sender" rule the webmail also
accepts our server's **internal-mail marker** (`isInternalMail` in `original.ts`): exactly one `From`, one
`Message-ID` and one `X-AnhourMail-Internal` equal to
`hex sha256(K | hex sha256(K | "internal-mail-v1" | lowercase From | Message-ID))`, `K` = `SENDER_DELEGATION_KEY`.
Only the `sender-identity` submission script adds it (after removing any the client sent, and only once From is
proven to be the account's envelope sender); the `inbound-headers` script removes it from every unauthenticated
session (port 25). So an outside sender can't carry one in, not even one copied from a genuine message, and a copy
redirected by a mailbox's own rule has one only if the original was internal mail (whose From is ours) — the run-32
rule (no results of ours = not verified) is unchanged for everything else. Residual, as for planted results above:
whoever can write into a mailbox (IMAP `APPEND`, JMAP `Email/import`) can store a copy of a genuine message's marker
with that message's own From and Message-ID; a made-up marker fails without the key. The marker only affects the
remote-images choice; "Show original" and "mailed-by" / "signed-by" still show only our results. `stack:verify` checks
every path.

- **Only for mail that stays here:** no marker unless every envelope recipient is on a domain we host.
- **Second barrier in the reader:** never internal when any `Authentication-Results` or `Received-SPF` appears, or a
  `Received` by our host with anything but LMTP — Stalwart skips a missing or inactive `inbound-headers` script and
  delivers (verified), so the reader doesn't rely on the strip alone.
- **Exact header names** everywhere in `original.ts`: ASCII-only lowercasing, no `trim()`; look-alike names (NBSP, BOM,
  `\v`, which Stalwart keeps and doesn't delete) are counted but never taken for the real header.
- **`SENDER_DELEGATION_KEY` now does two jobs:** it authorises send on behalf and it vouches for internal mail. A leak
  lets someone both send on behalf of a delegated mailbox and forge a "verified sender" marker (for the reader, not
  for DKIM or DMARC): rotate it as an incident. Rotating it turns stored internal mail back to "not verified" (readers
  are asked again), which fails safe.

## Forwarding guard (ADR-0019 update "forwarding and DMARC")

A redirect leaves DKIM-signed with the forwarding mailbox's domain, so the managed rule never forwards mail our server
found failing DMARC, nor mail claiming the mailbox's own domain (or a subdomain) unless it has exactly one From and our
**top-most** results header ends in `dmarc=pass` for that domain (a pass for another `header.from` never counts). Only the top-most header can unlock forwarding (a planted one is below it), and the pass test is
end-anchored because a quoted MAIL FROM local part appears verbatim inside our own header (verified). A planted `fail`
only stops forwarding of the sender's own message. The web app's start-up upgrade rewrites only exact generator output,
only to the confirmed target, with a compare-and-swap on the Sieve state, and audits counts. In production the web app
refuses to start without a usable authserv-id (`MAIL_AUTHSERV_ID` entries must be hostnames).

## Image proxy (SSRF)

Built 2026-10-29. "Load images" in the webmail fetches remote images on the reader's behalf
(`apps/web/src/server/webmail/{image-proxy,remote-image}.ts`, route `POST /api/webmail/img`). The address comes from a
stranger's email, so the proxy is an SSRF surface and a tracking surface at once.

**Not an open proxy.** The proxy only fetches addresses it signed itself. When the reader's message view is served,
the sanitiser removes every remote `<img>` address and leaves an image link in `data-am-img`:
`v1.<expiry>.<base64url address>.<mac>`, HMAC-SHA256 under `BETTER_AUTH_SECRET` with its own domain string
(`am.webmail.image-link.v1`), over the address, the expiry (`REMOTE_IMAGES.linkMinutes`, 60) and the webmail session id
and active mailbox. A link from another session or mailbox, an altered one or garbage → 404; an expired one → 410
(the reader loads the message again for fresh links, once). There is no "sign this URL" endpoint. Signed-out → 401,
cross-origin → 403 (`route()`), then the webmail access and first-password gates.

**The fetch** (`fetchRemoteImage`):

- http/https only, ports 80/443 only (an explicit other port is refused), no credentials, ≤ 2,048 characters, the
  fragment dropped. Single-label names and `localhost`, `.local`, `.internal`, `home.arpa` are refused before DNS.
- We resolve the name ourselves (`dns.lookup`, all answers) and refuse it if **any** answer isn't public:
  0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.31.196/24, 192.52.193/24,
  192.88.99/24, 192.168/16, 192.175.48/24, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4; for IPv6 only
  2000::/3 is allowed at all, minus 2001::/23 (Teredo, benchmarking, ORCHID), 2001:db8::/32, 2002::/16 (6to4) and
  3fff::/20. IPv4-mapped addresses are judged as their IPv4 address; NAT64, IPv4-compatible, ULA, link-local,
  site-local and multicast fall outside 2000::/3. IP literals in the URL (including `0x7f.1`, `2130706433`,
  bracketed IPv6) go through the same check after URL parsing normalises them.
- **Pinned connection:** the socket connects to the checked IP itself (no second lookup, so DNS rebinding can't swap
  in an internal address); the Host header, SNI and certificate check use the name.
- Redirects (301/302/303/307/308) are followed by hand, at most 3, and every hop is checked from scratch (scheme, port,
  DNS, ranges). One deadline for the whole chain (10 s), DNS lookups included (a name that never answers
  ends at the deadline, so it can't hold a fetch slot).
- `Accept-Encoding: identity` (a compressed answer is refused: no decompression bombs); the size is capped at
  `REMOTE_IMAGES.maxMb` (5 MB) from Content-Length and while reading.
- Only raster images by their **magic bytes** (PNG, JPEG, GIF, WebP, BMP) — never SVG, HTML or anything else,
  whatever Content-Type says; the answer goes back with the sniffed type, `Content-Security-Policy: default-src
'none'; sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` and no
  Set-Cookie.
- Nothing about the reader goes out: no cookies, Referer, X-Forwarded-For or Origin, User-Agent `Mozilla/5.0`.
- At most 16 fetches in flight per process and 4 per webmail session (each holds ≤ 5 MB), then 429; the `webmailImage` tier (300 / 60 s per
  session, fail closed).

**Nothing loads in the frame.** The browser turns each answer into a `data:` URL (raster types only) and puts it in
the sandboxed `srcdoc` frame, whose own CSP stays `img-src data:`; the frame never makes a request. The link travels
in the POST body, never a path or query, so no image address reaches NGINX or Next access logs. The proxy logs only
the outcome (`reason`) or the byte count — never the address, its host or query (rule 24).

**Tracking pixels** (≤ 2×2) are still removed by the sanitiser and never get a link; CSS background images stay
blocked.

**Remembered senders** ("Always load from this sender") are stored in `webmail_preference.prefs.imageSenders` as
HMAC-SHA256 keys of the lowercased From address under the server secret, per mailbox (22 characters, ≤ 500), never
the address. The server sends a message's `senderKey`; the browser only compares and stores keys. A forged From
header can make a remembered sender's images load: that reveals to the forger only that the message was opened
through our proxy, never the reader's address. Audit records the changed preference keys only.

**Tests:** `remote-image.test.ts` (every blocked range, mapped/NAT64/6to4 forms, URL refusals, redirects to internal
addresses, the redirect limit, DNS rebinding, size caps, compression, SVG/HTML refusal, deadline, headers sent),
`image-proxy.test.ts` (links: other session, other mailbox, altered, expired; route logic 401/404/410/502/429 and
response headers; logs carry no address), `img/route.test.ts` (signed-out 401, cross-origin 403, tier),
e2e `webmail-images.spec.ts`.

## Profile photos

ADR-0022. Uploads are untrusted files that we then serve to other people, so we never serve what was uploaded:

- **Input:** the raw body (no multipart), capped at `AVATAR.maxUploadMb` before buffering (`readCappedBytes`);
  rate-limited (`avatarUpload`, 20 an hour per caller, fail closed); permission and scope are checked (and audited)
  before any decoding, so a refused or out-of-scope request never costs a decode.
- **Type by bytes only:** PNG, JPEG or WebP magic bytes (`sniffImage`); the declared type and file name are ignored.
  SVG, HTML, XML, GIF and polyglots that start as anything else are refused before the decoder sees them.
- **Decoding (sharp/libvips, `@anhourmail/adapters/image`):** `failOn: "error"` (corrupt or truncated files are
  refused, not half-decoded), a pixel ceiling (`limitInputPixels`, max side²) against decompression bombs, the decoded
  format checked again (PNG, JPEG or WebP), one frame only, each side within `AVATAR.minSide`–`AVATAR.maxSide`; at most
  two decodes at once per process (429 beyond).
- **Output:** a new file — auto-oriented, centre-cropped to 256×256, WebP, no metadata (EXIF, GPS, ICC, XMP,
  comments); anything a polyglot carried after the image data is gone. Checked again (a WebP, ≤ 256 KiB, also a
  database `CHECK`) and stored with its sha256. The browser crops and re-encodes too, but the server never relies on it.
- **Serving:** only from our own origins, only to viewers who may see that person or mailbox (404 otherwise), as
  `image/webp` with `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy:
same-origin`, `Content-Disposition: inline`, cached `private` (a year under the current version, revalidated
  otherwise). Never a remote URL; `auth_user.image` stays unused.
- **Logging and audit:** nothing about the image is logged; audit entries carry the stored size only (rule 48).
- **Webmail changes:** the webmail session proves only the mailbox password, which an admin of the mailbox's account
  can reset, so it may change the mailbox's person's photo only when that person is a member of the mailbox's account
  and of no other (`webmailRefusal`; refused `other_account` / `not_member`, audited as denied). Only current
  memberships count for who sees a photo: a removed person's old mailboxes keep `mailbox.user_id`, but that account
  no longer sees or changes their photo.
- **Webmail lookups** (`POST /api/webmail/avatars/lookup`, ≤ 100 addresses) answer only for mailboxes in the accounts of
  the session's own mailboxes, so they can't be used to learn anything about other accounts' addresses; the addresses
  travel in the body, never the URL or access log.

## Staff support access (act-as)

ADR-0023; roles.md guard rail 4. The threat is a staff member (or a stolen staff session) reading or changing a
customer's account without the customer knowing.

- **No second authorisation path.** The acting actor is built in one place (`getActorAndSession` → core
  `actingActor`): the staff member's own identity, platform roles set aside, one membership (the target account,
  `ACT_AS_ACCOUNT_ROLE` = `auditor`). Every service checks permission and scope as for anyone else, so writes and
  owner-only actions are 403 and other accounts 404 by construction. Services that must never run during act-as
  (mailbox passwords, app passwords, making users, staff tools) also refuse on `actor.actingAs` as defence in depth.
- **Step-up and reason.** Start and renew need a fresh step-up of that console session (the strongest factor the staff
  member holds) and a reason (10–500 characters, control characters collapsed) that the account's admins see and the
  Owners are emailed — staff are told never to paste secrets. Rate limit `sensitive` (fail closed).
- **Scope in time.** 30 minutes per start or renewal, 4 hours at most from the start, bound to the console session
  (`auth_session_id`); expired rows are never honoured (checked on every request); the scheduler closes and audits
  expired, signed-out and role-removed sessions.
- **Rule 28.** Never into an account where anyone holds a platform role or a company address, subdomains included
  (403 `staff_account`), so staff can't read colleagues' accounts this way. Re-checked on every request while acting:
  staff joining meanwhile drops the session at once (closed by the scheduler as `staff_account`).
- **Races.** One unclosed session per staff member is a partial unique index, not just a read-then-insert check.
- **Nothing of theirs in the customer's log.** Profile and photo writes, their own included, are refused while acting.
- **Step-up reuse.** A step-up from the last 5 minutes of the same console session counts (accepted, ADR-0023).
- **Future read endpoints** an Auditor can reach (message trace and similar) must stay metadata-only.
- **Visibility.** Banner on every page; every write and refusal audited as staff with `on_behalf_of`; start, renewal
  and end in the account's log and the platform log; Owners emailed at start (system layout, no tracking).
- **No mail.** No webmail link, handoff or session while acting; the console has no mail-content path.

## Data export and deletion (ADR-0025)

- **Mail never leaves the mail server to rest anywhere.** A mail export is a ZIP streamed from the person's own webmail
  session (`server/webmail/export.ts`): their token, their per-user queue, pinned to the mailbox active at the start
  (a switch mid-way stops it), the webmail access gate in front (`route()`), nothing written to disk, Postgres or logs
  (rule 24; the log records an error name only). No new mail-server credential or key scope was added.
- **Control-plane archives are sealed at rest.** `job:data-export` packs JSON/CSV into a ZIP and seals it with the key
  ring (`KeyRing.encryptBytes`, AES-256-GCM, HKDF purpose `data-export`, AAD `data_export:<id>`, key id in the output);
  only sealed bytes reach `data_export.archive` (a `CHECK` allows an archive only while `ready`). They expire after
  `DATA_EXPORT.keepDays` and are deleted. Opening one for another export id fails (AAD).
- **What an archive never holds:** mail, contacts, passwords or password hashes, app password secrets, Stalwart ids,
  TOTP secrets, recovery codes, passkey keys, staff-only notes (`internalNote` is stripped from audit meta), full IPs in
  an account's audit log (network part only, as the console shows). CSV cells starting with `=`, `+`, `-`, `@`, tab or
  CR are prefixed with `'` (formula injection). A personal export holds the network part of the person's own session
  addresses and their user agents, only mailboxes in accounts they belong to now, and only their own activity: in the platform log, entries both by and about them; in their accounts'
  logs, entries by them.
- **Download:** only the requester (anyone else's id, another account or kind: 404), after a fresh step-up on the
  console session (403 `step_up_required`), `Content-Disposition: attachment`, `nosniff`, `no-store`, the API CSP.
  Emails link to the console, never to a file.
- **Staff holds always win:** no deletion step runs while staff hold the account or any of its mailboxes (account or
  person suspension, or a hold), re-checked under the account lock; the purge skips any mailbox staff hold, for an
  account deletion and an ordinary mailbox deletion alike. The webmail mail export re-asks the access gate before each
  folder and every 50 messages; the handoff applies the deletion gate at redemption.
- **Deletion:** Owner only, fresh step-up, typed name, never while acting as someone or while staff have the account
  suspended; a 14-day grace period with mailboxes suspended at once (`deletion` holds) and the account frozen
  (`allowedWhileDeleting`); removal by idempotent audited steps that never run before `delete_after`, and never while
  staff hold the account suspended. Audit rows are never deleted (rule 47). Deleting one's own login needs a step-up
  and the typed address, locks the login row first, and is refused while any account depends on it.
- **Residuals:** (0) a person suspension that lands while a purge is between its check and its
  delete isn't serialised by the account lock (an account suspension is); the window is one transaction. (1) the mail
  export is bounded only by the `export` tier (5 per hour per webmail session) and the
  per-user JMAP queue; a very large mailbox makes one long response. (2) The key ring is shared by the worker and the
  web app; a leaked ring plus a database dump would open archives younger than 7 days (control-plane data only). (3)
  Logins of people whose account was deleted are kept until they delete them (no automatic expiry of account-less
  logins yet).

## Review process

1. Every change: the author runs `/security-review` on what they wrote (rule 5) and the full test suite (rule 37).
2. Before every commit: the `security-audit` skill as a scoped run over the pending diff with the `quick` profile. `confirmed` findings are fixed; `needs_validation` items are reported to the owner.
3. Changes to auth, RBAC, sending limits, signup gating, abuse logic, secrets, the JMAP proxy or the HTML renderer require a **`security-reviewer` agent pass** (read-only) before merge (rule 27).
4. A full `standard` audit before beta (Phase 8) and before public launch (Phase 9); an external pentest before public launch if budget allows.
5. Disclosure: `SECURITY.md` → security@anhourmail.com, acknowledge within 72 h, fix critical issues within 7 days.
