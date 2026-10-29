# ADR-0018: Webmail sessions via OAuth code flow, push sizing, and submission transport hardening

- Status: Accepted, 2026-10-21
- Related: `../05-webmail.md` ("Session acquisition", "Sync", "Push"), `../02-mail-infrastructure.md` ("Transport
  security"), `../12-encryption-and-security-posture.md`, ADR-0003, ADR-0016

## Context

The webmail BFF must hold a per-user Stalwart session without exposing it to the browser (ADR-0003), and must size
its upstream connections against Stalwart's `maxConcurrentRequests` (4 per user). Phase 0 also left the transport
defaults on the clear-text ports unverified.

Experiments on v0.16.27 (2026-10-21, throwaway objects deleted):

- **OAuth:** with an `x:OAuthClient`, `POST /api/auth {type:"authCode", accountName, accountSecret, clientId,
redirectUri, codeChallenge, codeChallengeMethod:"S256"}` returns `client_code`; `POST /auth/token` with the PKCE
  verifier returns a 1 h `access_token`, a `refresh_token` and an `id_token`. Bearer works on `/jmap/session` and
  `/jmap`. Wrong verifier → `invalid_grant`; wrong password → `{type:"failure"}` (HTTP 200). Refresh issues a new
  access token. A mailbox password change revokes both tokens.
- **Concurrency:** 40 concurrent heavy requests → 16–20 succeed, the rest `400 urn:ietf:params:jmap:error:limit`.
  One WebSocket (`/jmap/ws`, `WebSocketPushEnable`) plus five EventSource streams for the same user did not reduce
  the number of successful requests: long-lived channels do not count against the limit.
- **Transport:** TLS 1.2/1.3 only. IMAP 143 advertises `LOGINDISABLED`, POP3 110 refuses USER/PASS, port 25 refuses
  AUTH — but submission 587 offered `OAUTHBEARER`/`XOAUTH2` before STARTTLS (default `x:MtaStageAuth.saslMechanisms`).
  After the change below, 587 offers nothing until STARTTLS, then PLAIN/LOGIN/OAUTHBEARER/XOAUTH2 over TLS 1.3.
  MTA-STS defaults to `testing` (max-age 7 days) and REQUIRETLS is enabled by default.

## Decision

1. The BFF acquires webmail sessions with the **headless authorization-code + PKCE flow**. The user signs in to the
   webmail with mailbox address and password (and TOTP when enabled); the BFF exchanges them once, stores access and
   refresh tokens encrypted server-side keyed to the webmail session, refreshes before expiry, and treats 401 /
   `invalid_grant` as signed out. Mailbox passwords are never stored (they are argon2id PHC strings in Stalwart).
   The impersonation service account stays back-office only.
2. The BFF keeps **one upstream push channel per active user** (WebSocket, EventSource fallback) and a **per-user
   queue with at most 4 JMAP requests in flight**, retrying `limit` errors with jittered backoff.
3. `x:MtaStageAuth.saslMechanisms` offers mechanisms **only when `is_tls`** on non-25 ports (no clear-text OAuth
   tokens on 587). Applied in `infra/stalwart/dev-plan.ts`, required in production, checked by `npm run stack:verify`.

## Consequences

- A webmail sign-in form is required (Phase 4); the console → webmail handoff only pre-fills the address.
- Password changes sign the user out of the webmail everywhere — desired behaviour, explained in the UI.
- The 4-request queue bounds per-user throughput; if measurement shows it limits the UI, raise `Jmap.maxConcurrentRequests`
  (the queue stays).

## Alternatives

- External OIDC directory pointing at our IdP: single identity, but all accounts become external (no Stalwart
  passwords) and one directory server-wide in Community; revisit later.
- Impersonation service account for every webmail request: one god credential that bypasses the user's MFA; rejected
  for interactive use.

## Update (2026-10-29)

- **No address pre-fill.** Since 2026-10-23 the console's **Open webmail** links to the bare sign-in page: nothing in
  the URL fills in the address, because a sign-in link carrying an email address looks like phishing to browsers'
  checks and anyone could craft one. The consequence "the console → webmail handoff only pre-fills the address" no
  longer holds; the handoff carries nothing.
- **Push is not built yet.** Decision 2 stands; meanwhile the client asks `Email/changes` every 30 s while the tab
  is visible (at once on focus or reconnect, backing off after errors) and reloads the open conversation in place
  when a change touches it (05-webmail.md "Push").
- **Password changes.** A person changing their own mailbox password in the webmail stays signed in in that session
  and is signed out everywhere else; an administrator's new password signs the webmail out everywhere. A mailbox
  whose password an administrator set with "change at first sign-in" sees a password step before any mail
  (05-webmail.md "First-sign-in password step").

## Update (2026-10-29, later): console handoff

- **The console now hands off.** ADR-0024: **Open webmail** opens the person's own mailbox without its password, with
  a one-time code bound to the browser (a verifier cookie on the webmail origin) and to the console session, redeemed
  for a throwaway app password the operations key mints, the BFF uses once at `/api/auth` and destroys. The session it
  makes is the one decision 1 describes; the password sign-in form stays for everyone else. Still nothing in a URL
  pre-fills the address.
