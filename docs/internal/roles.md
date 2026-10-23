# Roles and permissions

Last updated: 2026-10-22 (app passwords, catch-all)

**Source of truth: `packages/shared/src/rbac`.** That code is canonical: the permission list, the role → permission matrix, critical-permission flags and guard rails. The UI (what to show), the API (what to allow) and the RBAC harness (`npm run test:rbac`) all derive from it. This document explains the matrix for people. If the two disagree, the code wins, and this file is updated in the same change (rule 35).

The model follows a familiar admin-centre shape: a few platform (staff) roles, and per-account roles for people inside a customer account.

## Outcomes

| Situation                                                                    | Response                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------- |
| Not signed in, route needs a session                                         | **401**                                      |
| Signed in, lacks the permission                                              | **403**                                      |
| Has the permission, but the id belongs to another account (or doesn't exist) | **404**: never confirm another account's ids |
| Guard rail violated (last Owner, escalation)                                 | **409** with a plain message                 |

Checks live in the **service layer** (permission + ownership scope). Route handlers and UI checks are conveniences; the server is the gate.

## States before an account

| State         | Can                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous** | Marketing pages, docs, changelog, credits; sign up while sign-up is open (`SIGNUP_MODE=open`)                                                                                                                                                                                                         |
| **Free user** | An Owner of their own personal account with the Free plan: one `@anhourmail.com` mailbox (claimed once their sign-in email is confirmed; ADR-0021), aliases and masked aliases within Free limits, own settings, Security activity, export, delete account. They cannot add people or custom domains. |

## Platform roles (Anhourtec staff)

| Role                                 | Can                                                                                                                                                                                                        | Cannot                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Global Administrator**             | Everything: platform settings, integrations (secrets are write-only), staff role management, all platform-role abilities below, act-as, create a free platform address in a customer account (no password) | Read mail content (no such path exists); set a customer's mailbox password |
| **Support Administrator**            | View accounts and members; reset a user's password/2FA (forces re-enrolment, notifies the user); resend invites; view mail-flow logs (metadata only); act-as (time-limited)                                | Billing changes, trust-tier changes, staff role changes, mail content      |
| **Trust & Safety Administrator**     | Abuse queue; restrict, suspend and unsuspend accounts and mailboxes; change trust tiers and sending limits; view abuse signals                                                                             | Billing, staff roles, act-as, mail content                                 |
| **Billing Administrator** (platform) | Plans, refunds, invoices, subscription state, credits                                                                                                                                                      | Trust tiers, staff roles, act-as                                           |
| **Reports Reader**                   | Read-only dashboards, platform audit log, aggregate metrics                                                                                                                                                | Any change                                                                 |

## Account roles (inside a customer account)

Plus and Supporter accounts can add people (family, a small group). Free accounts have one Owner and nobody else.

| Role                                    | Can                                                                                                                                                                                                                                                                                                               | Cannot                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Owner** (global admin of the account) | Everything in the account, including deleting it, managing admins, transferring ownership and requiring a second sign-in step                                                                                                                                                                                     | Remove or demote the last Owner                      |
| **Domain Administrator**                | Add, verify and remove domains; see DNS records and checks; set catch-all                                                                                                                                                                                                                                         | Billing, people management, delete account           |
| **User Administrator**                  | Create mailboxes (with a password); suspend, delete, restore and set the password of Members', unassigned and their own mailboxes (an Owner's or another admin's: Owner only); invite and remove Members (`member.manage`); reset Member passwords/2FA; manage anyone's aliases and masked aliases in the account | Change admin roles, billing, domains, delete account |
| **Billing Administrator** (account)     | Plan changes, payment method, invoices, refunds request                                                                                                                                                                                                                                                           | Domains, people, mailboxes                           |
| **Member**                              | Their own mailbox, own aliases and masked aliases, own settings, own Security activity, app passwords, export own mailbox                                                                                                                                                                                         | Anything account-wide                                |
| **Read-only (Auditor)**                 | View settings, people, domains, mailboxes (metadata), and the account audit log; export the audit log                                                                                                                                                                                                             | Any change                                           |

A person can hold several account roles. Permissions are the union.

### Collaboration (`10-collaboration.md`)

| Role                  | Shared mailboxes & lists                           | Delegation & forwarding                                                         | Mail rules & trace  |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------- |
| Owner                 | Manage                                             | Own + **any mailbox** (full access, send as, forwarding — critical, Owner only) | Manage, trace       |
| Domain Administrator  | See lists                                          | Own mailbox only                                                                | Manage rules, trace |
| User Administrator    | Manage shared mailboxes, lists, resource mailboxes | Own mailbox; sees all grants                                                    | See rules, trace    |
| Billing Administrator | —                                                  | Own mailbox only                                                                | —                   |
| Member                | — (uses shared mailboxes they belong to)           | Own mailbox: folder sharing, send on behalf, forwarding, auto-reply             | —                   |
| Read-only (Auditor)   | See                                                | See all grants                                                                  | See rules, trace    |

Guard rail: granting access to **someone else's** mailbox (full access, send as, forwarding of another mailbox) is critical and Owner-only, always audited, and shown to the mailbox's owner.

### Folders, signatures and bulk sending (ADR-0014, ADR-0015)

| Permission                                                       | Owner | Domain Admin | User Admin | Billing Admin | Member | Read-only |
| ---------------------------------------------------------------- | ----- | ------------ | ---------- | ------------- | ------ | --------- |
| `folder.manage.own` — own folders, favourites, saved searches    | ✓     | ✓            | ✓          | ✓             | ✓      | —         |
| `folder_policy.read` / `.manage` — archive and clean-up policies | ✓ / ✓ | —            | ✓ / ✓      | —             | —      | ✓ / —     |
| `signature.manage.own` — own signatures                          | ✓     | ✓            | ✓          | ✓             | ✓      | —         |
| `signature_template.read` / `.manage` — account templates        | ✓ / ✓ | —            | ✓ / ✓      | —             | —      | ✓ / —     |
| `disclaimer.read` / `disclaimer.manage` ★ — outbound disclaimer  | ✓ / ✓ | —            | ✓ / —      | —             | —      | ✓ / —     |
| `bulk.read` — lists, campaigns, stats (add-on)                   | ✓     | —            | ✓          | —             | —      | ✓         |
| `bulk.list.manage` — lists, imports, suppressions                | ✓     | —            | ✓          | —             | —      | —         |
| `bulk.campaign.send` ★ — send campaigns                          | ✓     | —            | —          | —             | —      | —         |

The Read-only (Auditor) role manages nothing, including its own folders and signatures in the console; its
mailbox is still usable in the webmail and mail apps (folders there are mail data in Stalwart, not console
actions). Disclaimers and bulk sending are critical: they change or send mail on behalf of the whole account.

## Permission catalogue (mirrors `packages/shared/src/rbac/index.ts`)

Naming: `<resource>.<verb>`. Each permission has a scope: `self` (any signed-in person, about themselves), `platform` (staff roles) or `account` (account roles).

| Scope    | Permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| self     | `self.profile.read`, `self.security.manage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| platform | `platform.staff.manage` ★, `platform.settings.manage` ★, `platform.accounts.read`, `platform.accounts.actAs` ★, `platform.users.resetCredentials`, `platform.mailbox.create` ★, `platform.invites.manage`, `platform.mailflow.read`, `platform.abuse.manage`, `platform.trust.manage` ★, `platform.billing.manage` ★, `platform.audit.read`, `platform.audit.full_ip` ★, `platform.reports.read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| account  | `account.read`, `account.delete` ★, `account.admins.manage` ★, `account.security.manage` ★, `member.read`, `member.manage`, `domain.read`, `domain.manage`, `mailbox.read`, `mailbox.manage`, `mailbox.password.reset` ★, `member.credentials.reset`, `alias.manage.any`, `alias.manage.own`, `app_password.manage.own`, `billing.read`, `billing.manage` ★, `audit.read`, `shared_mailbox.read`, `shared_mailbox.manage`, `distribution_list.read`, `distribution_list.manage`, `delegation.read`, `delegation.manage.own`, `delegation.manage.any` ★, `forwarding.manage.own`, `forwarding.manage.any` ★, `mail_rule.read`, `mail_rule.manage`, `message_trace.read`, `resource_mailbox.manage`, `folder.manage.own`, `folder_policy.read`, `folder_policy.manage`, `signature.manage.own`, `signature_template.read`, `signature_template.manage`, `disclaimer.read`, `disclaimer.manage` ★, `bulk.read`, `bulk.list.manage`, `bulk.campaign.send` ★ |

★ = **critical**. Never granted to Member or Read-only (`NON_DELEGABLE_ROLES`, checked by unit tests over the matrix), never delegable by a non-Owner, and always audited with before/after values. The grants per role are `PLATFORM_GRANTS` and `ACCOUNT_GRANTS` in the code. Act-as roles are `ACT_AS_ROLES`. New permissions (export, invites per account, refunds, …) are added to the code first, then here.

## Guard rails

1. **At least one Owner** always exists per account. The last Owner cannot leave, be removed or be demoted (409). Ownership transfer is a two-step accept.
2. **No escalation:** nobody can grant a role or permission they don't hold themselves. Only Owners manage admin roles. Members and Auditors can never receive critical permissions.
3. **Platform roles are granted only by a Global Administrator.** At least one Global Administrator always exists.
4. **Act-as** is for Global and Support Administrators only:
   - requires a written reason;
   - expires after 30 minutes (renewable with a new reason);
   - shows a banner on every page;
   - every action is audited with `on_behalf_of` and the act-as session id;
   - it is visible to the account's admins as "Anhourtec staff" (`audit.md`);
   - it **never exposes mail content**: no webmail handoff while acting as.
5. **Mail content is never visible to staff** through any console path.
6. **Suspended** users and accounts can sign in only to export or pay (billing suspension) or not at all (abuse suspension, export by request).
7. Changes to roles, sending limits, signup gating or abuse logic need a `security-reviewer` pass (rule 27).
8. **Mailbox lifecycle above your role:** suspending, resuming, deleting or restoring a mailbox assigned to an Owner
   or any admin (any role but Member) takes an Owner. A User Administrator holds `mailbox.manage` but gets **403**
   (audited as `denied`) for those mailboxes, except their own; the console hides the actions for them. This is a
   per-mailbox check in the service (`packages/core/src/mailboxes/service.ts`), not a separate permission, so the
   matrix and the RBAC harness (random ids → 404) are unchanged; unit tests cover it.
9. **People and invites** (`packages/core/src/people/service.ts`, checked in the service, unit-tested):
   - `member.read` (Owner, Domain Admin, User Admin, Auditor) sees People and roles; `member.manage` (Owner, User
     Admin) invites people **as Member**, resends and revokes Member invites and removes Members;
   - every other role is Owner-only (`account.admins.manage` ★): inviting with it, resending or revoking such an
     invite, changing anyone's role, removing an Owner or an admin. A User Admin gets **403**, audited as `denied`;
   - nobody changes their own role or removes themselves (**409**); the last Owner can't be demoted or removed
     (**409**; checked under the account row lock, so two Owners demoting each other can't both win);
   - an Owner may make someone else an Owner directly (a co-owner); handing over and leaving (transfer) stays the
     planned two-step accept;
   - invites are single-use links bound to one email, 7 days, only the token hash stored; accepting needs the session's
     email to match (else 403, audited) or creates the console login for that address when signed out;
   - removing someone keeps their mailboxes (they show as unassigned) but revokes the app passwords on them; the Free plan can't add people, and an account
     holds at most `MAX_PEOPLE` people counting unexpired invites.
10. **Sign-in requirements** (`packages/core/src/security`): `account.security.manage` ★ (Owners only) sets what
    everyone in the account must use to sign in — nothing extra, two-factor sign-in (authenticator app or passkey) or
    a passkey. The Owner must meet it first (409). A person missing what any of their accounts requires
    (`UserActor.mustEnrol`) passes only `self` permissions until they set it up: every other permission answers **403**
    `enrolment_required` (another account's ids stay **404**), and console pages send them to their Security page.
    Removing a factor a requirement depends on is refused (409). Their own Security page (`self.security.manage`) lists
    and signs out their sessions and renames/removes their passkeys; another person's session or passkey id is **404**.
11. **Staff account look-up** (`platform.accounts.read`) is metadata only; opening an account writes
    `staff.account_viewed` in that account's own log (rule 49). Platform pages are a 404 for anyone without the
    permission (the API answers 403, per the matrix).
12. **App passwords** (`packages/core/src/app-passwords`, ADR-0020): `app_password.manage.own` (every role but the
    Auditor, which holds no write permission) creates and revokes app passwords for **mailboxes assigned to the
    person** only — anyone else's mailbox is 403 for people who can see mailboxes and 404 otherwise. Creating one needs
    a recent step-up (403 `step_up_required`) and is refused during act-as (an app password opens mail). People with
    `mailbox.read` list a mailbox's app passwords (names, protocols, dates; never a secret) on its panel; people with
    `mailbox.manage` revoke them, with the same per-mailbox Owner-only rule as suspending (guard rail 8). The routes
    for others' mailboxes use `app_password.manage.own` as their harness guard because every `mailbox.manage` holder
    has it too; the stricter checks are unit-tested.
13. **Mailbox passwords** (`packages/core/src/mailboxes/password.ts`, ADR-0020 "Mailbox passwords"): creating a
    mailbox (`mailbox.manage`) takes its initial password. Setting a new one later is `mailbox.password.reset` ★ (Owner,
    User Administrator; critical because a password opens the mailbox's mail): it needs a fresh step-up (403
    `step_up_required`), follows guard rail 8 (an Owner's or admin's mailbox: Owners only, 403 audited), and is
    **refused during act-as** (403 `act_as`, audited) — staff never choose a customer's mailbox password; creating a
    mailbox during act-as is refused for the same reason. The mailbox's person (if it has one) is emailed. The person's
    own change happens in the webmail (mailbox sign-in, current password proved to Stalwart), outside this matrix.
14. **Catch-all** is part of `domain.manage` (Owner, Domain Administrator) on a plan with `catchAll`, a verified
    domain and an active mailbox of the same account; it turns itself off when that mailbox is suspended or deleted.
15. **Free platform addresses** (`packages/core/src/mailboxes/platform.ts`, ADR-0021): creating a mailbox on the
    platform domain is `mailbox.manage` like any mailbox, plus: the person's sign-in email confirmed (403
    `email_unverified`, audited as denied), the shared name rules (400), the plan's allowance (Free one, paid within
    `MAX_MAILBOXES`; 403 `plan_limit`), a name no account holds or held (409, never saying which), refused during act-as
    (403 `act_as`). The availability check (`GET …/mailboxes/platform-address`) is `mailbox.manage` (404 for other
    accounts), answers only someone with a confirmed email and free-address allowance left (one generic 403
    otherwise), and answers only available or not. **Staff:** `platform.mailbox.create` ★ (Global Administrator only)
    creates one in any customer account from Platform → account, without a password (the account's Owner or User
    Administrator sets it, guard rail 13), recorded as a staff action in the account's own log (rule 49); a refusal
    (missing permission, unknown account → 404) is recorded in the platform log only; refused during act-as.
16. **Platform audit IPs:** the platform audit shows the full stored IP only with `platform.audit.full_ip` ★ (Global
    Administrator only); other readers (`platform.audit.read`: Reports Reader) see the network part, like account audit
    logs and the person's Security activity (decided in the audit service; checked by the RBAC harness).

## Webmail

The webmail is not a console area and is not in the permission matrix: it is reached with a **mailbox** sign-in
(address + mailbox password) on the webmail origin, and a console session never grants it (RBAC harness: every
`webmail`-guarded route answers 401 to every console persona). What a webmail session can do is bounded by the BFF's
JMAP allow-list and its own mailbox (`accountId` must match). A mailbox that is `suspended` or `deleting` in the
control plane, or unknown to it, can't sign in, and an open session ends within 30 s (`MailboxAccessGate`). The
console's **Open webmail** link (person menu, customers only) pre-fills the address and nothing else.

Webmail **settings** (`/api/webmail/settings/*`) act on the session's own mailbox only — its preferences, its own
identities, its own Sieve rules — and every change carries the account the app is showing (`X-Webmail-Account`).
Mail-flow changes are audited in the mailbox's account as a `system` actor named by the mailbox, so the account's
admins see them. The forwarding confirmation (`POST /api/webmail/forwarding/confirm`) is public: the one-time token
is the authorisation, and an unknown, used or expired token is a 404.

## What each role sees (navigation)

| Area                     | Owner | Domain Adm | User Adm | Billing Adm | Member | Auditor | Staff                  |
| ------------------------ | ----- | ---------- | -------- | ----------- | ------ | ------- | ---------------------- |
| Overview                 | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | via act-as             |
| Mail (webmail link)      | own   | own        | own      | own         | own    | own     | ✗                      |
| Domains                  | ✓     | ✓          | read     | ✗           | ✗      | read    | via act-as             |
| People and roles         | ✓     | read       | Members  | ✗           | ✗      | read    | via act-as             |
| Mailboxes                | ✓     | read       | ✓        | ✗           | ✗      | read    | via act-as             |
| Aliases                  | all   | own        | all      | own         | own    | ✗       | via act-as             |
| App passwords            | own   | own        | own      | own         | own    | ✗       | ✗ (never via act-as)   |
| Billing                  | ✓     | ✗          | ✗        | ✓           | ✗      | read    | Billing Adm (platform) |
| Audit log                | ✓     | ✗          | ✓        | ✗           | ✗      | ✓       | Reports Reader, Global |
| Security activity (self) | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | —                      |
| Customer accounts        | ✗     | ✗          | ✗        | ✗           | ✗      | ✗       | all but Reports Reader |
| Staff console            | ✗     | ✗          | ✗        | ✗           | ✗      | ✗       | per platform role      |

The console groups these under section labels (Mail: Mailboxes, Aliases, Domains · People · Account: Billing, Audit
log · Platform for staff; `navTree` in `console-nav.ts`). Counts beside rows come from the same services with the
person's own permissions (mailboxes with `mailbox.read`, aliases with `alias.manage.own`, domains with `domain.read`,
pending invites with `member.read`), and the sidebar's main button is the first create action the role allows
(`mailbox.manage` → New mailbox, `member.manage` → New invite, `alias.manage.own` → New alias,
`platform.accounts.read` → Find an account). The app bar's **search** (`GET /api/search`, guard `session`) asks
each source only where the actor holds its permission, in their own accounts: it can't reach another account and
never returns more than the pages would.

## Testing

`npm run test:rbac` builds a throwaway tree (two customer accounts × every account role, every platform role, plus free users). It checks every route and server action against the matrix: allow, 403, cross-account 404, guard rails, suspension, and the expected audit entry. Expectations are **generated from the matrix**, so a new permission or route without a check fails the run. Playwright e2e role journeys (`tests/e2e/`) mirror it in the browser.
