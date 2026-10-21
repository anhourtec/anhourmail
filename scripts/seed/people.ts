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

export type AccountKey = "family" | "group" | "free" | "supporter";

export const ACCOUNTS: Record<AccountKey, { name: string; plan: PlanId; domain: string; ownDomain: boolean }> = {
  family: { name: "Demo Family", plan: "plus", domain: "demo-family.test", ownDomain: true },
  group: { name: "Demo Group", plan: "plus", domain: "demo-group.test", ownDomain: true },
  free: { name: "Free user", plan: "free", domain: "anhourmail.test", ownDomain: false },
  supporter: { name: "Supporter", plan: "supporter", domain: "anhourmail.test", ownDomain: false },
};

export const STAFF_DOMAIN = "anhourtec.test";
export const FREE_DOMAIN = "anhourmail.test";
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
    ["support_admin", "support", "Support Admin", "Customer lookup and credential resets; no billing or trust tiers"],
    ["trust_safety_admin", "trust", "Trust & Safety Admin", "Abuse queue and trust tiers"],
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
      tryThis: "Free plan: own account, no custom domains",
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
      tryThis: "Signs in but every action is refused; the console says the account is suspended",
      mailbox: true,
    },
  ];
}

export const INVITED = {
  email: `invited@${ACCOUNTS.family.domain}`,
  account: "family" as const,
  role: "member" as const,
};
