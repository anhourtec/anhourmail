# 07 — Security

Last updated: 2026-10-22.

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
- Sign-in: TOTP + WebAuthn security keys/passkeys + recovery codes for the console ("Sign-in factors" below); per-device scoped app passwords for mail protocols (Stalwart has no WebAuthn).
- Cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, host-only (separate for `app.` and `mail.`).
- Secrets: AES-256-GCM, key ring with key ids, HKDF-derived keys, AAD per row, required in production, re-encryption job (`research/reference-patterns.md` pattern 5). Implemented in `packages/server/src/keyring.ts` (`SECRETS_KEYRING="id:base64key,…"`, first = active; dev derives a key from `BETTER_AUTH_SECRET`); first user: webmail session tokens. The re-encryption job is still to come (`keyIdOf` finds values under a retired key).
- Logging: JSON, request ids, redaction list (`packages/server/src/log.ts`), and no `console.*` in server code (`check:logging`).
- Dependencies: exact versions, licence allowlist, weekly update review.

## Password storage

Decision 2026-10-21 (maintainer): passwords are stored only as **salted hashes from a deliberately slow
algorithm — argon2id**.

| Secret                                 | Where                            | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console password (better-auth)         | Postgres `auth_account.password` | argon2id PHC string, random 16-byte salt per hash, OWASP baseline `m=19456 KiB, t=2, p=1`, 32-byte output (`packages/adapters/src/auth/password.ts`, wired into better-auth via `emailAndPassword.password`). `needsRehash()` flags weaker parameters for upgrade on next sign-in.                                                                                                                                                                                                           |
| Mailbox password (IMAP/POP3/SMTP/JMAP) | Stalwart's store                 | The control plane hashes with the same argon2id parameters and sends the **PHC string**, never the plaintext, to Stalwart's management API; Stalwart stores and verifies it as-is (verified 2026-10-21: IMAP 993, POP3 995, SMTP 465 AUTH and JMAP sign-ins pass with pre-hashed credentials — `npm run stack:verify`). Because Stalwart's own strength check only runs on plaintext, password-strength rules (min 12 chars + breached/weak checks) run in the control plane before hashing. |
| App passwords                          | Stalwart                         | Generated by Stalwart (`app_` + 36 random lowercase letters and digits) when the control plane asks, stored hashed by Stalwart, shown to the person once in the create response; never stored, logged or audited by us ("App passwords" below).                                                                                                                                                                                                                                              |
| API keys / invite / reset tokens       | Postgres                         | Only a SHA-256 of a high-entropy random token is stored (tokens are not passwords; slow hashing is unnecessary).                                                                                                                                                                                                                                                                                                                                                                             |
| Third-party secrets                    | Postgres                         | AES-256-GCM with a key ring (CLAUDE.md rule 16) — encryption, not hashing, because we must use them.                                                                                                                                                                                                                                                                                                                                                                                         |

Never: plaintext, reversible encryption, unsalted or fast hashes (MD5/SHA-x) for passwords; never log or audit
password material (redaction list).

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

## App passwords

Built 2026-10-22 (ADR-0020). Code: `packages/core/src/app-passwords`, `packages/stalwart-client/src/app-passwords.ts`
(permission sets), `packages/adapters/src/stalwart` (`stalwartAppPasswords`), `apps/web/src/app/(console)/accounts/[accountId]/app-passwords`,
`apps/web/src/components/app-passwords/*`. Facts: `packages/shared/src/security.ts`.

- **Who:** only the person a mailbox belongs to creates its app passwords (`app_password.manage.own`, every role but
  the Auditor). People with `mailbox.read` see their names and dates on the mailbox panel; people with `mailbox.manage`
  revoke them (an Owner's or admin's mailbox: Owners only, as for suspending). Nobody ever sees a secret after the
  create response. Never while staff act as the person (403, audited `denied` `act_as`): an app password opens mail.
- **Step-up:** creating one needs the session's step-up marker (`auth_verification` `step-up-<session id>`, written by
  a sign-in that proved the person's strongest factor or by `POST /api/auth/step-up`, valid `STEP_UP_MINUTES`). It is
  read, not used up, so several app passwords can be made in the window. Missing → 403 `step_up_required`, audited.
  The account sign-in requirement still applies (the permission is account-scoped, so `mustEnrol` blocks it).
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
  off with `Disable`. That is a `Replace` allow-list in effect: real `Replace` can only grant what the management key
  holds itself, so it would need a key that reads every mailbox (verified). New permission names in an upgrade fail
  the integration test until they're classified. Default: IMAP, SMTP, contacts and calendars; POP3 and JMAP opt-in.
  Never: Sieve and vacation writes, principal look-ups, sharing, alias sign-in, invitations or alarms sent by mail.
- **On the account too** (`CUSTOMER_DENIALS` in `CUSTOMER_PERMISSIONS`, also in `SUSPENDED_PERMISSIONS`; the reconciler's `sieveLocked` drift check covers the whole list): every self-service permission
  (`sysAccountPassword*`, `sysAppPassword*`, `sysApiKey*`, masked email, …) and the principal look-ups are off for the
  whole customer account, whatever signs in — the mailbox password, an OAuth token, an app password. Verified: a
  token minted from an app password straight at Stalwart answers `forbidden` to `x:AppPassword/set`,
  `x:ApiKey/set` and `x:AccountPassword/set`; `Principal/query` (which listed every account on the server before)
  is `forbidden`; mail, identities and contacts still work; the management key still creates, lists and destroys
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
- **Managed scripts** (`reconcileManagedScripts`, hourly): each active mailbox's script must carry our settings line,
  redirect only to its confirmed forwarding target and use no extension the webmail never writes (notify, variables,
  extprograms, …). Drift is reported (`platform.reconciler_drift`, counts only) and `mailbox.ensure` re-queued; the
  script is never deleted or rewritten. Matters because the management key can write Sieve on any account.
- **Reconciler** (`reconcileAppPasswords`, hourly): lists every mailbox's `x:AppPassword` and `x:ApiKey` and reports
  credentials with no row, with permissions that aren't what their row's protocols give, rows the server lost, and any
  API key (end users never get one); re-queues pending revocations whose job gave up (ones still queued or running count as in flight, not drift). Report and audit
  (`platform.reconciler_drift`, counts only) — never revokes or deletes by itself (rule 26).
- **Per mailbox:** at most `APP_PASSWORDS_PER_MAILBOX` (5, Stalwart's default `maxAppPasswords`), counting ones being
  revoked; suspended, deleting and not-yet-provisioned mailboxes can't get new ones (409). Suspension blocks them
  (Stalwart's `authenticate` is off for the account) and resuming restores them; deletion destroys them with the
  account at purge.
- **Revocation:** `active → revoking` in the request (audited), then the worker's `app_password.revoke` job destroys
  each credential, matching id **and** creation time (Stalwart reuses ids), then deletes the row. Revoke one or all;
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
- Invite emails have a generic subject; the account and inviter names (chosen by the inviter) appear only in the
  body, escaped. Sending is rate-limited per caller (`invite` tier) on top of the daily cap.
- Tokens: 256-bit, only the SHA-256 is stored, the token travels in the URL path (`/invite/<token>`) and in the
  sign-in `next` query, never in an API response or our logs (`logPath` redacts it). Pages carrying it send no
  referrer. **Production NGINX must not log the `/invite/<token>` path or the `next` query** (`deploy/README.md`).

## Review process

1. Every change: the author runs `/security-review` on what they wrote (rule 5) and the full test suite (rule 37).
2. Before every commit: the `security-audit` skill as a scoped run over the pending diff with the `quick` profile. `confirmed` findings are fixed; `needs_validation` items are reported to the owner.
3. Changes to auth, RBAC, sending limits, signup gating, abuse logic, secrets, the JMAP proxy or the HTML renderer require a **`security-reviewer` agent pass** (read-only) before merge (rule 27).
4. A full `standard` audit before beta (Phase 8) and before public launch (Phase 9); an external pentest before public launch if budget allows.
5. Disclosure: `SECURITY.md` → security@anhourmail.com, acknowledge within 72 h, fix critical issues within 7 days.
