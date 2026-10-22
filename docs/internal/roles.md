# Roles and permissions

Last updated: 2026-10-21

**Source of truth: `packages/shared/src/rbac`.** That code is canonical: the permission list, the role → permission matrix, critical-permission flags and guard rails. The UI (what to show), the API (what to allow) and the RBAC harness (`npm run test:rbac`) all derive from it. This document explains the matrix for people. If the two disagree, the code wins, and this file is updated in the same change (rule 35).

The model follows Microsoft 365 admin roles: a few platform (staff) roles, and per-account roles for people inside a customer account.

## Outcomes

| Situation                                                                    | Response                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------- |
| Not signed in, route needs a session                                         | **401**                                      |
| Signed in, lacks the permission                                              | **403**                                      |
| Has the permission, but the id belongs to another account (or doesn't exist) | **404**: never confirm another account's ids |
| Guard rail violated (last Owner, escalation)                                 | **409** with a plain message                 |

Checks live in the **service layer** (permission + ownership scope). Route handlers and UI checks are conveniences; the server is the gate.

## States before an account

| State         | Can                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anonymous** | Marketing pages, docs, changelog, credits; sign up while sign-up is open (`SIGNUP_MODE=open`)                                                                                                                                               |
| **Free user** | An Owner of their own personal account with the Free plan: one `@anhourmail.com` mailbox, aliases and masked aliases within Free limits, own settings, Security activity, export, delete account. They cannot add people or custom domains. |

## Platform roles (Anhourtec staff)

| Role                                 | Can                                                                                                                                                                         | Cannot                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Global Administrator**             | Everything: platform settings, integrations (secrets are write-only), staff role management, all platform-role abilities below, act-as                                      | Read mail content (no such path exists)                               |
| **Support Administrator**            | View accounts and members; reset a user's password/2FA (forces re-enrolment, notifies the user); resend invites; view mail-flow logs (metadata only); act-as (time-limited) | Billing changes, trust-tier changes, staff role changes, mail content |
| **Trust & Safety Administrator**     | Abuse queue; restrict, suspend and unsuspend accounts and mailboxes; change trust tiers and sending limits; view abuse signals                                              | Billing, staff roles, act-as, mail content                            |
| **Billing Administrator** (platform) | Plans, refunds, invoices, subscription state, credits                                                                                                                       | Trust tiers, staff roles, act-as                                      |
| **Reports Reader**                   | Read-only dashboards, platform audit log, aggregate metrics                                                                                                                 | Any change                                                            |

## Account roles (inside a customer account)

Plus and Supporter accounts can add people (family, a small group). Free accounts have one Owner and nobody else.

| Role                                    | Can                                                                                                                                                    | Cannot                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **Owner** (global admin of the account) | Everything in the account, including deleting it, managing admins and transferring ownership                                                           | Remove or demote the last Owner                      |
| **Domain Administrator**                | Add, verify and remove domains; see DNS records and checks; set catch-all                                                                              | Billing, people management, delete account           |
| **User Administrator**                  | Create, suspend and delete mailboxes; invite and remove Members; reset Member passwords/2FA; manage anyone's aliases and masked aliases in the account | Change admin roles, billing, domains, delete account |
| **Billing Administrator** (account)     | Plan changes, payment method, invoices, refunds request                                                                                                | Domains, people, mailboxes                           |
| **Member**                              | Their own mailbox, own aliases and masked aliases, own settings, own Security activity, app passwords, export own mailbox                              | Anything account-wide                                |
| **Read-only (Auditor)**                 | View settings, people, domains, mailboxes (metadata), and the account audit log; export the audit log                                                  | Any change                                           |

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

| Scope    | Permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| self     | `self.profile.read`, `self.security.manage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| platform | `platform.staff.manage` ★, `platform.settings.manage` ★, `platform.accounts.read`, `platform.accounts.actAs` ★, `platform.users.resetCredentials`, `platform.invites.manage`, `platform.mailflow.read`, `platform.abuse.manage`, `platform.trust.manage` ★, `platform.billing.manage` ★, `platform.audit.read`, `platform.reports.read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| account  | `account.read`, `account.delete` ★, `account.admins.manage` ★, `domain.read`, `domain.manage`, `mailbox.read`, `mailbox.manage`, `member.credentials.reset`, `alias.manage.any`, `alias.manage.own`, `billing.read`, `billing.manage` ★, `audit.read`, `shared_mailbox.read`, `shared_mailbox.manage`, `distribution_list.read`, `distribution_list.manage`, `delegation.read`, `delegation.manage.own`, `delegation.manage.any` ★, `forwarding.manage.own`, `forwarding.manage.any` ★, `mail_rule.read`, `mail_rule.manage`, `message_trace.read`, `resource_mailbox.manage`, `folder.manage.own`, `folder_policy.read`, `folder_policy.manage`, `signature.manage.own`, `signature_template.read`, `signature_template.manage`, `disclaimer.read`, `disclaimer.manage` ★, `bulk.read`, `bulk.list.manage`, `bulk.campaign.send` ★ |

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

## What each role sees (navigation)

| Area                     | Owner | Domain Adm | User Adm | Billing Adm | Member | Auditor | Staff                  |
| ------------------------ | ----- | ---------- | -------- | ----------- | ------ | ------- | ---------------------- |
| Overview                 | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | via act-as             |
| Mail (webmail link)      | own   | own        | own      | own         | own    | own     | ✗                      |
| Domains                  | ✓     | ✓          | read     | ✗           | ✗      | read    | via act-as             |
| People & mailboxes       | ✓     | read       | ✓        | ✗           | ✗      | read    | via act-as             |
| Aliases                  | all   | own        | all      | own         | own    | ✗       | via act-as             |
| Billing                  | ✓     | ✗          | ✗        | ✓           | ✗      | read    | Billing Adm (platform) |
| Audit log                | ✓     | ✗          | ✓        | ✗           | ✗      | ✓       | Reports Reader, Global |
| Security activity (self) | ✓     | ✓          | ✓        | ✓           | ✓      | ✓       | —                      |
| Staff console            | ✗     | ✗          | ✗        | ✗           | ✗      | ✗       | per platform role      |

## Testing

`npm run test:rbac` builds a throwaway tree (two customer accounts × every account role, every platform role, plus free users). It checks every route and server action against the matrix: allow, 403, cross-account 404, guard rails, suspension, and the expected audit entry. Expectations are **generated from the matrix**, so a new permission or route without a check fails the run. Playwright e2e role journeys (`tests/e2e/`) mirror it in the browser.
