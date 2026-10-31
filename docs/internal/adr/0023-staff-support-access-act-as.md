# ADR-0023: Staff support access ("act as") is read-only, time-boxed and runs through the normal checks

**Status:** Accepted 2026-10-29 (updated 2026-10-29 after security review)

## Context

Support needs to see a customer's console the way the customer does (why a domain isn't verifying, which roles people
hold, why a mailbox is stuck) without asking for screenshots. The roadmap (Phase 3) and `roles.md` guard rail 4 already
promised "act-as": Global and Support Administrators only, a written reason, time-limited, a banner on every page,
every action audited with `on_behalf_of`, visible to the account's admins (rule 49), never mail content. The matrix
already had `platform.accounts.actAs` (★) and `ACT_AS_ROLES`; several services already refused when
`actor.actingAs` was set (mailbox passwords, app passwords, making users, staff suspension, staff-created addresses).
Nothing could start a session yet.

Constraints: services take the actor and check permission and scope themselves (rules 5, 25), so act-as must not
need a second authorisation path; out-of-scope ids stay 404; staff never act as staff (rule 28); audit entries are
append-only and must never hold secrets (rules 46–48); the console never reads mail and must never hand staff a
webmail session.

## Decision

1. **Who.** `platform.accounts.actAs` (★, existing name — camelCase like `platform.users.resetCredentials`; not
   renamed to avoid churn in the matrix, harness and docs) held by **Global Administrator and Support
   Administrator** (`ACT_AS_ROLES`). Trust & Safety, Billing and Reports Reader don't hold it: their work has its own
   staff pages and none needs the customer's view.

2. **Read-only only — no "with changes" mode.** While acting, the staff member holds exactly one membership: the
   target account with `ACT_AS_ACCOUNT_ROLE` = `auditor`. That role has only `*.read` permissions and no critical
   one (unit-tested over the matrix), so every change and every owner-only action (billing, deleting the account,
   admins and roles, sign-in requirements, passwords and two-factor of people, app passwords) answers **403** through
   the ordinary `authorize()`. A "with changes" mode for Global Administrators was considered and rejected for v1:
   - the fixes support makes already have dedicated, audited staff paths (credential resets, suspensions,
     staff-created addresses) with their own permission and step-up;
   - a writable mode would make "who changed this?" ambiguous for the customer and need per-action consent and
     review; a read-only session needs neither;
   - it keeps the blast radius of a stolen staff session to reading metadata the platform page already shows.
     A writable mode, if ever needed, gets its own ADR, permission and security review.

3. **The actor stays the staff member.** `getActorAndSession` (apps/web) looks up an open act-as session for the
   **console session** (only for people holding an act-as role, so customers pay nothing) and, if there is one,
   builds the actor with core `actingActor`: the staff member's own user id, email and sign-in state; **platform roles
   set aside** (staff pages 404 and staff APIs 403 while acting; ending drops back to them); memberships = the target
   account only (their own customer accounts, if any, are 404 while acting); `actingAs` = { session id, account id,
   staff role, reason, expiry }. If the account is suspended meanwhile, the usual suspension gate applies (403
   `account_suspended`). Every service runs its normal permission and scope checks — there is no bypass and no
   act-as branch in `authorize()`.

4. **Starting** (`POST /api/platform/accounts/:accountId/act-as`, from Platform → account → "Open with support
   access"): a reason (10–500 characters, control characters and runs of whitespace collapsed; the dialog says the
   account's admins see it and never to paste secrets), and a **fresh step-up** of that console session (the existing
   `POST /step-up` marker, 5 minutes). **Accepted:** a step-up done for something else within those 5 minutes counts
   here too (the marker is per console session, not per action); a per-action step-up would add a second prompt for
   no real gain, since the window is short and bound to the session. The step-up already demands the strongest factor the staff member has (a code
   when they use two-factor; a passkey sign-in when they only have a passkey), so "require a passkey if they have one"
   needs no new mechanism; requiring staff to enrol a passkey at all is the staff account's sign-in policy. Refused:
   no permission 403; unknown or malformed account 404 (recorded in the platform log only); no step-up 403
   `step_up_required`; **any account where a member holds a platform role or signs in with an `@anhourtec.com`
   address 403 `staff_account`** (rule 28; this covers the staff account and any account a staff member belongs to);
   a suspended account 409 (its details are on the staff page already); a second open session for the same staff
   member 409 (one at a time per person; end it first). **Several staff may act in the same account at once** — each
   is its own session, banner, audit trail and owner email.

5. **Time box.** `ACT_AS.minutes` = 30 per start or renewal; **renewable** from the banner with a new reason and a
   fresh step-up, never past `ACT_AS.maxMinutes` = 240 from the start (then end and start again). The session is bound
   to the console session that started it: other devices of the same person stay in the staff view, and signing out
   ends it in effect at once. Expiry is enforced on every request (an expired row is simply not found); the scheduler
   job `act-as-expiry` (every minute, database only) closes the record for sessions that expired, whose console
   session ended or whose staff member lost the role, and audits each.

6. **Audit.** `staff.act_as_started` (meta: reason, minutes, `access: read_only`, session id),
   `staff.act_as_renewed` (reason, new expiry), `staff.act_as_ended` (`ended`: `staff` | `expired` | `signed_out` |
   `role_removed` | `staff_account`, minutes) — each in the account's log and copied to the platform log. **Everything done while
   acting** (including every refused attempt) is recorded with actor type `staff`, the staff platform role, and
   `on_behalf_of` = `{ userId, email, accountId, sessionId }` (`auditActor`). The account's audit log shows these as
   "Anhourtec staff · Support access · <role> · <email>" and the "Anhourtec staff" filter finds them (rule 49).
   **Decided:** the staff member's own sign-in email (`on_behalf_of.email`, also the entry's actor email and the
   scheduler's `staff` meta) **is visible to the account's admins** — rule 49 asks that they can see who looked, not
   just that someone did; it is a work address, never a customer's. Reads
   are not audited one by one, like every other read in the console; the start, renewals and end bracket them.

7. **Visibility.** A banner under the app bar on every console page while acting ("You're acting in <account> as
   Anhourtec support — read-only. Ends at … · Extend · End"). The account's **Owners are emailed** at start through the
   branded system email layout (no tracking, nothing remote): read-only, how long, the reason given, the time, and a
   link to their audit log; the account name never appears in the sentence (customers choose it).

8. **Never webmail or mail.** The console has no mail-content path; act-as adds none. The webmail link is hidden while
   acting, and webmail sessions come only from the mailbox's own sign-in (ADR-0003) — act-as never creates one.
   **Decided:** any future read endpoint an Auditor can reach (and so staff while acting) — a message trace, delivery
   log, quarantine list — must stay **metadata-only** (ids, times, statuses, sizes; no subjects, bodies, previews or
   recipient lists beyond what the console already shows), or be kept out of `ACT_AS_ACCOUNT_ROLE`.

9. **Hardening (security review).**
   - **One open session per staff member is enforced by the store**, not only checked: a partial unique index
     `act_as_session_one_open_idx` on `(staff_user_id) WHERE ended_at IS NULL`, so two concurrent starts can't both
     insert; the loser gets the same 409 ("already have support access open"). Because the index counts every
     unclosed row, a start first closes and records (`staff.act_as_ended`, by the system) the staff member's own
     sessions that already ended in effect — run out or signed out — but that the scheduler hasn't closed yet.
   - **Staff addresses include subdomains** (`a@anhourtec.com` and `a@x.anhourtec.com`; the domain is compared,
     never pattern-matched, so `notanhourtec.com` doesn't count). Checked at start **and on every request while
     acting** (`actingActorFor`, one query): if someone in the account becomes staff or joins with a company
     address meanwhile, the session is ignored at once and the scheduler closes it as `staff_account`.
   - **No profile or photo writes while acting**, the staff member's own included (403, audited as denied
     `act_as`): their own edits would otherwise be copied into the customer's log as a change by staff.

10. **Rate limits.** Start and renew use the `sensitive` tier (30/h per caller, fail closed); End uses `write` (fail
    open: ending must never be blocked by the limiter's store).

## Consequences

- One new table, `act_as_session` (migration 0026, Safe): rows are kept after they end (who opened which account, why
  and for how long); `auth_session_id` has no foreign key so signing out keeps the row; cascades with the staff user
  and the account.
- The RBAC harness gets a new guard (`act_as`: a staff member with support access open; 404 for everyone else signed
  in) and three acting personas started through the real HTTP flow (Support and Global Administrator into account A,
  Support Administrator into account B), so every route's expectation for them comes from the same matrix.
- `onBehalfOf` gained `accountId` and `sessionId`; no act-as rows existed before, so nothing in the log changes shape.
- Open: the staff member's own security changes while acting (revoking their sessions, passkeys) are recorded in
  the accounts they belong to, which is the target account while acting; per-page view auditing while acting (today only start/renew/end and every write attempt); a staff-side list of
  open sessions; whether staff must hold a passkey (a staff sign-in policy) before act-as is allowed in production.

## Review checklist (security)

`packages/core/src/platform/act-as.ts` (start/renew/end/expire, staff-account refusal, step-up, reason parsing,
`actingActor`, `actingActorFor`, `isCompanyAddress`), `packages/core/src/people/profile-service.ts` and
`avatars/service.ts` (refusals while acting), `packages/core/src/audit/record.ts` (attribution), `apps/web/src/server/auth/actor.ts` (where the
acting actor is built), the three routes, `packages/adapters/src/db-postgres/act-as.ts` (open-session queries, `due`),
`packages/shared/src/rbac` (`ACT_AS_ACCOUNT_ROLE`), the banner and dialog, and the RBAC harness personas.

## Update 2026-10-31: the step-up is the console password (ADR-0028)

The decision above said the step-up demands the strongest factor the staff member holds. ADR-0028 replaced that for
every sensitive action: "Confirm it's you" is the console password (or a sign-in in the last 5 minutes), whatever the
person's factors or session type. Starting and renewing support access still need that fresh step-up on the same
console session; the window, the reuse within it and the refusals are unchanged. Requiring staff to hold a passkey
remains the staff account's sign-in policy (the passkey is then their second step at every sign-in).
