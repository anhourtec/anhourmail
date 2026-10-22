// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, can } from "@anhourmail/core";
import type { Permission } from "@anhourmail/shared/rbac";

/**
 * Console navigation, derived from the permission matrix (CLAUDE.md rule 35): an item shows only when the
 * actor holds its permission. The server still enforces every action.
 */
export type NavIcon =
  | "globe"
  | "inbox"
  | "at-sign"
  | "users"
  | "credit-card"
  | "scroll-text"
  | "building"
  | "shield-alert"
  | "receipt"
  | "file-clock"
  | "user-cog";

export type NavItem = {
  label: string;
  permission: Permission;
  scope: "platform" | "account";
  phase: number;
  /** Lucide icon name (mapped to the component in components/console-chrome.tsx). */
  icon: NavIcon;
  /** Page for this item once it's built; items without one show as "Soon". */
  href?: (accountId: string) => string;
};

export const NAV: readonly NavItem[] = [
  {
    label: "Domains",
    icon: "globe",
    permission: "domain.read",
    scope: "account",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/domains`,
  },
  {
    label: "Mailboxes",
    icon: "inbox",
    permission: "mailbox.read",
    scope: "account",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/mailboxes`,
  },
  {
    label: "Aliases",
    icon: "at-sign",
    permission: "alias.manage.own",
    scope: "account",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/aliases`,
  },
  { label: "People and roles", icon: "users", permission: "account.admins.manage", scope: "account", phase: 3 },
  { label: "Billing", icon: "credit-card", permission: "billing.read", scope: "account", phase: 5 },
  {
    label: "Audit log",
    icon: "scroll-text",
    permission: "audit.read",
    scope: "account",
    phase: 0,
    href: (accountId) => `/#activity-${accountId}`,
  },
  { label: "Customer accounts", icon: "building", permission: "platform.accounts.read", scope: "platform", phase: 3 },
  { label: "Abuse queue", icon: "shield-alert", permission: "platform.abuse.manage", scope: "platform", phase: 6 },
  { label: "Platform billing", icon: "receipt", permission: "platform.billing.manage", scope: "platform", phase: 5 },
  {
    label: "Platform audit",
    icon: "file-clock",
    permission: "platform.audit.read",
    scope: "platform",
    phase: 0,
    href: () => "/#platform-activity",
  },
  { label: "Staff roles", icon: "user-cog", permission: "platform.staff.manage", scope: "platform", phase: 3 },
];

export function visibleNav(actor: Actor, accountId?: string): NavItem[] {
  return NAV.filter((item) => can(actor, item.permission, item.scope === "account" ? accountId : undefined));
}
