// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The permission matrix — the single source of truth for roles (CLAUDE.md rule 35).
 * The server enforces it (packages/core authorize), the UI hides what a role can't do, and the RBAC harness
 * derives its expectations from it. Human-readable version: docs/internal/roles.md (update both together).
 *
 * Two scopes:
 * - platform: Anhourtec staff roles, granted per user.
 * - account:  roles inside one customer account (Plus/Supporter accounts can add people), granted per membership.
 */

export const PLATFORM_ROLES = [
  "global_admin",
  "support_admin",
  "trust_safety_admin",
  "billing_admin",
  "reports_reader",
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ACCOUNT_ROLES = ["owner", "domain_admin", "user_admin", "billing_admin", "member", "auditor"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ROLE_LABELS: Readonly<Record<`platform:${PlatformRole}` | `account:${AccountRole}`, string>> = {
  "platform:global_admin": "Global Administrator",
  "platform:support_admin": "Support Administrator",
  "platform:trust_safety_admin": "Trust & Safety Administrator",
  "platform:billing_admin": "Billing Administrator",
  "platform:reports_reader": "Reports Reader",
  "account:owner": "Owner",
  "account:domain_admin": "Domain Administrator",
  "account:user_admin": "User Administrator",
  "account:billing_admin": "Billing Administrator",
  "account:member": "Member",
  "account:auditor": "Read-only (Auditor)",
};

/** One line per account role, for role pickers ("Add a user", invites). The grants below are what counts. */
export const ACCOUNT_ROLE_SUMMARIES: Readonly<Record<AccountRole, string>> = {
  owner: "Everything in the account, including admins, billing and deleting it",
  domain_admin: "Adds and verifies domains; manages domain mail settings",
  user_admin: "Adds users and mailboxes, sets their passwords, invites and removes Members",
  billing_admin: "Plans, payments and invoices",
  member: "Uses their own mailbox; no account settings",
  auditor: "Reads settings and the audit log; changes nothing",
};

/** Account states that are not roles but change what a person can do. */
export const USER_STATES = ["anonymous", "invited", "free", "paid", "suspended"] as const;
export type UserState = (typeof USER_STATES)[number];

type PermissionDef = {
  scope: "platform" | "account" | "self";
  description: string;
  /** Critical permissions are never granted to Member or Read-only, and changes to them need a security review. */
  critical?: true;
};

export const PERMISSIONS = {
  // --- self (any signed-in person, about themselves)
  "self.profile.read": { scope: "self", description: "See own profile, roles and memberships" },
  "self.profile.manage": {
    scope: "self",
    description: "Edit own optional profile details (job title, department, phones, postal address)",
  },
  "self.security.manage": { scope: "self", description: "Own sign-ins, sessions, 2FA, app passwords" },

  // --- platform (Anhourtec staff)
  "platform.staff.manage": { scope: "platform", description: "Grant and revoke staff roles", critical: true },
  "platform.settings.manage": { scope: "platform", description: "Change platform settings", critical: true },
  "platform.accounts.read": { scope: "platform", description: "Look up customer accounts (never mail content)" },
  "platform.accounts.actAs": {
    scope: "platform",
    description:
      "Open a customer account read-only as Anhourtec support (time-limited, written reason, fresh step-up; never staff accounts)",
    critical: true,
  },
  "platform.users.resetCredentials": { scope: "platform", description: "Reset a customer's password or 2FA" },
  "platform.mailbox.create": {
    scope: "platform",
    description:
      "Create a free platform-domain address in any customer account (no password: the account sets it; never while acting as)",
    critical: true,
  },
  "platform.account.suspend": {
    scope: "platform",
    description:
      "Suspend a customer account or a person and lift it (fresh step-up, reason required; never while acting as)",
    critical: true,
  },
  "platform.invites.manage": { scope: "platform", description: "Send and resend invites" },
  "platform.mailflow.read": { scope: "platform", description: "Read mail-flow logs (metadata only)" },
  "platform.abuse.manage": { scope: "platform", description: "Work the abuse queue, restrict, suspend" },
  "platform.trust.manage": { scope: "platform", description: "Change trust tiers and sending limits", critical: true },
  "platform.billing.manage": { scope: "platform", description: "Plans, refunds, subscription state", critical: true },
  "platform.audit.read": { scope: "platform", description: "Read the platform audit log" },
  "platform.audit.full_ip": {
    scope: "platform",
    description: "See full client IP addresses in the platform audit log (everyone else sees the network part)",
    critical: true,
  },
  "platform.reports.read": { scope: "platform", description: "Read dashboards and reports" },

  // --- account (inside one customer account)
  "account.read": { scope: "account", description: "See account settings, people, domains" },
  "account.delete": { scope: "account", description: "Delete the account", critical: true },
  "account.admins.manage": {
    scope: "account",
    description: "Invite people with any role, change roles and remove anyone (never the last Owner)",
    critical: true,
  },
  "member.read": { scope: "account", description: "See the people in the account, their roles and pending invites" },
  "member.manage": {
    scope: "account",
    description: "Invite people as Members, resend and revoke those invites, remove Members",
  },
  "domain.read": { scope: "account", description: "See domains and DNS status" },
  "domain.manage": { scope: "account", description: "Add, verify, remove domains; catch-all" },
  "mailbox.read": { scope: "account", description: "See mailboxes and quotas" },
  "mailbox.manage": {
    scope: "account",
    description: "Create, suspend, delete and restore mailboxes (an Owner's or admin's mailbox: Owners only)",
  },
  "mailbox.password.reset": {
    scope: "account",
    description:
      "Set a new password on a mailbox (step-up; an Owner's or admin's mailbox: Owners only; never while acting as)",
    critical: true,
  },
  "member.credentials.reset": { scope: "account", description: "Reset a member's password or 2FA" },
  "alias.manage.any": { scope: "account", description: "Manage aliases for any mailbox in the account" },
  "alias.manage.own": { scope: "account", description: "Manage own aliases and masked aliases" },
  "app_password.manage.own": {
    scope: "account",
    description: "Create and revoke app passwords (mail apps) for own mailboxes",
  },
  // ADR-0024: the console's "Open webmail" signs the person in to their own mailbox without its password. Never the
  // Auditor role, which is also what staff hold while acting as someone (ADR-0023): act-as never reaches mail.
  "webmail.open.own": {
    scope: "account",
    description: "Open own mailbox in the webmail from the console, without its password (never while acting as)",
  },
  "billing.read": { scope: "account", description: "See plan and invoices" },
  "billing.manage": { scope: "account", description: "Change plan and payment method", critical: true },
  "audit.read": { scope: "account", description: "Read the account audit log" },
  "account.security.manage": {
    scope: "account",
    description: "Require two-factor sign-in or a passkey for everyone in the account",
    critical: true,
  },

  // --- account: collaboration (docs/internal/10-collaboration.md)
  "shared_mailbox.read": { scope: "account", description: "See shared mailboxes and who can use them" },
  "shared_mailbox.manage": {
    scope: "account",
    description: "Create and delete shared mailboxes; add and remove members (members get full access and send as)",
  },
  "distribution_list.read": { scope: "account", description: "See distribution lists, members and allowed senders" },
  "distribution_list.manage": { scope: "account", description: "Create and delete lists; manage members and senders" },
  "delegation.read": { scope: "account", description: "See who has delegated access to which mailbox" },
  "delegation.manage.own": {
    scope: "account",
    description: "Share own folders and grant send-on-behalf for own mailbox",
  },
  "delegation.manage.any": {
    scope: "account",
    description: "Grant or revoke full access, send as and folder access on any mailbox in the account",
    critical: true,
  },
  "forwarding.manage.own": { scope: "account", description: "Set forwarding and auto-replies on own mailbox" },
  "forwarding.manage.any": {
    scope: "account",
    description: "Set forwarding on any mailbox in the account",
    critical: true,
  },
  "mail_rule.read": { scope: "account", description: "See account-wide mail flow rules" },
  "mail_rule.manage": { scope: "account", description: "Create, change and delete account-wide mail flow rules" },
  "message_trace.read": { scope: "account", description: "Trace delivery of messages (metadata only, no content)" },
  "resource_mailbox.manage": { scope: "account", description: "Create and manage room and equipment mailboxes" },

  // --- account: folders and signatures (docs/internal/05-webmail.md, ADR-0014)
  "folder.manage.own": {
    scope: "account",
    description: "Create, rename, move and delete own folders; favourites, colours, saved searches",
  },
  "folder_policy.read": { scope: "account", description: "See account-wide archive and clean-up policies" },
  "folder_policy.manage": {
    scope: "account",
    description: "Set account-wide archive and clean-up policies (archive by year, Junk/Trash clean-up)",
  },
  "signature.manage.own": { scope: "account", description: "Create and choose own signatures" },
  "signature_template.read": { scope: "account", description: "See account signature templates" },
  "signature_template.manage": {
    scope: "account",
    description: "Create signature templates and push them to members' identities",
  },
  "disclaimer.read": { scope: "account", description: "See the account's outbound disclaimer" },
  "disclaimer.manage": {
    scope: "account",
    description: "Set the disclaimer appended to outgoing mail from every mailbox in the account",
    critical: true,
  },

  // --- account: newsletters and bulk sending add-on (docs/internal/11-bulk-sending.md, ADR-0015)
  "bulk.read": { scope: "account", description: "See bulk lists, campaigns, suppression and delivery stats" },
  "bulk.list.manage": {
    scope: "account",
    description: "Create lists, import subscribers with consent records, manage suppressions",
  },
  "bulk.campaign.send": {
    scope: "account",
    description: "Schedule and send campaigns to lists (bulk add-on only)",
    critical: true,
  },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

type ScopedPermission<S extends PermissionDef["scope"]> = {
  [P in Permission]: (typeof PERMISSIONS)[P]["scope"] extends S ? P : never;
}[Permission];
export type PlatformPermission = ScopedPermission<"platform">;
export type AccountPermission = ScopedPermission<"account">;

export const PLATFORM_GRANTS: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = {
  global_admin: [
    "platform.staff.manage",
    "platform.settings.manage",
    "platform.accounts.read",
    "platform.accounts.actAs",
    "platform.users.resetCredentials",
    "platform.mailbox.create",
    "platform.account.suspend",
    "platform.invites.manage",
    "platform.mailflow.read",
    "platform.abuse.manage",
    "platform.trust.manage",
    "platform.billing.manage",
    "platform.audit.read",
    "platform.audit.full_ip",
    "platform.reports.read",
  ],
  support_admin: [
    "platform.accounts.read",
    "platform.accounts.actAs",
    "platform.users.resetCredentials",
    "platform.invites.manage",
    "platform.mailflow.read",
  ],
  trust_safety_admin: [
    "platform.accounts.read",
    "platform.mailflow.read",
    "platform.abuse.manage",
    "platform.trust.manage",
  ],
  billing_admin: ["platform.accounts.read", "platform.billing.manage"],
  reports_reader: ["platform.audit.read", "platform.reports.read"],
};

export const ACCOUNT_GRANTS: Readonly<Record<AccountRole, readonly AccountPermission[]>> = {
  owner: [
    "account.read",
    "account.delete",
    "account.admins.manage",
    "member.read",
    "member.manage",
    "domain.read",
    "domain.manage",
    "mailbox.read",
    "mailbox.manage",
    "mailbox.password.reset",
    "member.credentials.reset",
    "alias.manage.any",
    "alias.manage.own",
    "app_password.manage.own",
    "webmail.open.own",
    "billing.read",
    "billing.manage",
    "audit.read",
    "account.security.manage",
    "shared_mailbox.read",
    "shared_mailbox.manage",
    "distribution_list.read",
    "distribution_list.manage",
    "delegation.read",
    "delegation.manage.own",
    "delegation.manage.any",
    "forwarding.manage.own",
    "forwarding.manage.any",
    "mail_rule.read",
    "mail_rule.manage",
    "message_trace.read",
    "resource_mailbox.manage",
    "folder.manage.own",
    "folder_policy.read",
    "folder_policy.manage",
    "signature.manage.own",
    "signature_template.read",
    "signature_template.manage",
    "disclaimer.read",
    "disclaimer.manage",
    "bulk.read",
    "bulk.list.manage",
    "bulk.campaign.send",
  ],
  domain_admin: [
    "account.read",
    "member.read",
    "domain.read",
    "domain.manage",
    "mailbox.read",
    "alias.manage.own",
    "app_password.manage.own",
    "webmail.open.own",
    "distribution_list.read",
    "delegation.manage.own",
    "forwarding.manage.own",
    "mail_rule.read",
    "mail_rule.manage",
    "message_trace.read",
    "folder.manage.own",
    "signature.manage.own",
  ],
  user_admin: [
    "account.read",
    "member.read",
    "member.manage",
    "domain.read",
    "mailbox.read",
    "mailbox.manage",
    "mailbox.password.reset",
    "member.credentials.reset",
    "alias.manage.any",
    "alias.manage.own",
    "app_password.manage.own",
    "webmail.open.own",
    "audit.read",
    "shared_mailbox.read",
    "shared_mailbox.manage",
    "distribution_list.read",
    "distribution_list.manage",
    "delegation.read",
    "delegation.manage.own",
    "forwarding.manage.own",
    "mail_rule.read",
    "message_trace.read",
    "resource_mailbox.manage",
    "folder.manage.own",
    "folder_policy.read",
    "folder_policy.manage",
    "signature.manage.own",
    "signature_template.read",
    "signature_template.manage",
    "disclaimer.read",
    "bulk.read",
    "bulk.list.manage",
  ],
  billing_admin: [
    "account.read",
    "billing.read",
    "billing.manage",
    "alias.manage.own",
    "app_password.manage.own",
    "webmail.open.own",
    "delegation.manage.own",
    "forwarding.manage.own",
    "folder.manage.own",
    "signature.manage.own",
  ],
  member: [
    "alias.manage.own",
    "app_password.manage.own",
    "webmail.open.own",
    "delegation.manage.own",
    "forwarding.manage.own",
    "folder.manage.own",
    "signature.manage.own",
  ],
  auditor: [
    "account.read",
    "member.read",
    "domain.read",
    "mailbox.read",
    "billing.read",
    "audit.read",
    "shared_mailbox.read",
    "distribution_list.read",
    "delegation.read",
    "mail_rule.read",
    "message_trace.read",
    "folder_policy.read",
    "signature_template.read",
    "disclaimer.read",
    "bulk.read",
  ],
};

/** Roles that may never hold a critical permission. Checked by unit tests over the matrix. */
export const NON_DELEGABLE_ROLES: readonly AccountRole[] = ["member", "auditor"];

/** Staff roles allowed to "act as" a customer (time-limited, banner, audited, never mail content). */
export const ACT_AS_ROLES: readonly PlatformRole[] = ["global_admin", "support_admin"];

/**
 * The one role staff hold inside the account while acting in it (ADR-0023): read-only. Every service check runs as for
 * an Auditor of that account, so nothing changes and owner-only actions answer 403; there is no "with changes" mode.
 */
export const ACT_AS_ACCOUNT_ROLE: AccountRole = "auditor";

export const isCritical = (p: Permission): boolean => "critical" in PERMISSIONS[p];

export function platformRoleCan(role: PlatformRole, p: Permission): boolean {
  return (PLATFORM_GRANTS[role] as readonly Permission[]).includes(p);
}

export function accountRoleCan(role: AccountRole, p: Permission): boolean {
  return (ACCOUNT_GRANTS[role] as readonly Permission[]).includes(p);
}
