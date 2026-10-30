# ADR-0026: Mailbox delegation (read and manage, send as, send on behalf) and shared mailboxes, through BFF-held mailbox tokens

**Status:** Accepted 2026-10-30 (maintainer decisions below; slices 1–14 built, see the dated updates; no auto-mapped
"Shared with you" list in the UI for now, update of 2026-10-30)

**Maintainer decisions (2026-10-30):** behaviour follows the conventional enterprise mailbox-delegation model exactly
(design reference, gitignored: `../private/2026-10-30-delegation-reference.md`).

1. **Who grants:** Owners and User Administrators, with guard rail 8 (an Owner's or an admin's mailbox needs an
   Owner).
2. **No extra two-factor step for delegated access:** the delegate's own sign-in is enough, from any webmail session
   of their own mailbox. Delegated mailboxes appear on their own (auto-mapping) and can also be opened by address
   with **Open another mailbox** (decision 6, "Open another mailbox").
3. **Shared mailboxes with no password at all** ("sign-in blocked") come as a follow-up slice with the management
   proxy rule. v1 keeps the generated password nobody is shown.
4. **The on-behalf tag left in stored Sent/Drafts copies** is accepted as a residual; rotating the key is the remedy.
5. **Mail-app (IMAP) access to delegated mailboxes** gets a later ADR (a fourth, web-only sharing key plus a
   per-folder reconciler).

- Related: ADR-0003 (webmail behind a BFF), ADR-0013 (collaboration on Stalwart Community; this ADR supersedes its
  decision 1 for shared mailboxes and delegation), ADR-0018 (webmail OAuth sessions), ADR-0019 (sender identity
  enforcement; amended below), ADR-0020 (credential split, management proxy), ADR-0023 (act-as never reaches mail),
  ADR-0024 (handoff credential, credential lock, reserved slot), `../10-collaboration.md` "Stalwart mapping",
  `../07-security.md` "Leavers", "Mailbox passwords", `../roles.md` guard rail 8, `../audit.md`, `../rate-limits.md`.

## Context

Maintainer decision 2026-10-29 (`09-roadmap.md` "Maintainer decisions"), refined 2026-10-30: follow the conventional
admin-centre delegation model exactly.

1. **Three separate per-mailbox permissions**, granted by an administrator in the console on the mailbox's
   "Delegation" tab, each a list of people that can be added to or removed from:
   - **Read and manage** (full access): open the mailbox, read, move and delete in every folder. **No sending.** The
     mailbox shows up in the delegate's webmail by itself (no "add mailbox" step).
   - **Send as**: mail comes from the mailbox, with no sign of the delegate.
   - **Send on behalf**: `From:` is the mailbox, `Sender:` is the delegate ("Delegate on behalf of Mailbox").
   - Any combination; when someone holds both send rights, send as wins.
2. **Shared mailboxes:** no sign-in of their own, not a person (no seat). Members get read and manage plus send as.
   A person's mailbox can be **converted to shared** and back.
3. **Leavers:** block sign-in → convert to shared → give the manager read and manage (optionally send as) →
   optionally an automatic reply and forwarding → remove the person. Removal already does the first, second and last
   steps (2026-10-30: each mailbox released as person-less, new password nobody is shown, app passwords revoked);
   the removal dialog must be able to offer "Give full access to …".
4. **Sent items:** mail sent as or on behalf of a mailbox gets its copy in **that mailbox's** Sent folder (default).
5. **Delegate's view:** delegated mailboxes open in the delegate's own webmail next to their own, without signing in
   again; the From picker offers every mailbox they may send as or on behalf of.
6. **Admin-only and audited:** grants are made only by administrators, scoped to the account; every grant, revoke and
   every delegated send is in the audit log; the UI says changes can take a short while.
7. **Out of scope, but leave room:** owner-granted folder permissions, calendar delegates.

Constraints: the mail server is driven only through its management API (ADR-0001), tenancy is ours (ADR-0002), the
browser never holds a mail-server token (rule 21), we never store or know a mailbox password (rule 23), no mail
content in Postgres, logs or audit (rule 24), out-of-scope ids answer 404 (rule 25), provisioning that changes the mail
server is a job (rule 26), the worker image never gets owner access to mailboxes (ADR-0020 "Credential split").

### What the pinned Stalwart v0.16.27 can and can't do (live probes on the dev server, 2026-10-30)

Throwaway `dlgprobe-*` accounts on `dev.test` with the customer permission set copied from a demo mailbox
(`CUSTOMER_PERMISSIONS`), the dev administrator for set-up, the real `StalwartManagement.createHandoffCredential` and
`StalwartOAuth.signInWithHandoffCredential` for tokens; DATA-script experiments scoped to the probe accounts only by an
`authenticated_as == …` branch. Every probe account, script and lookup key was destroyed and the DATA-stage wiring
restored afterwards (and re-checked: a forged `From` and a forged `Sender` were refused again with 5.5.3). The
outcome of each probe:

| #   | Question                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Can an individual account (`x:Account` `@type: "User"`) with mail become a `Group`? | **No.** `x:Account/set update { "@type": "Group" }` → `invalidProperties` "Cannot change the type of an existing account." A Group-based shared mailbox would need a new account and every message moved.                                                                                                                                                                                                                                                                                                   |
| P2  | Can a User be a "member" of another User (`memberGroupIds` → a User id)?            | **No.** `invalidForeignKey` (only Group ids are accepted). Group membership can't grant access to an individual mailbox.                                                                                                                                                                                                                                                                                                                                                                                    |
| P3  | Can management grant folder access without the owner's password?                    | **Yes, but only with mailbox rights on the key.** The administrator acting on the account by `accountId` ran `Mailbox/set { "shareWith/<delegate>": rights }` on every folder; the delegate's JMAP session then listed the mailbox as a second account (`isPersonal: false`, `isReadOnly: false`) with exactly those rights (`mayShare: false` kept). The customer's own token can't do this (`jmapMailboxUpdate` is in `CUSTOMER_DENIALS`), and none of our three service keys holds `jmapMailbox*`.       |
| P4  | What does a folder-shared delegate get?                                             | `Mailbox/get`, `Email/query`, `Email/get` and `Email/set` (keywords) on the shared account work. `Identity/get` and `EmailSubmission/*` on it → `forbidden` "You are not an owner of account …". A draft could be created in the shared Drafts but not submitted.                                                                                                                                                                                                                                           |
| P5  | Can the delegate send as the other mailbox from their own account?                  | **No.** `Identity/set create { email: <other mailbox> }` in the delegate's account → "E-mail address not configured for this account". `EmailSubmission` with `envelope.mailFrom` = the other mailbox → `forbiddenFrom` "Envelope mailFrom does not match identity email address" (a JMAP check, before `mustMatchSender`).                                                                                                                                                                                 |
| P6  | Send on behalf (`From:` mailbox, `Sender:` delegate)?                               | Refused by our own `sender-identity` script (ADR-0019) from either side: from the delegate's account, `From` ≠ envelope (5.5.3 "The From address must match…"); from the mailbox's account, `Sender` ≠ envelope (5.5.3 "The Sender address must match…").                                                                                                                                                                                                                                                   |
| P7  | A mailbox token without its password?                                               | **Yes.** A throwaway handoff credential (ADR-0024) on a person-less mailbox gave an account-wide token (`Mailbox/get` 6 folders, `Identity/get` its identity). After **removing the account's Password credential entirely**, existing tokens stopped (401) and a **new** throwaway credential still gave a working token: a mailbox with no password at all can still be opened by us.                                                                                                                     |
| P8  | Can a Sieve system script hold a keyed check for "on behalf"?                       | **Yes.** At DATA, `vnd.stalwart.expressions` `let` with `header.sender.addr`, `envelope.from`, string `+` and `hash(…, 'sha256')` work; a standard `header :is "X-AnhourMail-On-Behalf" "${tag}"` compares it. With the tag computed as `sha256(K \| envelope.from \| sender)`: right tag → delivered with `From` mailbox, `Sender` delegate, the tag header removed, DKIM `d=` the mailbox's domain; wrong tag, no tag, a tag for another sender, and a delegate forging `From` even with the tag → 5.5.3. |
| P9  | Can the check use a server-side list instead (`x:MemoryLookupKey` + `key_exists`)?  | **Not on this version, as far as probed.** Keys created through management (custom namespace) were never found by `key_exists('<namespace>', key)` in Sieve, even after `ReloadSettings` (six call forms tried). Not used.                                                                                                                                                                                                                                                                                  |
| P10 | DKIM and DMARC for mail sent through the mailbox's own account                      | `dkimSignDomain` follows the envelope sender's domain, so a send with envelope = the mailbox is signed for the mailbox's domain and aligns with `From`. A send with envelope = the delegate (another domain) would sign for the wrong domain and fail DMARC at receivers: every delegated send must use the mailbox as envelope sender. The signed header list (`h=Date:Message-ID:Subject:To:From`) does not cover `Sender`.                                                                               |

Already known (not re-probed): Group membership gives members every right on the group including `mayShare`, and an
automatic send-as identity for the group address in each member's own account (`10-collaboration.md`, 2026-10-21);
OAuth tokens are derived from the account's Password credential, so a password change or removal ends them (ADR-0024);
customer tokens can't share (`CUSTOMER_DENIALS`, research/stalwart.md "Sharing").

Probe hygiene note: the dev inbound throttle "sender address to recipient" (25 per hour per sender domain and
recipient) makes later submissions to the same recipient answer `undoStatus: final` with `452 4.4.5` in
`deliveryStatus` and skip DATA altogether, which looks like a script that stopped running. Probes and int tests must
use a fresh recipient per case, and read `deliveryStatus`, not only the submission result.

## Decision

### 1. Mechanism: delegated mailboxes are opened by the BFF with that mailbox's own token

The webmail BFF opens a delegated mailbox with **a token of that mailbox**, obtained exactly like the console handoff
(ADR-0024 decision 4): the web app's operations key mints a throwaway credential on the mailbox (every permission but
`authenticate` off, 60 s expiry), exchanges it once at `/api/auth` with the delegate's client address forwarded, and
destroys it in a `finally`, all under the mailbox's credential lock (`AppPasswordRepository.lockCredentials`) and using
the reserved slot (`CUSTOMER_APP_PASSWORD_QUOTA`). The tokens are sealed into the **delegate's** webmail session and
never leave the server. Every request on that mailbox is checked against our grants first.

Why this and not folder sharing (P3/P4): sharing can't send at all (P4/P5), so the token is needed for both send rights
anyway; using it for reading too keeps **one** mechanism, needs **no new key scope** (the operations key can already
mint these credentials on any customer mailbox, so nothing new is reachable), no per-folder ACL reconciliation, no
"new folder not shared" drift, and revocation takes effect in our BFF without a mail-server write.
The cost, stated plainly: Stalwart sees every delegated action as the mailbox itself, and delegated mailboxes are
available **in the webmail only** — mail apps (IMAP/SMTP) of the delegate don't see them (see "Where the mail server
can't match the model").

### 2. Data model: one row per (mailbox, person, right) — migration `0029_mailbox_delegation` (Safe)

```sql
CREATE TYPE delegation_right AS ENUM ('full_access', 'send_as', 'send_on_behalf');
CREATE TABLE mailbox_delegation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES customer_account(id) ON DELETE CASCADE,
  mailbox_id      uuid NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  grantee_user_id text NOT NULL,                      -- a person in the same account (auth_user id)
  "right"         delegation_right NOT NULL,
  granted_by      text,                               -- console user id; null when the system wrote it
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, grantee_user_id, "right"),
  FOREIGN KEY (account_id, grantee_user_id) REFERENCES account_membership(account_id, user_id) ON DELETE CASCADE
);
CREATE INDEX mailbox_delegation_grantee ON mailbox_delegation (account_id, grantee_user_id);
```

- Grants are **deleted** on revoke (history is the audit log; no soft-delete state to get wrong). The cascades are a
  backstop only: every service path that removes a person, a mailbox or a grant deletes the rows itself and audits
  them in the same transaction.
- Invariants checked in the service (core), not only by the database: the mailbox and the person are in the same
  account (the composite foreign key enforces it too); a person is never a delegate of a mailbox whose `user_id` is
  themselves (409); at most `DELEGATES_PER_MAILBOX` (shared limits, proposed 25) distinct people per mailbox and
  `DELEGATED_MAILBOXES_PER_PERSON` (proposed 20) per person — numbers live in `packages/shared/src/plans.ts` and are
  imported by docs (rule 32).
- No Stalwart id, no status column: a grant changes nothing on the mail server, so it is effective as soon as it
  commits (decision 7). If the exact column names differ from drizzle's conventions in `schema.ts`, follow `schema.ts`.
- Repository port in `packages/core` (`DelegationRepository`: `listForMailbox`, `listForGrantee`, `rightsOf(mailboxId,
userId)`, `grant`, `revoke`, `revokeAllForMailbox`, `revokeAllForGrantee`), Postgres and in-memory adapters, contract
  tests (ADR-0008).

### 3. Shared mailboxes are person-less mailboxes, not Groups

- One concept: a **shared mailbox** is a `mailbox` row with `user_id` null (today's "shared address", same Stalwart
  individual account). Its **members** are the people holding `full_access` + `send_as` on it. The console renames
  "shared address" to "shared mailbox" everywhere, and "Add a shared mailbox" offers a members list. ADR-0013's Group
  plan for shared mailboxes is superseded (P1: a person's mailbox can't become a Group, and the model needs conversion
  both ways); Groups stay possible later for "group with a shared calendar".
- **Sign-in blocked:** a shared mailbox's password is one nobody is shown (generated at release or creation; already
  built) and it has no app passwords. A stricter variant — removing the Password credential entirely, which P7 shows
  still lets us open it — needs a management-proxy rule for "remove the one Password slot" and an "add a Password"
  shape for "Make this a user"; recorded as a follow-up, not in v1 (maintainer decision 3).
- Shared mailboxes count against `MAX_MAILBOXES` and storage, never as a person or seat.
- **Convert to shared** (new, `mailboxes/convert-to-shared.ts`): on a person's mailbox — the same release the leaver
  path uses (`mailboxes.releaseOwner`, new generated password queued as a `mailbox.password` job with the proxy grant,
  app passwords → `revoking` + `app_password.revoke`), plus optional grants in the same transaction. Fresh step-up
  (it replaces a password in use). Guard rail 8 applies (an Owner's or admin's mailbox: Owners only). Refused (409)
  while the mailbox is provisioning, deleting, or already person-less. Audit `mailbox.converted_to_shared`.
- **Convert back:** the existing "Make this a user". Grants are kept, except any held by the new person on their own
  mailbox, which are deleted and audited (`delegation.revoked`, reason `became_owner`).

### 4. Permissions (matrix `packages/shared/src/rbac`, `roles.md`)

- `delegation.read` (account scope): see a mailbox's three lists. Owner, User Administrator, Auditor (read-only, as for
  other `*.read`; an Auditor sees names and addresses, as on the People page, which `member.read` already shows them —
  corrected 2026-10-30 in review: this line first said names only). Unchanged name.
- `delegation.manage.any` ★ critical: add or remove people on any of the three lists. **Change from today's matrix:**
  held by **Owner and User Administrator** (was Owner only), with guard rail 8 applied per mailbox: on an Owner's or an
  administrator's mailbox, Owners only (403, audited). Reason: a User Administrator can already remove Members and
  reset their mailbox passwords (= reach their mail), so this adds no reach, and the leaver dialog (run by
  `member.manage` holders) can only offer "Give full access to …" if they can grant it. Confirmed by the maintainer
  (decision 1). Fresh step-up per grant or revoke batch. Never during act-as (403 `act_as`, before
  anything is looked up — ADR-0023).
- `delegation.manage.own` (existing name, owner-granted folder permissions): **not used in v1**; kept reserved for the
  later folder-level feature. Its description changes to "Share own folders (later)".
- No new permission for using a grant: the right itself is the authorisation, checked against the grant table on every
  request. Staff roles never hold anything here; act-as never reaches the webmail.
- Plan gating: plan flag `delegation` (Plus, Supporter: true; Free: false). Free accounts have one person, so there is
  nobody to grant to anyway; the flag makes the 403/409 explicit (`plan_feature`).
- Rule 35 work in the same change: matrix, `roles.md` (permission table + guard rail 69 rewritten: "granting access to
  someone else's mailbox is critical, Owner and User Administrator, guard rail 8"), RBAC harness, e2e role journeys.

**Update (2026-10-30, review):** guard rail 8 also holds after a promotion. When `changeMemberRole` makes someone an
Owner, or gives a Member an admin role, and when "Make this a user" creates a person with any role but Member, the
grants on that person's mailboxes in the account whose `granted_by` isn't a current Owner are deleted in the same
transaction, one `delegation.revoked` entry each (reason `role_changed`); grants an Owner made stay. Otherwise a User
Administrator's grant on a Member's or a shared mailbox would outlive it becoming an admin's or Owner's mailbox. The
batch and "Convert to shared mailbox" take the account lock before reading the mailbox and the members, so these checks
always run on current rows. The grant table also has a composite foreign key `(account_id, mailbox_id)` →
`mailbox (account_id, id)` (a unique constraint on `mailbox` added for it), so a row can't tie one account to another
account's mailbox even outside the services.

### 5. Console

- **Mailbox panel → "Delegation" tab** (`components/mailboxes/delegation-tab.tsx`): three sections, "Read and manage",
  "Send as", "Send on behalf", each a list of people (avatar, name, email in mono) with **Add people** (picker limited
  to people in this account, excluding the mailbox's own person) and a remove button per person. Help text: "People
  with read and manage can open this mailbox in their webmail. Sending needs Send as or Send on behalf. If someone has
  both, Send as is used. Changes can take up to a minute to show in webmail." Loading skeleton (rule 11).
- **Shared mailbox** create form: name, address, storage, **Members** (adds `full_access` + `send_as` per member).
- **⋯ menu on a person's mailbox:** "Convert to shared mailbox" (dialog: what happens to sign-in, mail apps and open
  sessions; optional "Give full access to …" with an "Also send as" checkbox).
- **Remove someone** dialog: per mailbox they own, optional "Give full access to [person picker]" + "Also send as".
  Offered only if the actor holds `delegation.manage.any` for that mailbox; otherwise a line says an Owner can do it
  later. Automatic reply and forwarding stay where they are (opened from the converted mailbox's panel afterwards);
  the dialog links to them.
- **People panel:** "Mailboxes they can open" (read-only list of their grants, `delegation.read`).
- **Visibility:** a mailbox with a person shows that person "People who can open or send from this mailbox" in webmail
  Settings → Account; the person is emailed (console address) when someone is given any right on their mailbox
  (rule 49 spirit; never for person-less mailboxes).

API (route handlers parse, call, map errors; services check permission and scope):

| Method and path                                                        | Body                                                                       | Answers                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/accounts/:accountId/mailboxes/:mailboxId/delegation`         | —                                                                          | `{ data: { fullAccess: Person[], sendAs: Person[], sendOnBehalf: Person[] } }`; 404 out of scope, 403 without `delegation.read`                                                           |
| `PUT /api/accounts/:accountId/mailboxes/:mailboxId/delegation`         | `{ add: [{ userId, right }], remove: [{ userId, right }] }` (≤ 50 entries) | One transaction, one audit entry per change; 404 unknown mailbox or person not in the account; 403 permission/guard rail 8/act-as; 409 own mailbox, limits, mailbox deleting; 428 step-up |
| `POST /api/accounts/:accountId/mailboxes/:mailboxId/convert-to-shared` | `{ fullAccessTo?: userId[], sendAs?: boolean }`                            | 202 (password job queued); 409 states above; 428 step-up                                                                                                                                  |
| `DELETE /api/accounts/:accountId/members/:userId` (existing)           | adds optional `{ delegateTo?: { userId, sendAs } }`                        | grants written in the removal's transaction; the grant part is refused (403) without `delegation.manage.any` for each mailbox, the removal itself is not                                  |

zod schemas in `packages/shared` (rule 32).

**Update (2026-10-30, slice 8):** the batch change is `PATCH …/delegation` (it adds and removes entries, it doesn't
replace the lists), and the removal route is the existing `DELETE /api/accounts/:accountId/people/:userId`. A person's
grants for the People panel are read with `GET /api/accounts/:accountId/people/:userId/delegation` (`delegation.read`).
The `delegationManage` tier (§9) covers `PATCH …/delegation` and `POST …/convert-to-shared`.

**Update (2026-10-30, slice 9):** the console UI is built: the Delegation tab (`delegation-tab.tsx`, streamed in behind
`DelegationTabSkeleton`), "Convert to shared mailbox" on the Access tab and in the ⋮ menu, the removal dialog's
"Give full access to …" (one person at a time; bulk removal doesn't offer it), "Mailboxes they can open" on the People
panel and the people with access listed in the "Make this a user" review. Core gained a read, `delegationAvailability`
(plan flag and whether the viewer may grant), for the plan-gated and read-only states. The tab's help text doesn't say
"in their webmail" until slices 11–14 ship. Not in this slice: the **Members** field on the "Add a shared mailbox" form
(people are added on the new mailbox's Delegation tab instead) and dropping that form's password field (decision 3);
the console now says "shared mailbox" everywhere, code identifiers keep their names.

### 6. Webmail BFF

**Session shape** (`apps/web/src/server/webmail/session-store.ts`): `MailboxTokens` gains an optional
`delegated?: { mailboxId: string; granteeUserId: string; via: string /* the delegate's own address */ }`. Delegated
entries live in `others` like any other signed-in mailbox and are switched with the existing `switchMailbox`; they
don't count toward `MAX_MAILBOXES` (own sign-ins) but are capped at `DELEGATED_MAILBOXES_PER_PERSON`.

**Auto-mapping:** on every `mailboxes()` call (and so on page load), the BFF asks core
`delegatedMailboxesFor(sessionOwners)`, where `sessionOwners` are the people behind the session's **own** signed-in
mailboxes (address → `mailbox.user_id`, via `known-mailboxes`); it lists, without tokens, every mailbox one of them
has `full_access` on (shown in the switcher and sidebar under "Shared with you") and every mailbox they may send from
(for the From picker). Tokens are minted on first use only (switching to it, or sending from it), never at sign-in.

**Open another mailbox** (the webmail person menu, under the person's name and address, next to their account
link): a small dialog asks for a mailbox address and opens it **in a new tab** at its own address-scoped URL,
`/mailbox/<address>/` (on the bare-IP dev route, `/webmail/mailbox/<address>/`). That tab shows that mailbox only;
the person's other tabs keep theirs. The page runs the same open as below: with a grant the mailbox opens (Inbox, or
the folder in the URL); without one, or for an address that doesn't exist or belongs to another account, it shows
one full-page error, "You don't have access to this mailbox" with a link back to their own mailbox. The answer is
the same in every refused case, so it never confirms that an address exists (rule 25), and it is audited as denied
in the person's own account only. The address-scoped URL is bookmarkable; opening it later re-checks the grant.

**Opening one (core `openDelegatedMailbox`, `packages/core/src/webmail/delegation.ts`):** inside one transaction that
takes the mailbox's account lock (the same lock removal holds, so a removal and an open serialise), check: the person
is still a member; they hold the needed right **now**; the mailbox is active and passes `MailboxAccessGate` (not
suspended, deleting or gone; the account isn't suspended); the session's own mailbox for that person still passes the
gate; not act-as. Then mint → exchange → destroy (ADR-0024 decision 4 and 6, same lock, same reserved slot; destroy
expired leftovers first), check that Stalwart's session `username` is the expected address, and seal the tokens into
the session. Audit `delegation.mailbox_opened` (success, or denied `not_granted` / `mailbox_unavailable` / `act_as`;
failed when the mail server refused). A refused credential (slot taken by a concurrent open) retries once after the
lock, then answers 503 "Try again".

**The gate on every request** (`DelegationGate`, like `PasswordChangeGate`): any route acting on a delegated entry
asks core for the person's current rights on that mailbox. "Has the right" is cached at most 10 s per (session,
mailbox); "no right" is never cached. No right → the entry is dropped from the session and the route answers 404
(the mailbox is out of their scope now). Refreshing a delegated token goes through the same gate first.

**Update (2026-10-30, review):** the gate (to build, slice 11) must also check the mailbox account's plan flag
(`Plan.delegation`) on every request and in `openDelegatedMailbox`, so a downgrade to a plan without delegation stops
the use of existing grants at once (they stay on record, unused, until an administrator removes them or the plan comes
back).

**Update (2026-10-30, slices 11–12 built):** core `webmail/delegation.ts` (`delegatedMailboxesFor`,
`openDelegatedMailbox`, `delegationCheck` + `DelegationGate`) and the BFF side. Choices made while building it:
opening is `POST /api/webmail/mailboxes/delegated` `{ address }` (both the "Shared with you" entries and Open another
mailbox use it; switching to an entry already open stays `PUT …/mailboxes/active`), tier `webmailDelegatedOpen`
(20 / 10 min per webmail session, fail closed). The audit actor is the delegate rebuilt from the database, the
matrix check being the self-level one (no permission for using a grant, §4). Refusals of the open are audited in the
person's own account with the target named only when it is a mailbox of that account. Routes declare
`delegated: "full_access"` or `"allowed"`; every other webmail route answers 403 `own_mailbox_only` while a delegated
mailbox is active (settings pages acting on the person's own mailbox from a delegated tab are slice 14's). A refused
grant, refresh or mail-server 403 drops only the entry. The Redis scrub of §7 is not built (the gate is the control).
`checkJmapRequest` already refuses client `sender` / `header:*` / the tag in `Email/set` and `Email/import` (slice 13
requirement 3). Int test: `packages/adapters/src/stalwart/delegation.int.test.ts`.

**Update (2026-10-30, security review of slices 11–12):** (1) own-mailbox-only is enforced in the service on the entry
whose token is used (delegated tokens only on the read paths; `ownMailbox` for settings, password, photo and export),
so a switch between `route()`'s gate and the handler can't aim an own-only action at a shared mailbox; the gate stays as
defence in depth. (2) Delegated use rides on the person's own sign-in **proven at the mail server**: before every open
and at most every 10 s on use, the own mailbox's JMAP session is fetched with its token (refreshed when due); a refused
token or refresh (a password reset) ends the whole webmail session. Remaining window ≤ 10 s. Int test:
`apps/web/src/server/adapters/webmail-delegation.int.test.ts`. (3) `webmailDelegatedOpen` also counts per own mailbox;
the per-person cap is re-checked in the session write; only Stalwart's `overQuota` means "slot taken"; the OAuth
exchange under the locks has a 5 s timeout (the management calls keep their 10 s default).

**What each right allows** (enforced in the BFF; the token itself could do everything):

| Action on the delegated mailbox                                                                  | `full_access`                                                          | `send_as` / `send_on_behalf` only |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------- |
| JMAP proxy reads, `Email/set` keywords/moves/destroy in Trash or Junk (existing allow-list)      | yes                                                                    | no (404)                          |
| Downloads, attachments, original message, print, image proxy                                     | yes                                                                    | no                                |
| Drafts in that mailbox                                                                           | only with a send right                                                 | yes, for messages sent from it    |
| Submission (`/api/webmail/send`)                                                                 | only with a send right                                                 | yes                               |
| Settings (identities, signatures, Sieve-backed settings, password, forwarding), export, contacts | **no** — the delegate's settings pages always act on their own mailbox | no                                |

`checkJmapRequest` keeps its single-`accountId` rule: the BFF passes the **active** entry's account id, which for a
delegated entry is the delegated mailbox's own account id (the token is that mailbox's, so its primary account), so the
existing allow-list applies unchanged. `Identity/get` is allowed only with a send right.

**Sending** (`WebmailService.send`, `compose.ts`):

- The From picker lists the delegate's own identities, then, per delegated mailbox with a send right, that mailbox's
  address; label "Send as" or "On behalf of" (send as wins when both are held).
- **A message is always submitted from the mailbox it says it is from**, with that mailbox's token, identity and
  envelope sender (P5, P10). Its draft lives in that mailbox's Drafts; choosing a From in another mailbox moves the
  draft (re-created there from the structured fields; attachment blobs downloaded with the old token and uploaded with
  the new one, same size caps; the old draft destroyed). The existing `onSuccessUpdateEmail` moves it to **that
  mailbox's Sent** — decision 4 of the model, with no extra code. Undo send works on that account.
- **Send as:** `From:` = the mailbox (its identity's name), no `Sender:`. Passes `sender-identity` unchanged.
- **Send on behalf:** `From:` = the mailbox, `Sender:` = the delegate (their profile name and their own address,
  `via`), and the header `X-AnhourMail-On-Behalf: <hex sha256(K | mailbox address | delegate address)>` with both
  addresses lowercased. `K` is `SENDER_DELEGATION_KEY` (32 random bytes, web container and the mail server's system
  script only; never the worker; rotated by redeploying both). The amended `sender-identity` script (decision 8)
  checks the tag and removes the header before the message leaves.
- Re-check of the right at send time **inside** the send (not only at page load); quota: the mailbox's own sending
  limits (it is the envelope sender, and Stalwart's throttles see it) **and** the delegate's own per-session window,
  both fail closed (rule 14, rule 27; needs a `security-reviewer` pass).
- **Tier rule (2026-10-30, review):** a delegated send is limited by the **stricter of the shared mailbox's trust tier
  and the sender's own mailbox's tier**, field by field (`delegatedSendingLimits` in
  `apps/web/src/server/webmail/compose.ts`, built). Today every mailbox resolves to `new`, so it changes nothing yet;
  when stored tiers (including `restricted`) are wired into `sendingTier()` in Phase 6, a restricted person can't send
  through a shared mailbox and a shared mailbox's tier is never loosened by who sends from it. Keep this when wiring.
- Audit every delegated submission in the mailbox's account log: `delegation.sent_as` / `delegation.sent_on_behalf`
  (actor = the delegate, target = the mailbox, meta `{ mailboxId, submissionId, recipients: <count> }` only — never
  addresses, subject or content, rule 24); a cancelled undo writes `delegation.send_cancelled`. The audit row is
  written **before** the submission is created (same pattern as handoff: if the audit append fails, nothing is sent).

### 7. Revocation and its timing

- Removing someone from a list deletes the grant row in one transaction with its audit entry. The BFF gate refuses
  the next request (≤ 10 s with the positive cache) and drops the sealed tokens from that session. Nothing to change
  on the mail server, so no job is needed and nothing can fail half-way (rule 26 concerns mail-server state; there is
  none here).
- A best-effort scrub removes the tokens from every session that holds them: the BFF keeps a Redis set
  `webmail:delegated:<mailboxId>` of the (hashed) session keys it sealed a delegated token into; revoke and removal
  queue a small `delegation.scrub_sessions` worker job that reads the set and removes the entries (the worker gets the
  session store's Redis key and key ring id only for this; if that is unwelcome, the scrub runs in the web process
  after the commit instead — implementer's choice, the gate is the control).
- The tokens themselves stay valid at Stalwart until they expire (access ~1 h, refresh 30 days) unless the mailbox's
  password changes; nobody holds them but our sealed session store.
- Cascades written explicitly with audit: person removed from the account (`removeMember`: their grants deleted,
  reason `member_removed`), mailbox deleted or purged (`mailbox_deleted`), "Make this a user" (`became_owner`), account
  deleted (rows cascade with the account; ADR-0025 purge order unchanged).
- The UI's "up to a minute" covers the gate cache plus any open page's next poll.

### 8. ADR-0019 amendment: the `sender-identity` script gains one keyed exception

The script stays fail-closed for everything else. New rule, only when a `Sender:` is present and differs from the
envelope sender: it must be exactly one address, and the message must carry
`X-AnhourMail-On-Behalf` equal to `hash('<K>|' + to_lowercase(envelope.from) + '|' + to_lowercase(header.sender.addr),
'sha256')`; otherwise the existing 5.5.3 refusal. `From` must still equal the envelope sender (so only someone
authenticated as the mailbox — in practice our BFF holding its token — can send on its behalf), and the tag header is
removed in every case (`deleteheader`), so it is never delivered. The `require` list adds `vnd.stalwart.expressions`.
`K` is substituted into the script text by the dev plan (`infra/stalwart/dev-plan.ts`, from `.env`) and by the ops
bootstrap (private ops repository) — never committed. `npm run stack:verify` gains: right tag accepted and stripped;
wrong, missing and cross-pair tags refused; forged `From` with a tag refused (P8 cases).

**Built 2026-10-30 (slice 10), amended the same day after the security review.** Differences from the text above:

- The tag is **bound to the message**: `tag = hex sha256(K | hex sha256(K | mailbox | delegate | Message-ID))`
  (addresses lowercased, the Message-ID without angle brackets, case kept), and the script requires exactly **one**
  `Message-ID:` on an on-behalf message. The per-pair tag above could be replayed: it was stored in Drafts and Sent,
  so anyone signed in as the mailbox (mail app, app password, export) could copy it and keep sending "D on behalf of
  M" after D's grant was revoked. The nested form also rules out length extension.
- The script first requires exactly **one** `Sender:` address over every `Sender:` header (a second one used to pass
  next to a matching one), and refuses unless the computed tag is 64 lowercase hex (a failed expression yields an
  empty variable). ADR-0019 update 2026-10-30 has the probe results.
- `K` is 64 lowercase hex (`openssl rand -hex 32`; enforced because the key is written into the script text). Dev
  leaves `SENDER_DELEGATION_KEY` unset: the dev plan and the web app derive the same key from `BETTER_AUTH_SECRET`
  (`resolveSenderDelegationKey`); production requires it (web env check) and the worker refuses it. It is in the log
  redaction list (`senderDelegationKey`, `onBehalfKey`, `onBehalfTag`, the header name).

**Slice 13 must ship with all of these (security review 2026-10-30; not optional):**

1. **No stored message ever holds a tag.** The BFF submits from a temporary copy that carries the tag and the
   Message-ID it was made for, with `onSuccessDestroyEmail` for that copy; the stored Sent copy is created separately
   without the tag (same Message-ID, so threading holds). If the submission fails, the temporary copy is destroyed as
   well. Decision 4 ("tag left in stored Sent/Drafts copies", residual 1 below) no longer applies.
2. **`Sender` and the tag are built server-side only**, by `onBehalfTag(senderDelegationKey(), mailbox, delegate,
messageId)` with a Message-ID the BFF generates, **immediately after re-checking the send-on-behalf right** inside
   the send (never from a cached page-load answer).
3. **The client can't supply them:** the webmail JMAP proxy and the send input strip or refuse any client-supplied
   `sender` property, any `header:*` property and the `X-AnhourMail-On-Behalf` header (in drafts, `Email/set`,
   `Email/import` and uploads parsed as messages), so a delegate's own session can't attach a tag or a `Sender:`.
4. **Received mail's tag means nothing:** inbound MX mail doesn't run the script, so an `X-AnhourMail-On-Behalf`
   header on received mail is never shown or trusted by the webmail ("via" comes only from `Sender:` like any other
   message).

**Leftover gap to decide in slice 13 (re-review 2026-10-30, low):** the tag is bound to a Message-ID, not to the body.
The mailbox's own person (the only one who can send as it over SMTP; a shared mailbox has nobody) could reuse a tag
seen during the short window the temporary tagged copy exists (a mail app syncing that folder) or left by a crash,
with the same Message-ID and any body or recipients, even after the delegate's grant ends. Slice 13 picks one: a short
expiry in the inner hash checked by the script (probe the pinned server's time functions first), keeping the
temporary copy out of synced folders plus a cleanup of leftovers, or accepting it as documented (owner-only, needs a
race, ended by key rotation). Also probe that a failed `header.message-id` read fails the whole `let`, so the inner
hash can never become the constant `sha256(K|)`.

`onBehalfTag` (`@anhourmail/core/webmail`) also refuses addresses or ids containing `|`, `"`, `<`, `>`, whitespace or
control characters (`OnBehalfTagError`); the send refuses rather than falling back.

**Update (2026-10-30, slice 13 built): sending as and on behalf from the webmail BFF.** All four requirements above are
met; `05-webmail.md` "Sending from one" and `07-security.md` "Delegation" have the flow.

- **Requirement 1.** A send on behalf creates, in one JMAP request with the mailbox's token, the kept copy in its Sent
  (`Sender:`, no tag) and a temporary copy (not a draft) carrying `Sender:`, the tag and its expiry, and submits the
  temporary one with `onSuccessDestroyEmail`; both share the BFF's Message-ID. Probed on v0.16.27 first: the email is
  destroyed at once and the held (`HOLDFOR`) message is still delivered after the hold, and still cancellable. A
  refused submission destroys both copies; if the implicit destroy isn't in the answer, the BFF destroys the temporary
  copy itself. Decision 4 and residual 1 no longer apply.
- **Requirement 2.** Core `authorizeDelegatedSend` re-checks the right uncached under the account lock immediately
  before the submission and writes `delegation.sent_as` / `delegation.sent_on_behalf` (meta `mailboxId`,
  `recipientCount`, `need`) before anything is submitted; `Sender:` and the tag are built right after it.
- **Requirement 3** was already in the proxy (slice 11–12); the delegated send rebuilds the message from `DraftInput`,
  which has no sender or header fields. **Requirement 4:** the webmail never reads the tag header of received mail.
- **Leftover gap: decided — a short expiry in the inner hash.** Probed on the pinned server (throwaway account, a probe
  DATA script scoped to it by `authenticated_as`, the wiring restored afterwards): Sieve `currentdate :zone "+0000"`
  works at DATA and gives `iso8601` as `2026-10-30T09:26:37Z`, and `:value "gt"` compares that with a header value of
  the same form as text, correctly. So `inner = sha256(K | mailbox | delegate | Message-ID | expiry)` with
  `X-AnhourMail-On-Behalf-Expires: <UTC, whole seconds>` five minutes ahead (`ON_BEHALF_TTL_MS`); the script requires
  exactly one expiry header in that form, refuses once `currentdate` is past it, and removes it from every submission
  (`stack:verify`: an expired tag, a changed expiry, none, two, a non-UTC form — all refused; the accepted cases
  carry a fresh one). What remains: the mailbox's own person reusing a tag they saw within five minutes with the same
  Message-ID — accepted (owner-only, a race, ended by key rotation).
- **Probe: a failed `header.message-id` read does _not_ fail the `let`.** With no Message-ID, or `Message-ID: <>`,
  `Message-ID:` or `< >` (one header, so the count check passes), `header.message-id` reads as `""` and
  `hash('k|' + header.message-id, 'sha256')` is `sha256("k|")` (verified against a local digest). The inner hash could
  therefore have become a per-pair constant for an unreadable id (only the key holder can compute it, and the web app
  never makes one — `onBehalfTag` refuses an empty id — but it is one input away from a reusable tag). The script now
  reads the id into a variable first and refuses anything but `local@host` in letters, digits and `._%+=-`
  (`onBehalfTag` refuses the same), before hashing; `stack:verify` sends `<>` with the tag for an empty id, and a
  bracketless id with its matching tag, and both are refused. Also seen: `Message-ID: <a@b> <c@d>` reads as `c@d`
  (the last), which gives nothing new (it is the same as reusing `c@d`).
- **Choices made while building it** (deviations from §6's text): the person composes in **their own** mailbox and the
  draft is rebuilt in the shared one at send time (attachments downloaded with their token, uploaded with the
  mailbox's, same caps); the own draft is removed once the undo hold is over rather than at once, so undo hands it
  back unchanged (`POST /api/webmail/send/undo` `{ submissionId, mailbox }` cancels in the shared mailbox, removes its
  stored copy and records `delegation.send_cancelled`). What undo needs is held in the web process for the hold (as the
  contacts auto-save is): after a restart in those seconds the message is sent and the own draft stays. Drafts saved
  directly in a shared mailbox are not offered (slice 14 can add them). The audit meta has `recipientCount`, not a
  submission id (the entry is written before the submission exists; `recipients` is a redacted key). A send from a
  shared mailbox while a shared mailbox is the active one is refused (403 `own_mailbox_only`); the From picker
  (`GET /api/webmail/senders`) lists only mailboxes reached through the active own mailbox, so the `Sender:` is always
  that mailbox's person. A first send mints the mailbox's entry (`need: "send"`, audited open) and counts against
  `webmailDelegatedOpen` per own mailbox. Recipients of a delegated send aren't auto-saved to contacts. Tests:
  `apps/web/src/server/webmail/delegated-send.test.ts`, `packages/core/src/webmail/delegation.test.ts`, the int test
  `apps/web/src/server/adapters/webmail-delegated-send.int.test.ts` (send as and on behalf delivered to Mailpit with the
  right From / Sender and no tag stored or delivered, undo, revoked and read-and-manage-only refused), `stack:verify`.

**Update (2026-10-30, slice 13 security review fixes).**

- **Order:** the right is checked uncached and the send audited **before any work** in the shared mailbox (blobs, quota),
  and checked once more, uncached and read-only (`delegatedSendCheck`), right before `Sender:` and the tag are built.
- **No copy survives a failed send:** the copies are created in one request and submitted in a second. A method error,
  a refusal or a lost answer destroys every unsent copy (after a lost creation answer they are found by Message-ID in
  that mailbox's Drafts and Sent; after a lost submission answer `EmailSubmission/query` says whether it was sent — if
  so it is a success) and records `delegation.send_failed`. A tagged copy the submission didn't destroy is destroyed
  by the BFF, retried once, else recorded `delegation.tagged_copy_left`. Unit and int tests cover the method error and
  both lost answers (the int test loses the real server's answer after it applied the request).
- **Undo never opens a mailbox** and needs the entry the send used still in the session ("It has already been sent."
  otherwise). **Decision:** undo does not re-check the send right — cancelling our own held submission only reduces
  what is sent, so a revoke during the hold must not block it; the person's own sign-in is still proven. Its audit is
  retried once; if it still fails the undo answers an error after the cancel.
- **Sender name:** the `Sender:` display name is the active mailbox's own identity name (as the From picker labels it),
  whichever own identity the draft used.
- **Expiry fails closed:** the script passes only when `currentdate :zone "+0000" :value "le" "iso8601" <expiry>`
  matches (probed: an expiry the comparison can't confirm — empty, past — doesn't match, so the message is refused); a
  server without the `date` extension or with a bad zone refuses to compile the script, so it is never installed
  (probed: compile error). `stack:verify` reads the mail server's own clock (its HTTP `Date`) for the expired case,
  ten minutes back, and checks that it really is past.
- **Re-review (same day):** a lost submission answer whose lookup also fails is **unknown**, kept apart from "not
  sent": only the tagged copy is removed, the kept copy stays, `send_failed` reason `unknown`, answer `503
send_unconfirmed` ("Check Sent before sending it again."). After a successful submission the undo hold is registered
  before the tagged-copy cleanup, and a cleanup record that fails is only logged, so a sent message never answers 503.
  The lookup of copies after a lost creation answer lists the folders: an `Email/query` `header: ["Message-ID", id]`
  filter never matched a just-created message on v0.16.27 (probed, bare and bracketed, after 2 s).

**Update (2026-10-30, slice 14 built): the webmail UI.** "Shared with you" (sidebar and account menu; choosing one
opens it in place, a banner names it, compose, replies, contacts, blocking and settings are hidden or explained),
**Open another mailbox** (account menu → address → new tab at `/mailbox/<address>`, `/webmail/mailbox/<address>` on
the bare dev host, optional `/<folder>`; one refusal page), the From picker labels from `GET /api/webmail/senders`
(undo names the mailbox; `send_unconfirmed` shown as such), and "Sender on behalf of From" in the reader from the
`Sender:` header only. `05-webmail.md` "Mailboxes shared with you" has the details. Choices made while building it:

- **Server change, smallest found: tabs pin their mailbox per request.** The session's active entry is one value per
  browser (one cookie), so making the address-scoped tab's mailbox active would have switched the person's other tabs.
  Instead that tab sends `X-Webmail-Shared` (`?shared=` on links), and the session store reads the session with that
  entry as the active one and writes it back with the real active entry restored (`server/webmail/pin.ts`), inside
  `route()` and the Show original page. Only a delegated entry already in the session can be pinned; anything else is
  the one 404 (marked `x-webmail-refused: mailbox` so the tab can show the refusal page). It grants nothing new: the
  same person could switch to that entry. The open takes `activate: false` for this tab (an entry already open is
  only re-checked, and not dropped when refused, so a send-only entry keeps its undo hold). Refreshes in flight are
  keyed by session and mailbox.
- **Review fixes (same day):** only an entry opened for read and manage can be pinned (the open records `opened`); a
  pinned request never drops an entry (refused instead), so a cross-site link can't end a send's undo hold; `?shared=`
  counts only on same-origin requests; a pinned write restores the real active entry from the record it replaces and,
  if it is gone, hands over to its `via` or the first own mailbox, never the pinned one; refreshes are keyed by pin too
  and deferred work runs unpinned; the address-scoped page opens by itself only for navigations from us
  (`Sec-Fetch-Site` same-origin, same-site or none), otherwise it asks; "on behalf of" is shown as what the message
  says, From first ("On behalf of From, sent by Sender").
- **"Shared with you" switches the session** (as the existing mailbox switcher does), so other unpinned tabs follow;
  sending from a shared mailbox stays in the person's own tab (403 `own_mailbox_only` otherwise, slice 13).
- **Not built:** "People who can open this mailbox" in webmail Settings → Account (§5 "Visibility"): no webmail route
  lists a mailbox's delegates yet; the owner notification email; drafts saved in a shared mailbox (the From choice
  isn't kept with the draft).

**Update (2026-10-30, writing from a shared mailbox's view).** The maintainer found no way to send from a mailbox
opened with Open another mailbox. Its view (the address-scoped tab, and the session switched to it) now has **New
email**, and Reply, Reply all and Forward in the reader, with **From** preset to that mailbox (send as, else on behalf;
the person can pick another From, the same list as their own tab's). With Read and manage only, New email is off and
says why. Choices:

- **Server change: an own pin** (`X-Webmail-Own: <own address>`, `server/webmail/pin.ts` `requestPin`, header only).
  The view's compose requests (session document, proxy, drafts, uploads, identities, senders, signatures, contacts,
  send, undo) name the person's own mailbox `via`; the store then shows that **own** entry as the active one and
  writes the real active entry back, as the shared pin does for a delegated entry. An own pin can name only one of the
  session's own sign-ins (a delegated entry, one not signed in here or a malformed value → the one 404 refusal), and a
  request can't carry both pins, so own-mailbox-only and the default-deny are unchanged: the send goes through
  `#sendDelegated` exactly as from the own tab (Sender and tag built by the server, the right re-checked uncached at
  send). This also makes it work when the session's active mailbox is itself a shared one (switched in another tab),
  which answered `403 own_mailbox_only` before. Nothing new is granted: the person could switch to that own sign-in.
  Refreshes under an own pin share the entry's unpinned refresh (no refresh token used twice at once).
- **Forwarded attachments are copied by the browser**: fetched with the shared pin (a read the person may do) and
  uploaded with the own pin into the own draft; the own token never reads or references the shared account's blobs.
- Replies treat the shown mailbox as "self"; `In-Reply-To` / `References` pass through the rebuild (unit test).
- Console polish in the same change: the Delegation tab orders its lists Send as, Send on behalf, Read and manage,
  each heading with its count ("Send as (2)").

**Update (2026-10-30, maintainer decision: no auto-mapped "Shared with you" list for now).** This amends decision 2
and §6's auto-mapping in the UI only. The webmail no longer lists mailboxes shared with the person: the sidebar's and
the account menu's "Shared with you" sections are gone, and so is choosing one to switch the session to it in place
and the "You're viewing …" banner. A shared mailbox opens only with **Open another mailbox**, in a tab of its own
(`/mailbox/<address>/`), whose sidebar header shows it like an account (tile, name, address), whose title is
"<address> · <folder>", and whose account menu has **Your mailbox** back to the person's own webmail. A session still
left on a shared mailbox from before (or an older page) is switched back to the own mailbox it came through when the
webmail page loads; if that fails, the page opens the mailbox's own tab instead. The server is unchanged: `GET
/api/webmail/mailboxes` still answers `shared` and `activeShared` (a scoped tab reads its own entry from it), and the
in-place open and switch (`POST …/delegated` without `activate: false`, `PUT …/active` to a delegated entry) are still
accepted and gated as before; the UI just doesn't use them. The From picker's group is named "Shared mailboxes".
**Later (not built):** shared mailboxes as folder trees of their own under the person's mailbox in the sidebar, in the
conventional enterprise layout (the mailbox's name, expandable to Inbox, Drafts, Sent, Deleted, Archive and Junk);
recorded in `09-roadmap.md`.

## Consequences

- Delegation, shared mailboxes and the leaver hand-over ship with **no new mail-server key, no management-proxy
  change** and no per-grant provisioning job; grants take effect on commit and revoke in seconds.
- The web app's operations key mints a credential per delegated open (bounded by `webmailDelegatedOpen`), as for the
  handoff. The reserved slot is shared with handoffs; the credential lock serialises them.
- The BFF becomes the only enforcement point for read-and-manage-without-send and for the scope of a grant: a web-app
  compromise already implied full mailbox access (ADR-0024), so the blast radius is unchanged, but every new webmail
  route must pass the delegation gate (a route-file test, like the password-change gate's, pins it).
- **Residuals (accepted):**
  1. Anyone who can authenticate as the mailbox itself and has seen a valid on-behalf tag can reuse it for that
     (mailbox, delegate) pair: the tag is in the stored Sent and Drafts copies (the script strips it only from the
     transmitted copy). For a shared mailbox nobody can authenticate as it; for a person's own mailbox, its owner could
     make their own mail say "Delegate on behalf of Owner". Rotating `K` invalidates every tag. The BFF should strip
     the header from the Sent copy after submission if a cheap way exists (implementer to check `Email/import` of a
     cleaned blob); not required for v1.
  2. `Sender:` is outside the DKIM-signed header list (P10); DMARC relies on `From`, which is signed.
  3. A delegated token stays valid at the mail server until expiry after a revoke; only our sealed session store holds
     it and the gate refuses its use.
  4. Delegated mailboxes open from any webmail session of the grantee's own mailbox, including password sign-ins,
     which don't pass the console's two-factor requirement (as for the person's own mailbox today). Accepted by the
     maintainer: in the reference model the delegate's own sign-in is the only gate.
- Docs to update when built: `01-architecture.md`, `04-data-model.md`, `05-webmail.md` (delegated entries, From picker,
  gate), `07-security.md` (new section "Delegation", "Leavers" step), `10-collaboration.md` (mapping rows),
  `roles.md`, `audit.md`, `rate-limits.md`, `migration.md` (0029), `codemap.md`, ADR-0019 (dated update),
  `research/stalwart.md` (P1–P10), public guides (Mailboxes → Delegation, shared mailboxes, removing someone, webmail
  "Mailboxes shared with you", sending as or on behalf), the changelog, README "Works today".

## Alternatives

- **Folder ACLs for read and manage + tokens only for sending:** server-enforced reads and mail-app access, but two
  mechanisms, a new key holding `jmapMailbox*` on every mailbox, folder-by-folder reconciliation (new folders made over
  IMAP aren't shared until the reconciler runs), and sending still needs the token. Kept as the later mail-app option.
- **Groups for shared mailboxes (ADR-0013 plan):** native send as for members, but a person's mailbox can't be
  converted (P1), members always get `mayShare`, and individual mailboxes can't use it (P2).
- **A server-side grant list for send on behalf (`x:MemoryLookupKey` + `key_exists`):** would have covered mail apps;
  not readable from Sieve on this version (P9). Re-test on upgrade.
- **Send on behalf from the delegate's own account (envelope = delegate):** fails DMARC whenever the delegate's
  domain differs from the mailbox's (P10) and needs `From` ≠ envelope, a weaker exception.
- **Grants to mailboxes instead of people:** a person with two mailboxes would need two grants, and a person-less
  shared mailbox could be made a delegate; rejected — the model grants to people.

## Slice plan (small commits, rule 3; each with its tests and docs)

1. `packages/shared`: `delegation` plan flag, `DELEGATES_PER_MAILBOX`, `DELEGATED_MAILBOXES_PER_PERSON`, zod schemas.
2. RBAC: `delegation.manage.any` to User Administrator with guard rail 8, `delegation.manage.own` description; matrix
   tests; `roles.md`.
3. Migration `0029_mailbox_delegation` + `migration.md` entry (Safe).
4. `DelegationRepository` port, Postgres + in-memory adapters, contract tests.
5. Core `delegation/service.ts`: list, grant/revoke batch (permission, scope 404, guard rail 8, step-up, act-as,
   plan, limits, own-mailbox 409), audit catalogue entries + `audit.md`.
6. Cascades: `removeMember` (`delegateTo` + revoking the leaver's grants), mailbox delete/purge, "Make this a user".
7. Core `convert-to-shared.ts` (reuses the release) + tests.
8. Console API routes (`delegation`, `convert-to-shared`, removal body) + rate-limit tier + route tests.
9. Console UI: Delegation tab + skeleton; "Convert to shared mailbox" dialog; removal dialog step; shared-mailbox
   members field; people panel list; rename "shared address" → "shared mailbox".
10. `sender-identity` script amendment + `SENDER_DELEGATION_KEY` in dev plan and `.env.example` (placeholder) +
    `stack:verify` cases; ADR-0019 update note; ops repo note (private).
11. Core `webmail/delegation.ts` (`delegatedMailboxesFor`, `openDelegatedMailbox`, `DelegationGate`) + int test on the
    real stack (open, gate, revoke, cascade, slot contention).
12. BFF session shape + auto-mapping list + switch to a delegated entry + gate in `route()` + route-file pin test.
13. BFF send: From picker data, cross-mailbox draft move, send as, send on behalf (tag), audit before submit, quotas.
14. Webmail UI: "Shared with you" in switcher and sidebar, **Open another mailbox** (person menu → address dialog →
    new tab at `/mailbox/<address>/`, one refusal page), From picker labels, settings pages pinned to own mailbox,
    "People who can open this mailbox" in Account settings; owner notification email.
15. e2e: admin grants in console → delegate sees the mailbox appear, reads, sends as and on behalf (Sent copy in the
    mailbox), revoke → gone; leaver removal with "Give full access"; RBAC harness rows; demo seed (a shared mailbox
    with members, a delegated personal mailbox) and the `credentials.md` generator.
16. Public docs + changelog + README.
