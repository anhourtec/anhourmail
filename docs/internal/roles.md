# Roles and permissions

Last updated: 2026-10-31 (delegates can't change a shared mailbox's Safe senders, ADR-0027, matrix unchanged; password-first sign-in and password-only step-up, ADR-0028, matrix unchanged; webmail sender name route; names edited through the profile rule; matrix unchanged; 2026-10-30: mailbox delegation, ADR-0026: mailboxes shared with the person in the webmail; console routes and RBAC harness rows; `delegation.manage.any` for User Administrators with guard rail 8; data export and account deletion, ADR-0025; staff support access / act-as, ADR-0023; profile photos; first-sign-in password gate, console page statuses, mailbox handovers, Add a user availability)

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

Console pages answer with the same statuses. Layout guards (`apps/web/src/server/route-guard.ts`) run before a
segment's loading boundary, so the HTTP status is real: an account page for someone outside the account is **404**
(`requireAccountMember`), an account section whose permission the role lacks is **403** with the account's
`forbidden.tsx` page (`requireAccountSection`; a suspended account still renders its notice), and a staff page
without the permission is **404** (`requirePlatformPermission`). The services check everything again.

## States before an account

| State         | Can                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous** | Marketing pages, docs, changelog, credits; sign up while sign-up is open (`SIGNUP_MODE=open`)                                                                                                                                                                                                         |
| **Free user** | An Owner of their own personal account with the Free plan: one `@anhourmail.com` mailbox (claimed once their sign-in email is confirmed; ADR-0021), aliases and masked aliases within Free limits, own settings, Security activity, export, delete account. They cannot add people or custom domains. |

## Platform roles (Anhourtec staff)

| Role                                 | Can                                                                                                                                                                                                                                                                                       | Cannot                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Global Administrator**             | Everything: platform settings, integrations (secrets are write-only), staff role management, all platform-role abilities below, act-as, create a free platform address in a customer account (no password), suspend and restore customer accounts and people (`platform.account.suspend`) | Read mail content (no such path exists); set a customer's mailbox password |
| **Support Administrator**            | View accounts and members; reset a user's password/2FA (forces re-enrolment, notifies the user); resend invites; view mail-flow logs (metadata only); act-as (read-only support access, time-limited; ADR-0023)                                                                           | Billing changes, trust-tier changes, staff role changes, mail content      |
| **Trust & Safety Administrator**     | Abuse queue; restrict accounts; change trust tiers and sending limits; view abuse signals (suspending accounts and people is Global Administrator only for now: `platform.account.suspend`)                                                                                               | Billing, staff roles, act-as, mail content                                 |
| **Billing Administrator** (platform) | Plans, refunds, invoices, subscription state, credits                                                                                                                                                                                                                                     | Trust tiers, staff roles, act-as                                           |
| **Reports Reader**                   | Read-only dashboards, platform audit log, aggregate metrics                                                                                                                                                                                                                               | Any change                                                                 |

## Account roles (inside a customer account)

Plus and Supporter accounts can add people (family, a small group). Free accounts have one Owner and nobody else.

| Role                                    | Can                                                                                                                                                                                                                                                                                                                                                                                                                                | Cannot                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Owner** (global admin of the account) | Everything in the account, including exporting its data and deleting it (grace period, cancellable), managing admins, transferring ownership and requiring a second sign-in step                                                                                                                                                                                                                                                   | Remove or demote the last Owner                      |
| **Domain Administrator**                | Add, verify and remove domains; see DNS records and checks; set catch-all                                                                                                                                                                                                                                                                                                                                                          | Billing, people management, delete account           |
| **User Administrator**                  | Create mailboxes (with a password); suspend, delete, restore and set the password of Members', unassigned and their own mailboxes (an Owner's or another admin's: Owner only); invite and remove Members (`member.manage`); reset Member passwords/2FA; manage anyone's aliases and masked aliases in the account; give people read and manage, send as or send on behalf on mailboxes (an Owner's or another admin's: Owner only) | Change admin roles, billing, domains, delete account |
| **Billing Administrator** (account)     | Plan changes, payment method, invoices, refunds request                                                                                                                                                                                                                                                                                                                                                                            | Domains, people, mailboxes                           |
| **Member**                              | Their own mailbox, own aliases and masked aliases, own settings, own Security activity, app passwords, export own mailbox                                                                                                                                                                                                                                                                                                          | Anything account-wide                                |
| **Read-only (Auditor)**                 | View settings, people, domains, mailboxes (metadata), and the account audit log; export the audit log                                                                                                                                                                                                                                                                                                                              | Any change                                           |

A person can hold several account roles. Permissions are the union.

### Collaboration (`10-collaboration.md`)

| Role                  | Shared mailboxes & lists                           | Delegation & forwarding                                                                                                        | Mail rules & trace  |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Owner                 | Manage                                             | **Any mailbox**: read and manage, send as, send on behalf (critical); forwarding any mailbox (critical, Owner only)            | Manage, trace       |
| Domain Administrator  | See lists                                          | Own forwarding and auto-reply only                                                                                             | Manage rules, trace |
| User Administrator    | Manage shared mailboxes, lists, resource mailboxes | **Any mailbox** except an Owner's or another admin's (guard rail 8): read and manage, send as, send on behalf; sees all grants | See rules, trace    |
| Billing Administrator | —                                                  | Own forwarding and auto-reply only                                                                                             | —                   |
| Member                | — (uses shared mailboxes they belong to)           | Uses what an administrator gave them; own forwarding and auto-reply                                                            | —                   |
| Read-only (Auditor)   | See                                                | See all grants                                                                                                                 | See rules, trace    |

Guard rail: granting access to **someone else's** mailbox (read and manage, send as, send on behalf; ADR-0026) is
critical (`delegation.manage.any`): Owners and User Administrators, with guard rail 8 applied per mailbox (an Owner's or
an administrator's mailbox: Owners only, 403 audited), a fresh step-up per change, never while acting as (403), on plans
with `delegation`. A User Administrator can already remove Members and set their mailbox passwords, so this adds no
reach. Every grant and revoke is audited in the account's log, and the mailbox's person is told. Forwarding any mailbox
stays Owner-only. `delegation.manage.own` is reserved for owner-granted folder sharing (later) and checked nowhere yet.

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

| Scope    | Permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| self     | `self.profile.read`, `self.profile.manage`, `self.security.manage`, `self.data.export`, `self.login.delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| platform | `platform.staff.manage` ★, `platform.settings.manage` ★, `platform.accounts.read`, `platform.accounts.actAs` ★, `platform.users.resetCredentials`, `platform.mailbox.create` ★, `platform.account.suspend` ★, `platform.invites.manage`, `platform.mailflow.read`, `platform.abuse.manage`, `platform.trust.manage` ★, `platform.billing.manage` ★, `platform.audit.read`, `platform.audit.full_ip` ★, `platform.reports.read`, `platform.deletions.read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| account  | `account.read`, `account.delete` ★, `account.export` ★, `account.admins.manage` ★, `account.security.manage` ★, `member.read`, `member.manage`, `domain.read`, `domain.manage`, `mailbox.read`, `mailbox.manage`, `mailbox.password.reset` ★, `member.credentials.reset`, `alias.manage.any`, `alias.manage.own`, `app_password.manage.own`, `webmail.open.own`, `billing.read`, `billing.manage` ★, `audit.read`, `shared_mailbox.read`, `shared_mailbox.manage`, `distribution_list.read`, `distribution_list.manage`, `delegation.read`, `delegation.manage.own`, `delegation.manage.any` ★, `forwarding.manage.own`, `forwarding.manage.any` ★, `mail_rule.read`, `mail_rule.manage`, `message_trace.read`, `resource_mailbox.manage`, `folder.manage.own`, `folder_policy.read`, `folder_policy.manage`, `signature.manage.own`, `signature_template.read`, `signature_template.manage`, `disclaimer.read`, `disclaimer.manage` ★, `bulk.read`, `bulk.list.manage`, `bulk.campaign.send` ★ |

★ = **critical**. Never granted to Member or Read-only (`NON_DELEGABLE_ROLES`, checked by unit tests over the matrix), never delegable by a non-Owner, and always audited with before/after values. The grants per role are `PLATFORM_GRANTS` and `ACCOUNT_GRANTS` in the code. Act-as roles are `ACT_AS_ROLES`. New permissions (export, invites per account, refunds, …) are added to the code first, then here.

## Guard rails

1. **At least one Owner** always exists per account. The last Owner cannot leave, be removed or be demoted (409). Ownership transfer is a two-step accept.
2. **No escalation:** nobody can grant a role or permission they don't hold themselves. Only Owners manage admin roles. Members and Auditors can never receive critical permissions.
3. **Platform roles are granted only by a Global Administrator.** At least one Global Administrator always exists.
4. **Act-as (support access, ADR-0023)** is for Global and Support Administrators only (`platform.accounts.actAs` ★,
   `ACT_AS_ROLES`):
   - started from Platform → account → "Open with support access", with a written reason (10–500 characters; the
     account's admins see it, so never secrets) and a **fresh step-up** (403 `step_up_required`);
   - **read-only only**: staff hold `ACT_AS_ACCOUNT_ROLE` (= `auditor`) in that one account and nothing else — their
     platform roles are set aside (staff pages 404, staff APIs 403) and their own customer accounts are 404 while
     acting. Every service runs its normal checks: changes and owner-only actions answer **403**, other accounts
     **404**. There is no "with changes" mode;
   - **never into a staff account**: an account where anyone holds a platform role or signs in at `anhourtec.com`
     or a subdomain of it answers 403 `staff_account` (rule 28), checked again on every request while acting;
     suspended accounts 409;
   - no profile or photo changes while acting, their own included (403);
   - 30 minutes, renewable from the banner with a new reason and a fresh step-up, at most 4 hours from the start; bound
     to the console session that started it (other sessions stay in the staff view; signing out ends it); one open
     session per staff member, several staff may act in the same account at once;
   - shows a banner on every console page with Extend and End; ending or expiry drops back to the staff view;
   - every action, including refused attempts, is audited as staff with `on_behalf_of` (staff member, account, act-as
     session id); start, renewal and end are in the account's log and the platform log;
   - visible to the account's admins as "Anhourtec staff · Support access" (`audit.md`), and the Owners are emailed when
     it starts;
   - it **never exposes mail content**: no webmail link, handoff or session while acting;
   - RBAC harness: three acting personas started through the real flow (Support and Global Administrator in account
     A, Support Administrator in account B) run every route from the matrix; renew and end use the `act_as` guard
     (404 for everyone else signed in); starting into a staff account is checked as 403.
5. **Mail content is never visible to staff** through any console path.
6. **Suspended** users and accounts (staff suspension, guard rail 17): a suspended person can't sign in at all; the
   people of a suspended account sign in but see only the suspension notice and their own Security page (every
   account permission answers **403** `account_suspended`). Export during a suspension is by request.
7. Changes to roles, sending limits, signup gating or abuse logic need a `security-reviewer` pass (rule 27).
8. **Mailbox lifecycle above your role:** suspending, resuming, deleting or restoring a mailbox assigned to an Owner
   or any admin (any role but Member) takes an Owner. A User Administrator holds `mailbox.manage` but gets **403**
   (audited as `denied`) for those mailboxes, except their own; the console hides the actions for them. This is a
   per-mailbox check in the service (`packages/core/src/mailboxes/service.ts`), not a separate permission, so the
   matrix and the RBAC harness (random ids → 404) are unchanged; unit tests cover it.
9. **People and invites** (`packages/core/src/people/service.ts`, checked in the service, unit-tested). "Add a user"
   (`mailboxes/add-user.ts`) needs `mailbox.manage` and grants only `grantableRoles` (Owner: any; User Admin: Member;
   anything else **403**, audited as `denied`); no new permission, so the matrix and harness keep their shape (the
   route is in `routes.ts` with guard `mailbox.manage`). A user added this way with the Member role sees only their own
   pages in the console (Aliases, App passwords, Security): no domains, people, billing or audit. Whether "Add a user"
   and "Invite someone" are offered at all (sidebar, Home, Mailboxes, the Add a user page) is decided once per request
   by `people/availability.ts` (`ready`, `full` with a reason, or `unavailable` — role, plan, no domain, email
   unverified) from what the services already return; the services still check everything again.
   "Make this a user" (`mailboxes/make-user.ts`, `POST …/mailboxes/:mailboxId/user`) has the same gate on an
   unassigned mailbox, **plus a fresh step-up** (it replaces the password of a mailbox already in use, like
   `mailbox.password.reset`), asked before anything is looked up about the address; another account's mailbox is
   **404**. The mailbox's app passwords are revoked in the same step.
   - Profile details ("Edit profile", `people/profile-service.ts`): the person themself always
     (`self.profile.manage`, a `self` permission: their Profile page `PUT /api/me/profile`, or their own person panel);
     on the People page `member.manage` edits a Member's (`PUT …/people/:userId/profile`) and anyone else's needs an
     Owner (`account.admins.manage`; a User Admin gets **403**, audited as `denied`); someone outside the account is
     **404**. Viewing them needs `member.read`. The details belong to the person, not the account: someone who also
     belongs to another account is edited only by themself (admins get **403** "This person also belongs to another
     account, so only they can change their profile.", audited as `denied` `other_account`; the panel hides Edit), so
     one account's admins can't change what another account sees. Someone holding any platform role (Global
     Administrator or another staff role) counts the same, even with one account (`holdsPlatformRole`): a customer
     Owner can't rename staff or change their photo, from the console or a mailbox's webmail. A malformed body is
     **400** `bad_request` and changes nothing (never read as "no details").
   - Profile photos (ADR-0022, `avatars/service.ts`; no new permission): a person's photo follows the profile details
     rule exactly — the person themself (`self.profile.manage`: `POST`/`DELETE /api/me/avatar`, their own panel, or
     the webmail of one of their mailboxes), `member.manage` for a Member and an Owner for anyone else
     (`POST`/`DELETE …/people/:userId/avatar`; **403** `forbidden` / `other_account`, audited as `denied`; **404**
     outside the account). A mailbox without a person has its own photo: `mailbox.manage`
     (`POST`/`DELETE …/mailboxes/:mailboxId/avatar`; a mailbox with a person is **409**, it shows the person's) or that
     mailbox's own webmail session (`/api/webmail/settings/avatar`). The webmail of a person's mailbox changes the
     person's photo only while they are a member of that mailbox's account and of no other, and hold no platform role
     (else **403**, audited as
     `denied` `other_account`, or `not_member` once they've left it): an admin who resets the mailbox password can't use
     it to change what another account shows. Only current memberships count anywhere (a removed person's old
     mailboxes keep their owner link, but that account no longer sees their photo). Seeing a photo (`GET /api/avatars/:kind/:id`):
     the person, anyone with `member.read` or `mailbox.read` in an account the person (or mailbox) is in, staff with
     `platform.accounts.read`; a member of that account without either gets **403**, anyone else **404**. In the
     webmail only mailboxes and people of the session's mailboxes' accounts (`/api/webmail/avatars/*`, **404**
     otherwise).
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
    everyone in the account must use as the second step after their password (ADR-0028) — nothing extra, two-factor
    sign-in (authenticator app or passkey) or a passkey. The Owner must meet it first (409). "Confirm it's you"
    (step-up) is the console password for every role and session; the matrix is unchanged. A person missing what any of their accounts requires
    (`UserActor.mustEnrol`) passes only `self` permissions until they set it up: every other permission answers **403**
    `enrolment_required` (another account's ids stay **404**), and console pages send them to their Security page.
    Removing a factor a requirement depends on is refused (409). Their own Security page (`self.security.manage`) lists
    and signs out their sessions and renames/removes their passkeys; another person's session or passkey id is **404**.
    **First-sign-in password change** (console): a person whose console password an admin set with "Require password
    change at first sign-in" (`user_profile.must_change_password`, `UserActor.mustChangePassword`) passes only `self`
    permissions until they choose their own: every other permission answers **403** `password_change_required`
    (`packages/core/src/actor.ts`) and console pages send them to `/change-password`. Changing it clears the flag.
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
    has it too; the stricter checks are unit-tested. **Console → webmail handoff**
    (`packages/core/src/webmail/handoff.ts`, ADR-0024): `webmail.open.own` (every role but the Auditor — the role
    staff hold while acting, so support access never reaches mail) opens the person's **own** mailbox in the webmail
    without its password: anyone else's, a shared or an unassigned mailbox is a 404, acting as someone a 403 (also
    refused explicitly, in case the matrix ever changes); it needs a recent step-up (403 `step_up_required`), like
    creating an app password. Redemption re-checks the person, the step-up and the console session from the database;
    the webmail session ends with that console session. Audited `webmail.handoff_started` / `webmail.handoff_redeemed`.
    **Data export and account deletion** (`packages/core/src/data`, ADR-0025): `account.export` ★ (Owner) asks for and
    downloads an export of the account's control-plane data; `self.data.export` (everyone) of their own data. Only the
    person who asked lists or downloads an export (anyone else's id 404); downloading needs a recent step-up (403
    `step_up_required`). Mail is exported by each mailbox's own person from the webmail (their own session), never by
    an Owner. `account.delete` ★ (Owner) needs a step-up and the account's name typed exactly (400 otherwise); the
    account then waits `ACCOUNT_DELETION_GRACE_DAYS`, its mailboxes suspended, and only reads, `account.export` and
    `account.delete` (cancel) work in it for everyone (403 `account_deleting`, `allowedWhileDeleting`); every member
    sees a notice. `self.login.delete` deletes one's own console login when no account depends on it (409 otherwise:
    a mailbox of theirs anywhere, an account they alone own that isn't empty, a platform role). All of these are
    refused while acting as someone (403 `act_as`; the Auditor role staff hold lacks the account ones anyway).
    `platform.deletions.read` (Global Administrator) lists pending deletions; staff can't cancel or force one.
13. **Mailbox passwords** (`packages/core/src/mailboxes/password.ts`, ADR-0020 "Mailbox passwords"): creating a
    mailbox (`mailbox.manage`) takes its initial password. Setting a new one later is `mailbox.password.reset` ★ (Owner,
    User Administrator; critical because a password opens the mailbox's mail): it needs a fresh step-up (403
    `step_up_required`), follows guard rail 8 (an Owner's or admin's mailbox: Owners only, 403 audited), and is
    **refused during act-as** (403 `act_as`, audited) — staff never choose a customer's mailbox password; creating a
    mailbox during act-as is refused for the same reason. The mailbox's person (if it has one) is emailed. The person's
    own change happens in the webmail (mailbox sign-in, current password proved to Stalwart), outside this matrix.
    While an administrator's new password is waiting for the worker (or its job gave up), that own change is refused
    (**409** `password_change_pending`, audited as denied), so someone who knows only the old password can't override
    the handover; a console password reset for a login whose address is such a mailbox is held the same way (`audit.md`
    "Mailbox handovers").
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

17. **Staff suspension** (`packages/core/src/platform/suspension.ts`): `platform.account.suspend` ★ (Global
    Administrator only) suspends a customer account or a person and lifts it, from Platform → account. It needs a
    fresh step-up (403 `step_up_required`), a reason category (`SUSPENSION_REASONS`; 400 without one) and an optional
    internal note, and is refused during act-as (403 `act_as`). Missing permission → 403 and an unknown account or
    person → 404, both recorded in the platform log only. Suspending staff (anyone with a platform role) or yourself is
    refused (409, audited as denied); suspending twice or lifting what isn't suspended is 409. Effects: an account's
    usable mailboxes are suspended through the provisioning job (mail kept; no sign-in, sending or receiving) and its
    people get 403 `account_suspended` on every account permission; a person's sessions end, their sign-in is
    refused with a notice and the appeal address, and the mailboxes assigned to them (in any account) are suspended.
    Each mailbox it suspends gets a hold, so lifting resumes exactly those — never one the account had suspended
    itself — and the account's admins can't resume a held mailbox (409). Recorded as `trust.suspended` /
    `trust.unsuspended` by staff in the affected accounts' logs (rule 49) and in the platform log (which alone keeps
    the internal note). The account's Owners and administrators, or the person, are emailed.
18. **Admin-locked aliases** (`packages/core/src/aliases/service.ts`): an alias that someone with
    `alias.manage.any` (Owner, User Administrator) turns off on a mailbox that isn't their own is locked off
    (`mail_alias.admin_locked`). Its own person (`alias.manage.own` only) can see it ("Turned off by an administrator")
    but turning it on or deleting it answers **403** `alias_admin_locked`, audited as `denied` (deleting would free the
    address to be added again). Turning it off again is allowed and keeps the lock. Anyone with `alias.manage.any`
    lifts it by turning it on (meta `adminLockLifted`), and may delete it. Out-of-scope aliases stay **404**. No new
    permission, so the matrix keeps its shape; the RBAC harness probes the refusals (Member 403, another account's
    Owner 404, alias unchanged) and `tests/e2e/aliases.spec.ts` walks owner lock → member view → owner lift.
19. **Mailbox delegation** (`packages/core/src/delegation`, ADR-0026): `delegation.read` (Owner, User Administrator,
    Auditor) sees a mailbox's three lists — read and manage, send as, send on behalf — and a person's grants;
    `delegation.manage.any` ★ (Owner, User Administrator) adds and removes people on them in one batch. Checked in the
    service, in this order: never while acting as (**403** `act_as`, before anything is looked up); the mailbox is in
    the account (**404**); guard rail 8 (an Owner's or another admin's mailbox: Owners only, **403** audited); the plan
    has `delegation` (**403** `plan_limit`); the mailbox isn't being deleted (**409**); a fresh step-up (**403**
    `step_up_required`); every person is a member of the account (**404**); nobody is a delegate of their own mailbox
    (**409**); at most `DELEGATES_PER_MAILBOX` people per mailbox and `DELEGATED_MAILBOXES_PER_PERSON` mailboxes per
    person (**409**). One audit entry per change (`delegation.granted` / `delegation.revoked`, reason `admin`). Removing
    someone with "Give full access to …" (`removeMember` `delegateTo`) and **Convert to shared mailbox**
    (`mailboxes/convert-to-shared.ts`, `mailbox.manage`, step-up, guard rail 8) need `delegation.manage.any` as well for
    the grant part (403 for the whole request without it). Grants go with the person (removal), the mailbox (deletion,
    purge) and "Make this a user" (the new person's own), each audited. Guard rail 8 survives a promotion: when someone
    becomes an Owner, or a Member gets an admin role (`changeMemberRole`, or "Make this a user" with a role other than
    Member), the grants on their mailboxes that weren't made by a current Owner are revoked in the same transaction
    (`delegation.revoked`, reason `role_changed`); an Owner's grants stay. The batch and the conversion take the account
    lock before reading the mailbox and members. Routes (`apps/web/src/server/routes.ts`): `GET`/`PATCH
/api/accounts/:accountId/mailboxes/:mailboxId/delegation` (`delegation.read` / `delegation.manage.any`), `POST
…/mailboxes/:mailboxId/convert-to-shared` (`mailbox.manage`), `GET /api/accounts/:accountId/people/:userId/delegation`
    (`delegation.read`) and the optional `{ delegateTo }` body on `DELETE …/people/:userId` (`member.manage`). The RBAC
    harness probes every one as every persona (random ids → 404; the empty batch → 400 for allowed callers); unit tests
    cover every refusal, and route tests (`apps/web/src/server/delegation-routes.test.ts`) the HTTP mapping.

## Webmail

The webmail is not a console area and is not in the permission matrix: it is reached with a **mailbox** sign-in
(address + mailbox password) on the webmail origin, and a console session never grants it (RBAC harness: every
`webmail`-guarded route answers 401 to every console persona). What a webmail session can do is bounded by the BFF's
JMAP allow-list and its own mailbox (`accountId` must match). A mailbox that is `suspended` or `deleting` in the
control plane, or unknown to it, can't sign in, and an open session ends within 30 s (`MailboxAccessGate`). A
mailbox with `must_change_password` set may only change its password or sign out: every other webmail route answers
**403** `password_change_required` (`PasswordChangeGate`, `apps/web/src/server/webmail/password-gate.ts`, applied by
`route()` to every `session: "webmail"` route unless it opts in). The
console's **Open webmail** link (person menu, sidebar, home; customers only, never while acting) starts the handoff
(ADR-0024): `webmail.open.own` — every account role except Auditor, which is also the role staff hold while acting, so
act-as never reaches mail — opens the person's **own** mailbox without its password. Someone else's, a shared or an
unassigned mailbox is a **404**, acting as someone a **403**, signed out a **401**; an Auditor (and anyone whose
mailbox owes a password change) is sent to the ordinary sign-in page. RBAC harness: `POST
/api/accounts/:accountId/mailboxes/:mailboxId/webmail-handoff` (random id → 404 for anyone allowed; Auditor and acting
personas 403), the public start and redemption on the webmail origin.

Webmail **settings** (`/api/webmail/settings/*`) act on the session's own mailbox only — its preferences, its own
identities, its own Sieve rules — and every change carries the account the app is showing (`X-Webmail-Account`).
Mail-flow changes are audited in the mailbox's account as a `system` actor named by the mailbox, so the account's
admins see them. The **sender name** (`PUT /api/webmail/settings/sender-name`) is the mailbox person's name: it
follows the console's profile edit rule from the mailbox's side (no new permission; the session proved the mailbox's
password) — allowed only when the mailbox follows its person and that person is in no other account and holds no
platform role, else **403**
(`admin_set`, `other_account`, `not_member`, audited as denied). The console name edit is the existing profile edit
(`self.profile.manage` for yourself; `member.manage` for a Member, an Owner for anyone; never during act-as). The
forwarding confirmation (`POST /api/webmail/forwarding/confirm`) is public: the one-time token
is the authorisation, and an unknown, used or expired token is a 404.

**Mailboxes shared with the person** (ADR-0026 §6): no permission of its own — a grant on the mailbox
(`mailbox_delegation`) is the authorisation, for any account role including Auditor, checked against the database on
every request. The matrix check on opening one is the self-level one only (`self.profile.read`: a signed-in person who
isn't suspended); membership, the right and the plan come from the grant table and the account, never from the
matrix. A webmail session lists and opens what its own mailboxes' people hold (`POST
/api/webmail/mailboxes/delegated`; every refusal — no grant, unknown address, another account's — is the same **404**,
audited in the person's own account; act-as on the console session behind a handoff-born session is a **403**). While
a delegated mailbox is active, only routes marked `delegated: "full_access"` (reads, downloads, the image proxy) act on
it; sending, drafts, uploads, identities, settings, contacts and export answer **403** `own_mailbox_only`. RBAC harness:
the new route is `webmail`-guarded (401 to every console persona). A delegate can't change a shared mailbox's Safe
senders either (ADR-0027 §8): `POST`/`DELETE /api/webmail/settings/junk/safe` answer **403** `own_mailbox_only` in its
tab, audited `denied` with the person as actor; images there still match that mailbox's own list. No matrix change (a
webmail session acts as its mailbox); both routes are `webmail`-guarded in the harness.

## What each role sees (navigation)

| Area                     | Owner | Domain Adm | User Adm | Billing Adm | Member | Auditor | Staff                                   |
| ------------------------ | ----- | ---------- | -------- | ----------- | ------ | ------- | --------------------------------------- |
| Overview                 | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | read via act-as                         |
| Mail (webmail link)      | own   | own        | own      | own         | own    | own†    | ✗                                       |
| Domains                  | ✓     | ✓          | read     | ✗           | ✗      | read    | read via act-as                         |
| People and roles         | ✓     | read       | Members  | ✗           | ✗      | read    | read via act-as                         |
| Mailboxes                | ✓     | read       | ✓        | ✗           | ✗      | read    | read via act-as                         |
| Aliases                  | all   | own        | all      | own         | own    | ✗       | ✗ (not via act-as)                      |
| App passwords            | own   | own        | own      | own         | own    | ✗       | ✗ (never via act-as)                    |
| Billing                  | ✓     | ✗          | ✗        | ✓           | ✗      | read    | Billing Adm; read via act-as            |
| Audit log                | ✓     | ✗          | ✓        | ✗           | ✗      | ✓       | Reports Reader, Global; read via act-as |
| Security activity (self) | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | —                                       |
| Profile (self)           | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | —                                       |
| Your data (self)         | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | own; ✗ via act-as                       |
| Account settings         | ✓     | ✗          | ✗        | ✗           | ✗      | ✗       | ✗ (never via act-as)                    |
| Pending deletions        | ✗     | ✗          | ✗        | ✗           | ✗      | ✗       | Global Administrator                    |
| Customer accounts        | ✗     | ✗          | ✗        | ✗           | ✗      | ✗       | all but Reports Reader                  |
| Staff console            | ✗     | ✗          | ✗        | ✗           | ✗      | ✗       | per platform role                       |

† The link opens one's own mailbox without its password (`webmail.open.own`, ADR-0024) for every role but Auditor;
an Auditor gets the ordinary webmail sign-in page.

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
