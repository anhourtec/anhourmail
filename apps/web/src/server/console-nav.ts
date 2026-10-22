// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, can } from "@anhourmail/core";
import type { Permission } from "@anhourmail/shared/rbac";

/**
 * Console navigation, derived from the permission matrix (CLAUDE.md rule 35): an item shows only when the
 * actor holds its permission. The server still enforces every action. Items are grouped into sections (Mail,
 * People, Billing, Audit log, Platform) for the left navigation; a section with nothing visible is left out.
 */
export type NavIcon =
  | "mail"
  | "shield"
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

export type NavSection = "mail" | "people" | "billing" | "audit" | "platform";

export type NavItem = {
  label: string;
  permission: Permission;
  scope: "platform" | "account";
  section: NavSection;
  phase: number;
  /** Lucide icon name (mapped to the component in components/console-chrome.tsx). */
  icon: NavIcon;
  /** Page for this item once it's built; items without one show as "Soon". */
  href?: (accountId: string) => string;
};

export const NAV: readonly NavItem[] = [
  {
    label: "Mailboxes",
    icon: "inbox",
    permission: "mailbox.read",
    scope: "account",
    section: "mail",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/mailboxes`,
  },
  {
    label: "Aliases",
    icon: "at-sign",
    permission: "alias.manage.own",
    scope: "account",
    section: "mail",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/aliases`,
  },
  {
    label: "Domains",
    icon: "globe",
    permission: "domain.read",
    scope: "account",
    section: "mail",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/domains`,
  },
  {
    label: "People and roles",
    icon: "users",
    permission: "member.read",
    scope: "account",
    section: "people",
    phase: 3,
    href: (accountId) => `/accounts/${accountId}/people`,
  },
  {
    label: "Billing",
    icon: "credit-card",
    permission: "billing.read",
    scope: "account",
    section: "billing",
    phase: 5,
  },
  {
    label: "Audit log",
    icon: "scroll-text",
    permission: "audit.read",
    scope: "account",
    section: "audit",
    phase: 0,
    href: (accountId) => `/accounts/${accountId}/audit`,
  },
  {
    label: "Customer accounts",
    icon: "building",
    permission: "platform.accounts.read",
    scope: "platform",
    section: "platform",
    phase: 3,
    href: () => "/platform/accounts",
  },
  {
    label: "Abuse queue",
    icon: "shield-alert",
    permission: "platform.abuse.manage",
    scope: "platform",
    section: "platform",
    phase: 6,
  },
  {
    label: "Platform billing",
    icon: "receipt",
    permission: "platform.billing.manage",
    scope: "platform",
    section: "platform",
    phase: 5,
  },
  {
    label: "Platform audit",
    icon: "file-clock",
    permission: "platform.audit.read",
    scope: "platform",
    section: "platform",
    phase: 0,
    href: () => "/platform/audit",
  },
  {
    label: "Staff roles",
    icon: "user-cog",
    permission: "platform.staff.manage",
    scope: "platform",
    section: "platform",
    phase: 3,
  },
];

/**
 * Left-navigation sections, in order. `group` sections have a chevron and list their items indented; the others
 * are a single row (their one item).
 */
export const SECTIONS: readonly { id: NavSection; label: string; icon: NavIcon; group: boolean }[] = [
  { id: "mail", label: "Mail", icon: "mail", group: true },
  { id: "people", label: "People", icon: "users", group: true },
  { id: "billing", label: "Billing", icon: "credit-card", group: false },
  { id: "audit", label: "Audit log", icon: "scroll-text", group: false },
  { id: "platform", label: "Platform", icon: "shield", group: true },
];

/** A visible navigation entry, with its link resolved for the current account (none: listed as "Soon"). */
export type NavLink = { label: string; permission: Permission; icon: NavIcon; href?: string };
export type NavTreeSection = { id: NavSection; label: string; icon: NavIcon; group: boolean; items: NavLink[] };

export function visibleNav(actor: Actor, accountId?: string): NavItem[] {
  return NAV.filter((item) => can(actor, item.permission, item.scope === "account" ? accountId : undefined));
}

/**
 * The left navigation for one account (the one in the URL, else the person's first) plus the staff sections the
 * actor's platform roles allow. Sections with no visible item are left out.
 */
export function navTree(actor: Actor, accountId?: string): NavTreeSection[] {
  const items = [
    ...visibleNav(actor).filter((n) => n.scope === "platform"),
    ...(accountId ? visibleNav(actor, accountId).filter((n) => n.scope === "account") : []),
  ];
  return SECTIONS.flatMap((section) => {
    const links = items
      .filter((n) => n.section === section.id)
      .map((n): NavLink => ({
        label: n.label,
        permission: n.permission,
        icon: n.icon,
        ...(n.href ? { href: n.href(accountId ?? "") } : {}),
      }));
    return links.length > 0 ? [{ ...section, items: links }] : [];
  });
}
