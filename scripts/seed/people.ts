// SPDX-License-Identifier: AGPL-3.0-only
/** The demo world, as data. One place to add a role or account state (CLAUDE.md rule 50). */
import type { AccountRole, PlanId, PlatformRole, UserState } from "@anhourmail/shared";

export type SeedPerson = {
  email: string;
  name: string;
  state: UserState;
  suspended?: boolean;
  platformRole?: PlatformRole;
  account?: { key: AccountKey; role: AccountRole };
  /** What to try when signed in as this person (credentials.md). */
  tryThis: string;
  /** Create a Stalwart mailbox with the same address. */
  mailbox: boolean;
};

export type AccountKey = "family" | "group" | "free" | "supporter" | "suspended" | "restricted" | "mailboxRestricted";

export const ACCOUNTS: Record<AccountKey, { name: string; plan: PlanId; domain: string; ownDomain: boolean }> = {
  family: { name: "Demo Family", plan: "plus", domain: "demo-family.test", ownDomain: true },
  group: { name: "Demo Group", plan: "plus", domain: "demo-group.test", ownDomain: true },
  free: { name: "Free user", plan: "free", domain: "anhourmail.test", ownDomain: false },
  supporter: { name: "Supporter", plan: "supporter", domain: "anhourmail.test", ownDomain: false },
  suspended: { name: "Suspended account", plan: "plus", domain: "anhourmail.test", ownDomain: false },
  restricted: { name: "Restricted sending", plan: "free", domain: "anhourmail.test", ownDomain: false },
  mailboxRestricted: { name: "Restricted mailbox", plan: "free", domain: "anhourmail.test", ownDomain: false },
};

/** The account staff suspended (no mailbox, so nothing changes on the mail server): reason and staff-only note. */
export const SUSPENDED_ACCOUNT = {
  key: "suspended" as const,
  reason: "payment" as const,
  note: "Demo: chargeback on the last invoice (internal note, staff only)",
};

export const STAFF_DOMAIN = "anhourtec.test";
export const FREE_DOMAIN = "anhourmail.test";

/**
 * The demo world's trust tiers (ADR-0034 build slice 20), set on every seed run so they reset to this: one account per
 * tier state. `new` is staff-set so the hourly promotion job leaves it at New (a default New account older than the
 * dev threshold would be promoted). Notes are staff-only.
 */
export const TRUST_DEMO: Record<
  AccountKey,
  { tier: "new" | "standard" | "restricted"; source: "staff" | "automatic"; reason?: "spam"; note?: string } | null
> = {
  family: { tier: "standard", source: "automatic" },
  group: { tier: "standard", source: "automatic" },
  supporter: { tier: "standard", source: "automatic" },
  free: { tier: "new", source: "staff", note: "Demo: kept at New so the new-account hold can be tried (staff only)" },
  restricted: {
    tier: "restricted",
    source: "staff",
    reason: "spam",
    note: "Demo: complaint spike on the last campaign (internal note, staff only)",
  },
  mailboxRestricted: { tier: "standard", source: "automatic" },
  suspended: null,
};

/** The one mailbox staff restricted on its own (ADR-0034 §6), in an account that stays at Standard. */
export const RESTRICTED_MAILBOX = {
  account: "mailboxRestricted" as const,
  address: `mailbox-restricted@${FREE_DOMAIN}`,
  reason: "abuse" as const,
  note: "Demo: reported for abuse (internal note, staff only)",
};

/** Shown in the console with its DNS records but never verified (not in Stalwart). */
export const UNVERIFIED_DOMAIN = { account: "family" as const, name: "unverified-family.test" };

const ROLE_HINTS: Record<AccountRole, string> = {
  owner: "Sees everything in the account, incl. the audit log and people/billing sections",
  domain_admin: "Sees Domains and Mailboxes; no audit log, no billing",
  user_admin: "Sees Mailboxes, Aliases and the audit log; no billing",
  billing_admin: "Sees Billing only",
  member: "Sees only own aliases; no admin sections",
  auditor: "Read-only: domains, mailboxes, billing, audit log; can change nothing",
};

function accountPeople(key: "family" | "group"): SeedPerson[] {
  const d = ACCOUNTS[key].domain;
  const roles: [AccountRole, string, string][] = [
    ["owner", "owner", "Owner"],
    ["domain_admin", "domains", "Domain Admin"],
    ["user_admin", "users", "User Admin"],
    ["billing_admin", "billing", "Billing Admin"],
    ["member", "member", "Member"],
    ["auditor", "auditor", "Auditor"],
  ];
  return roles.map(([role, local, label]) => ({
    email: `${local}@${d}`,
    name: `${ACCOUNTS[key].name} ${label}`,
    state: "paid",
    account: { key, role },
    tryThis: ROLE_HINTS[role],
    mailbox: true,
  }));
}

export function demoPeople(platformAdminEmail: string): SeedPerson[] {
  const staff: [PlatformRole, string, string, string][] = [
    [
      "support_admin",
      "support",
      "Support Admin",
      "Customer lookup, credential resets, read-only support access (Platform → account → Open with support access)",
    ],
    [
      "trust_safety_admin",
      "trust",
      "Trust & Safety Admin",
      "Abuse queue and trust tiers: Platform → Customer accounts → Restricted sending / Restricted mailbox / Free user (Trust card, Change tier, mailbox Restrict sending; step-up)",
    ],
    ["billing_admin", "billing", "Billing Admin (staff)", "Platform billing only"],
    ["reports_reader", "reports", "Reports Reader", "Platform audit log; read-only"],
  ];
  return [
    {
      email: platformAdminEmail,
      name: "Platform Admin",
      state: "paid",
      platformRole: "global_admin",
      tryThis: "Every staff section and the platform audit log",
      mailbox: true,
    },
    ...staff.map(([role, local, name, tryThis]) => ({
      email: `${local}@${STAFF_DOMAIN}`,
      name,
      state: "paid" as const,
      platformRole: role,
      tryThis,
      mailbox: true,
    })),
    ...accountPeople("family"),
    ...accountPeople("group"),
    {
      email: `free@${FREE_DOMAIN}`,
      name: "Free User",
      state: "free",
      account: { key: "free", role: "owner" },
      tryThis:
        "Free plan: own account, no custom domains. Trust tier New: sends to AnhourMail addresses only, no SMTP from mail apps, automatic replies paused",
      mailbox: true,
    },
    {
      email: `supporter@${FREE_DOMAIN}`,
      name: "Supporter",
      state: "paid",
      account: { key: "supporter", role: "owner" },
      tryThis: "Supporter plan owner",
      mailbox: true,
    },
    {
      email: `suspended@${ACCOUNTS.group.domain}`,
      name: "Suspended Member",
      state: "suspended",
      suspended: true,
      account: { key: "group", role: "member" },
      tryThis: "Can't sign in: the console and the webmail refuse it with the suspension notice and the appeal address",
      mailbox: true,
    },
    {
      email: `restricted-owner@${FREE_DOMAIN}`,
      name: "Restricted Sending Owner",
      state: "free",
      account: { key: "restricted", role: "owner" },
      tryThis:
        "Trust tier Restricted (staff, reason Sending spam): the Sending card says sending is paused with the appeal address; the webmail refuses every send, forwarding and automatic replies",
      mailbox: true,
    },
    {
      email: `mailbox-restricted@${FREE_DOMAIN}`,
      name: "Restricted Mailbox Owner",
      state: "free",
      account: { key: "mailboxRestricted", role: "owner" },
      tryThis:
        "Account at Standard, but staff restricted this one mailbox's sending (reason Abuse): the webmail's Settings → Account shows it paused; Platform → the account → Mailboxes shows Restricted",
      mailbox: true,
    },
    {
      email: `suspended-owner@${FREE_DOMAIN}`,
      name: "Suspended Account Owner",
      state: "paid",
      account: { key: SUSPENDED_ACCOUNT.key, role: "owner" },
      tryThis:
        "Owner of an account staff suspended: signs in to the suspension notice (403 account_suspended on account pages; own profile and Security work). Staff: Platform → account shows it (the internal note to Global and Support Administrators only)",
      mailbox: false,
    },
  ];
}

export const INVITED = {
  email: `invited@${ACCOUNTS.family.domain}`,
  account: "family" as const,
  role: "member" as const,
};
