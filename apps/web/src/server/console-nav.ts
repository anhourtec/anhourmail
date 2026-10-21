// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, can } from "@anhourmail/core";
import type { Permission } from "@anhourmail/shared/rbac";

/**
 * Console navigation, derived from the permission matrix (CLAUDE.md rule 35): an item shows only when the
 * actor holds its permission. The server still enforces every action.
 */
export type NavItem = {
  label: string;
  permission: Permission;
  scope: "platform" | "account";
  phase: number;
  /** Page for this item once it's built; items without one show their phase instead. */
  href?: (accountId: string) => string;
};

export const NAV: readonly NavItem[] = [
  {
    label: "Domains",
    permission: "domain.read",
    scope: "account",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/domains`,
  },
  { label: "Mailboxes", permission: "mailbox.read", scope: "account", phase: 3 },
  { label: "Aliases", permission: "alias.manage.own", scope: "account", phase: 3 },
  { label: "People and roles", permission: "account.admins.manage", scope: "account", phase: 3 },
  { label: "Billing", permission: "billing.read", scope: "account", phase: 5 },
  { label: "Audit log", permission: "audit.read", scope: "account", phase: 0 },
  { label: "Waitlist", permission: "waitlist.read", scope: "platform", phase: 0 },
  { label: "Customer accounts", permission: "platform.accounts.read", scope: "platform", phase: 3 },
  { label: "Abuse queue", permission: "platform.abuse.manage", scope: "platform", phase: 6 },
  { label: "Platform billing", permission: "platform.billing.manage", scope: "platform", phase: 5 },
  { label: "Platform audit", permission: "platform.audit.read", scope: "platform", phase: 0 },
  { label: "Staff roles", permission: "platform.staff.manage", scope: "platform", phase: 3 },
];

export function visibleNav(actor: Actor, accountId?: string): NavItem[] {
  return NAV.filter((item) => can(actor, item.permission, item.scope === "account" ? accountId : undefined));
}
