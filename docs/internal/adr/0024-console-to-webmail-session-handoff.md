# ADR-0024: Console → webmail session handoff with a one-time, browser-bound code and a throwaway mail-server credential

**Status:** Accepted 2026-10-29 (updated the same day after security review: step-up, same-site auto-continue, code
burnt without a verifier, session tied to the console session, credential-list lock)

- Related: ADR-0003 (one app, two origins), ADR-0018 (webmail OAuth sessions), ADR-0020 (app passwords issued by the
  control plane, credential split, management proxy), ADR-0023 (act-as never reaches mail), `../05-webmail.md`
  "Session acquisition" and "Console handoff", `../07-security.md` "Webmail handoff", `../rate-limits.md`,
  `../audit.md`.

## Context

The console's **Open webmail** took the person to the bare webmail sign-in page: they typed their mailbox password
again. Since 2026-10-23 nothing in the URL pre-fills the address (a sign-in link carrying an address is the shape of a
phishing link, ADR-0018 update). The roadmap ("Path to production" step 8) asks for a real handoff.

The core problem: Stalwart issues the webmail's OAuth tokens only for a credential (`POST /api/auth`), and we never
store or know a mailbox password (rule 23; mailbox passwords are argon2id PHC strings in Stalwart). Constraints for
any mechanism: one-time, short-lived (≤ 60 s), bound to the console session, the person and the mailbox, useless from
another browser; only the person's own mailbox (never a shared address or someone else's); never while staff act as
someone (ADR-0023); respect the first-sign-in password change, suspensions and the webmail access gate; audited
(start, success, failure; no secrets); rate-limited; and the web container keeps reaching Stalwart only through the
internal management proxy with its least-privilege operations key.

### What the pinned Stalwart v0.16.27 offers (checked on the dev server, 2026-10-29; throwaway domain, accounts and real service keys, all destroyed)

| Option                                                        | Result                                                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth token exchange (RFC 8693) or an admin-issued user token | Not offered: `/.well-known/oauth-authorization-server` lists `authorization_code`, `refresh_token` and the device code grant only. The device grant still needs the user's credential at `/api/auth`. |
| `/api/auth` with an API key                                   | The operations key as `accountSecret`, or as `Authorization: Bearer`, for a customer account → `{"type":"failure"}`.                                                                                  |
| Master-user (`mailbox%service`)                               | Needs a service-account **password**; ours have none and the management proxy refuses `%` and service names at `/api/auth` (ADR-0020). Rejected for interactive use in ADR-0018.                      |
| **A throwaway app password minted by the operations key**     | Works (below).                                                                                                                                                                                        |

The throwaway credential, made with the real operations key (`impersonate` + `sysAppPassword*`, no mail access) through
`x:AppPassword/set { accountId }`, with **every** known permission and the self-service ones turned off except
`authenticate` and `expiresAt` 60 s ahead:

- `/api/auth` (authCode + PKCE) accepts it; the token is account-wide (186 permissions, exactly a customer password's
  — ADR-0020 already recorded that tokens ignore a credential's own limits), `Mailbox/get` works.
- **Destroying the credential right after the exchange keeps the token and its refresh grant working** (the token key
  is derived from the account's Password, not from the credential used).
- An administrator's or the person's password change revokes these tokens too (401, refresh `invalid_grant`), like a
  password sign-in's.
- A destroyed credential, or one past `expiresAt`, is refused at `/api/auth` (`failure`); an expired one stays listed
  until destroyed.
- With every protocol permission off it can't be used for IMAP, POP3, SMTP, DAV or JMAP methods while it exists (the
  JMAP session document answers 200, methods are `forbidden`).
- Stalwart's `maxAppPasswords` ceiling (5 by default, equal to our per-mailbox limit) counts it: a mailbox with five
  app passwords couldn't get one.

## Decision

1. **Mechanism: a browser-bound one-time code (ours) redeemed for a throwaway mail-server credential (Stalwart's).**
   The webmail BFF exchanges the code for an app password the operations key mints for that one sign-in, uses it once
   at `/api/auth`, and destroys it; the person ends up with an ordinary webmail session (ADR-0018), indistinguishable
   from a password sign-in. No mailbox password is stored, typed or derived; no new key scope.

2. **Flow (three top-level navigations, nothing secret in any URL a server sees):**
   1. Console **Open webmail** → `GET <webmail>/api/webmail/handoff` (optionally `?mailbox=<id>`). The webmail origin
      sets a fresh 32-byte verifier in an HttpOnly, `SameSite=Strict`, 2-minute cookie (`__Host-am.handoff`;
      `am.handoff` in dev) and answers `303` to `<console>/open-webmail?challenge=<base64url SHA-256 of it>`.
   2. The console page lists the person's own usable mailboxes. With exactly one it continues by itself, but only
      when the browser reports the navigation came from our own site (`Sec-Fetch-Site: same-site` or `same-origin`,
      which the 303 from the webmail origin gives); a link from anywhere else, or a typed URL, shows an **Open**
      button instead, so another site can't make the console mint for the person. It POSTs
      `{ challenge }` to `/api/accounts/:accountId/mailboxes/:mailboxId/webmail-handoff` (same origin, CSRF-checked).
      The core service checks and audits, then stores a code (32 random bytes; Redis key = its SHA-256; TTL 60 s)
      bound to the person, the console session id, the sign-in method, the account, the mailbox and the challenge.
      The page moves to `<webmail>/handoff#<code>`: a URL **fragment**, which browsers never send to a server or in a
      `Referer`, and which the page removes from history at once.
   3. The webmail page POSTs `{ code }` to `/api/webmail/handoff` (same origin). The BFF takes the code atomically
      (`GETDEL`; a second use finds nothing) — **before** looking at the verifier, so a code presented by another
      browser (no cookie, or its own) is refused and used up — checks `SHA-256(verifier cookie)` against the
      challenge, clears the cookie and calls the core redemption, which re-checks everything below
      against the database **at that moment**, then opens the session.

3. **Who and what (checked at both ends, in the core services):** a new permission `webmail.open.own` (account scope,
   every account role, never staff roles — `roles.md` "Mail (webmail link)"). Only a mailbox whose `userId` is the
   person (shared and unassigned mailboxes and anyone else's: **404**); refused with **403** while acting as someone
   (`act_as`, before anything is looked up; at redemption also when the console session has act-as open by then);
   **409** while the mailbox isn't active on the mail server, is suspended, deleting or gone, or its person is
   suspended (the webmail access gate, `MailboxAccessGate`), or while it owes its first-sign-in password change
   (`password_change_required`: the person signs in with the password they were given, which the first-password step
   needs anyway). Redemption also requires the console session to still exist and to pass the account sign-in
   requirements it had to pass at sign-in (`sessionRefusalFor`), and rebuilds the person from the database (roles,
   suspension, staff account suspension, required factors, console password change), so a change in the 60 s between
   the two steps wins. **Step-up:** minting needs a recent step-up on that console session (`stepUpFresh`: a password
   or code in the last few minutes, a fresh sign-in counts), exactly as creating an app password or setting a mailbox
   password does; the console page asks for it in place ("Confirm it's you") and continues. Redemption checks it is
   still fresh. (Maintainer decision after security review: a stolen console session alone must not open mail.)

4. **The throwaway credential.** Description `AnhourMail webmail handoff`, `expiresAt` 60 s, `Disable` of every known
   and self-service permission except `authenticate` (`handoffCredentialPermissions`). Minted with the operations key
   **inside** the redemption (after the checks), exchanged with the end user's address forwarded (Stalwart's own
   per-address limits apply), destroyed in a `finally`. If the destroy fails it expires within the minute; the next
   handoff for that mailbox first destroys expired handoff credentials, and the reconciler leaves them out of the
   app-password comparison only when description, exact permissions **and** a lifetime ≤ 120 s all match. The
   webmail session then checks that Stalwart's session `username` is the mailbox address we expected before saving
   anything.

5. **The webmail session follows its console session.** A handoff-born webmail session records the console session
   it came from; when that console session no longer exists (signed out, "sign out everywhere", revoked from the
   Security page, a password reset), the webmail session ends: checked on every webmail request (`route()`'s access
   check and `WebmailService.session`), with "still there" cached ≤ 30 s and a failed check counted as ended. If
   anything fails after the webmail session is created (the audit append, the commit), the session is deleted again.

6. **One writer at a time per mailbox credential list.** Stalwart removes a credential by its list position, so the
   revocation job, the handoff (make, use, destroy, clear leftovers) and app-password creation each take a
   transaction-scoped lock on the mailbox (`AppPasswordRepository.lockCredentials`, `pg_advisory_xact_lock`); a
   handoff credential can't shift the position a revocation is about to patch.

7. **A reserved slot.** Customer accounts get `maxAppPasswords` = our limit + 1 (`CUSTOMER_APP_PASSWORD_QUOTA`, set by
   `mailbox.ensure`), so a mailbox with five app passwords can still be opened; existing mailboxes pick it up on their
   next ensure, and until then a full mailbox falls back to the sign-in page.

8. **Audit** (rule 46, no secrets, codes or challenges): `webmail.handoff_started` (success, or denied with
   `act_as` / `not_found` / `mailbox_unavailable` / `password_change_required`, or a matrix refusal) and
   `webmail.handoff_redeemed` (success; denied `wrong_browser`, `expired`, `session_ended`, `act_as`, …; failed when
   the mail server refused). Both land in the mailbox's account log. An unknown or already-used code has no subject
   and is only logged (no audit row).

9. **Rate limits:** `webmailHandoff` 10 per 10 min per console session (the code mint; fail closed) and
   `webmailHandoffIp` 30 per 5 min per client address (the start and the redemption; fail closed). A Redis outage
   refuses the handoff; the sign-in page still works.

10. **Fallback.** Every refusal ends on a page that explains it and links to the ordinary sign-in page (no address in
    the URL).

## Consequences

- One click from the console to the inbox; the webmail sign-in form stays for everyone else (and for mail apps,
  "Add another mailbox", and mailboxes that owe a password change).
- The console session, together with a fresh step-up, becomes a way into the person's own mailbox — the same bar as
  creating an app password. A stolen console cookie alone isn't enough; one used within a few minutes of a real
  sign-in or step-up is (the step-up window), as for app passwords. People who just signed in go straight through;
  others confirm it's them once.
- The webmail session lives at most as long as a password sign-in's (30 days, 7 days idle), ends the same ways
  (password change, suspension, sign-out) and also when its console session ends.
- The operations key now mints a credential on **every** handoff: mail-server writes scale with webmail opens. Bounded
  by the rate limits above.
- No management proxy change is needed: `x:AppPassword/set` on customer accounts, `/api/auth` and `/auth/token` are
  already allowed for the web app (ADR-0020); the proxy still refuses service accounts and `%`. Optional ops hardening
  (private ops repo, documented there): a per-minute cap on `x:AppPassword/set` creates from the web app.
- Re-verify on every Stalwart upgrade (rule 22): the int test `packages/adapters/src/stalwart/handoff.int.test.ts`
  fails if a destroyed credential's token stops working, if an expired one is accepted, or if the reserved slot isn't
  honoured; it also checks that the credential lock serialises across connections and that concurrent app-password
  creates can't pass the limit (the account row lock), so the reserved slot stays free.

## Alternatives

- **Pre-select the mailbox on the sign-in page only** (no credential): safe but still asks for the password; kept as
  the fallback, never with the address in the URL (ccd94d3).
- **Code in the URL query string** (classic OAuth redirect): codes would land in proxy access logs and history;
  the fragment avoids both at the cost of one client-side step.
- **Bind to the console cookie:** host-only cookies on `app.` are invisible to `mail.` (ADR-0003), and in dev the two
  share one cookie jar by port, so binding to it would behave differently in dev and production. A verifier cookie set
  by the webmail origin itself behaves the same in both.
- **Keep a long-lived per-person webmail app password:** a standing credential with account-wide token reach;
  rejected (ADR-0020 "OAuth escalation").
- **Impersonation service account for the session:** one credential that reads every mailbox; rejected (ADR-0018).
