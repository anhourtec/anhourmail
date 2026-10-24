# 07 — Security

Last updated: 2026-10-22.

## Threat model

| #   | Threat                                                  | Asset                                   | Controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Malicious email HTML runs script (XSS)                  | Webmail session, mailbox data           | Server sanitiser + sandboxed iframe without scripts or same-origin; strict CSP; webmail on its own origin (`mail.`), separate from the console (`app.`); attachments never inline (`05-webmail.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T2  | Tracking via remote content                             | User privacy (IP, open times)           | Remote images blocked by default; image proxy without cookies or referrer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T3  | Account takeover (credential stuffing, phishing)        | Accounts, sending reputation            | Rate limits on auth (`rate-limits.md`), lockout, TOTP/passkeys, new-device alerts, app passwords for clients, compromised-account detection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T4  | Cross-account data access (IDOR)                        | All account data                        | Permission + scope checks in services; 404 for out-of-scope ids; RBAC harness with cross-account tests on every route (rule 25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T5  | Privilege escalation (member → admin, customer → staff) | Account control                         | One RBAC matrix; critical permissions non-delegable; last-owner guard; harness tests escalation attempts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| T6  | Staff abuse                                             | Customer trust                          | Act-as Global/Support only, time-limited, reason required, banner, audited, visible to the customer; no mail-content access path in the console                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T7  | Spam/abuse from our platform                            | IP and domain reputation, CASL exposure | Sign-up gating, phone verification, trust tiers, fail-closed send counters, Stalwart throttles, outbound scanning (`03-anti-spam-and-abuse.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T8  | Stalwart management API exposure                        | Every mailbox                           | Internal network only; three scoped API keys, one per job (web: app passwords + managed Sieve; worker: directory, no mailbox access; scheduler: + read-only script audit — ADR-0020 "Credential split"), IP allow-lists, start-up scope checks. The provisioning key's `sysAccountUpdate` can still set a password on any account (→ read mail, or master-user via `svc-ops`/`svc-audit`), so in production an internal **management proxy** refuses credential writes (except a mailbox password replacement on a User-role customer account carrying the web app's HMAC grant — residual: web and worker compromised together can set a customer password) and app-password writes on service accounts, the per-minute service-account check and the app-password reconciler report any that slip through, and NGINX refuses `svc-*`/`%`/Bearer logins publicly. Never the recovery admin in prod; NGINX blocks `/api`, `/admin`, raw `/jmap` publicly |
| T9  | Token or secret leakage                                 | Stalwart tokens, Stripe keys, DKIM keys | Key ring encryption with AAD; write-only secrets; redaction list in logs and audit; no tokens in the browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T10 | Mail content leaking into logs, analytics or errors     | Privacy promise                         | Content keys redacted by the logger; no third-party error reporting; rule 24 checks in review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| T11 | CSRF / cross-origin abuse of cookie sessions            | Console actions                         | Same-origin check on unsafe methods; `SameSite=Lax` host-only cookies; no CORS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T12 | SSRF via user-supplied hosts (IMAP import, image proxy) | Internal network                        | Allow public addresses only (block private, loopback and link-local ranges after DNS resolution); port allow-list; timeouts; no redirects to internal hosts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T13 | Audit tampering                                         | Accountability                          | Append-only DB grants; per-scope hash chain; daily verification job (`audit.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
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
  (`acceptInvite`); mailbox create and free-address claim (`createMailbox`), admin reset (`resetMailboxPassword`) and
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
`auth.password_reset` / `auth.password_changed`, meta counts). `/change-password` has no console UI yet and stays off
the allow-list; the hook already covers it.

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
- **Detection:** the worker records the Password `credentialId` after every create/reset/change
  (`mailbox.password_credential_id`); the hourly reconciler reports a mailbox whose credential differs
  (`passwordReplaced`) or was never recorded (`passwordUntracked`) as `platform.reconciler_drift`, never fixes it.
  **Limit (verified 2026-10-23):** Stalwart changes the id on the first replacement after creation but keeps it on
  later ones, so a replacement after one of our own resets isn't visible this way. Needs a better signal (open item).

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
  `lang`, `style`); no `on*`, `class`, `id`, `srcdoc`, `formaction` or `data-*`.
- **URLs:** links http, https, mailto, tel (control characters and entities decoded first; relative and
  protocol-relative removed), always `target="_blank" rel="noopener noreferrer"`. Images https, `cid:` or raster
  `data:` (PNG, JPEG, GIF, WebP) up to `WEBMAIL_HTML.inlineImageKb`; an image without a valid source is removed.
- **CSS:** escapes and comments decoded first; declarations split outside quotes and parentheses; a property
  allow-list; values with `<>{}@\`, unbalanced quotes, a `;` outside `url()`, `expression()`, `javascript:`,
  `vbscript:`, `behavior`, `-moz-binding`, `image-set()` or `element()` are dropped; `url()` only for https and
  raster data images; `position` only `static`/`relative`. Style attributes over 8 KB are dropped.
- **Size:** input over `WEBMAIL_HTML.maxMb` is refused (the drafts schema and the composer both check).
- **In the editor:** sanitised HTML sits in the page's own document while it is edited; the webmail CSP (nonce
  scripts only, same-origin images) is the backstop, so a sanitiser miss can't run script or fetch remote images
  there. Remote images are counted and the person is warned they may be trackers; they are sent as written.
- Tests: `outgoing-html.test.ts` (XSS corpus: script/SVG/MathML, encoded and whitespace `javascript:` variants,
  `data:text/html`, `srcdoc`, `formaction`, CSS `url(javascript:)` and escapes, mutation-XSS nesting, comments and
  CDATA, idempotence).

## Review process

1. Every change: the author runs `/security-review` on what they wrote (rule 5) and the full test suite (rule 37).
2. Before every commit: the `security-audit` skill as a scoped run over the pending diff with the `quick` profile. `confirmed` findings are fixed; `needs_validation` items are reported to the owner.
3. Changes to auth, RBAC, sending limits, signup gating, abuse logic, secrets, the JMAP proxy or the HTML renderer require a **`security-reviewer` agent pass** (read-only) before merge (rule 27).
4. A full `standard` audit before beta (Phase 8) and before public launch (Phase 9); an external pentest before public launch if budget allows.
5. Disclosure: `SECURITY.md` → security@anhourmail.com, acknowledge within 72 h, fix critical issues within 7 days.
