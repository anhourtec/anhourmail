// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_GRANTS,
  ACCOUNT_ROLE_SUMMARIES,
  ACCOUNT_ROLES,
  ACT_AS_ACCOUNT_ROLE,
  ACT_AS_ROLES,
  ALL_PERMISSIONS,
  accountRoleCan,
  isCritical,
  NON_DELEGABLE_ROLES,
  type Permission,
  PERMISSIONS,
  PLATFORM_GRANTS,
  PLATFORM_ROLES,
  platformRoleCan,
  ROLE_LABELS,
} from ".";

describe("permission matrix invariants", () => {
  it("every role has a label", () => {
    for (const r of PLATFORM_ROLES) expect(ROLE_LABELS[`platform:${r}`]).toBeTruthy();
    for (const r of ACCOUNT_ROLES) expect(ROLE_LABELS[`account:${r}`]).toBeTruthy();
    for (const r of ACCOUNT_ROLES) expect(ACCOUNT_ROLE_SUMMARIES[r]).toMatch(/^[A-Z]/);
  });

  it("grants only use permissions of the right scope", () => {
    for (const r of PLATFORM_ROLES) for (const p of PLATFORM_GRANTS[r]) expect(PERMISSIONS[p].scope).toBe("platform");
    for (const r of ACCOUNT_ROLES) for (const p of ACCOUNT_GRANTS[r]) expect(PERMISSIONS[p].scope).toBe("account");
  });

  it("Members and Read-only never hold a critical permission", () => {
    for (const r of NON_DELEGABLE_ROLES) for (const p of ACCOUNT_GRANTS[r]) expect(isCritical(p)).toBe(false);
  });

  it("Read-only (Auditor) holds no write permission", () => {
    for (const p of ACCOUNT_GRANTS.auditor) expect(p).toMatch(/\.read$/);
  });

  it("Owner holds every account permission; Global Admin every platform permission", () => {
    const accountPerms = ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].scope === "account");
    const platformPerms = ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].scope === "platform");
    for (const p of accountPerms) expect(accountRoleCan("owner", p)).toBe(true);
    for (const p of platformPerms) expect(platformRoleCan("global_admin", p)).toBe(true);
  });

  it("act-as is Global/Support Admin only, and matches the matrix", () => {
    expect([...ACT_AS_ROLES].sort()).toEqual(["global_admin", "support_admin"]);
    const holders = PLATFORM_ROLES.filter((r) => platformRoleCan(r, "platform.accounts.actAs")).sort();
    expect(holders).toEqual([...ACT_AS_ROLES].sort());
  });

  it("webmail handoff: every account role but Auditor (so never while acting as), and no staff role", () => {
    const holders = ACCOUNT_ROLES.filter((r) => accountRoleCan(r, "webmail.open.own")).sort();
    expect(holders).toEqual(["billing_admin", "domain_admin", "member", "owner", "user_admin"]);
    expect(accountRoleCan(ACT_AS_ACCOUNT_ROLE, "webmail.open.own")).toBe(false);
    for (const r of PLATFORM_ROLES) expect(platformRoleCan(r, "webmail.open.own")).toBe(false);
    expect(isCritical("webmail.open.own")).toBe(false);
  });

  it("act-as grants a read-only role: no critical permission, nothing that manages, sends or changes", () => {
    expect(NON_DELEGABLE_ROLES).toContain(ACT_AS_ACCOUNT_ROLE);
    const granted = ACCOUNT_GRANTS[ACT_AS_ACCOUNT_ROLE];
    for (const p of granted) {
      expect(isCritical(p)).toBe(false);
      expect(p.endsWith(".read")).toBe(true);
    }
    for (const owners of ["account.delete", "billing.manage", "account.admins.manage", "member.credentials.reset"]) {
      expect(accountRoleCan(ACT_AS_ACCOUNT_ROLE, owners as Permission)).toBe(false);
    }
  });

  it("people: Owner and User Admin invite and remove Members; Members and Billing Admins don't see people", () => {
    const manage = ACCOUNT_ROLES.filter((r) => accountRoleCan(r, "member.manage"));
    expect(manage.sort()).toEqual(["owner", "user_admin"]);
    const read = ACCOUNT_ROLES.filter((r) => accountRoleCan(r, "member.read"));
    expect(read.sort()).toEqual(["auditor", "domain_admin", "owner", "user_admin"]);
    for (const r of manage) expect(accountRoleCan(r, "member.read")).toBe(true);
  });

  it("only Owner can manage admins or delete the account", () => {
    for (const r of ACCOUNT_ROLES) {
      expect(accountRoleCan(r, "account.admins.manage")).toBe(r === "owner");
      expect(accountRoleCan(r, "account.delete")).toBe(r === "owner");
    }
  });

  it("only Owner can reach other people's mail: full-access delegation and forwarding any mailbox", () => {
    for (const r of ACCOUNT_ROLES) {
      expect(accountRoleCan(r, "delegation.manage.any")).toBe(r === "owner");
      expect(accountRoleCan(r, "forwarding.manage.any")).toBe(r === "owner");
    }
    expect(isCritical("delegation.manage.any")).toBe(true);
    expect(isCritical("forwarding.manage.any")).toBe(true);
  });

  it("everyone who can write manages their own delegation and forwarding; the Auditor cannot", () => {
    for (const r of ACCOUNT_ROLES) {
      expect(accountRoleCan(r, "delegation.manage.own")).toBe(r !== "auditor");
      expect(accountRoleCan(r, "forwarding.manage.own")).toBe(r !== "auditor");
    }
  });

  it("no role is granted the same permission twice", () => {
    for (const r of PLATFORM_ROLES) expect(new Set(PLATFORM_GRANTS[r]).size).toBe(PLATFORM_GRANTS[r].length);
    for (const r of ACCOUNT_ROLES) expect(new Set(ACCOUNT_GRANTS[r]).size).toBe(ACCOUNT_GRANTS[r].length);
  });

  it("only Owner can set the outbound disclaimer; every non-auditor role manages own folders and signatures", () => {
    for (const r of ACCOUNT_ROLES) {
      expect(accountRoleCan(r, "disclaimer.manage")).toBe(r === "owner");
      expect(accountRoleCan(r, "folder.manage.own")).toBe(r !== "auditor");
      expect(accountRoleCan(r, "signature.manage.own")).toBe(r !== "auditor");
    }
    expect(isCritical("disclaimer.manage")).toBe(true);
    expect(accountRoleCan("member", "signature_template.manage")).toBe(false);
  });

  it("only Owner can send bulk campaigns (critical); lists are Owner/User Admin; auditors read", () => {
    for (const r of ACCOUNT_ROLES) {
      expect(accountRoleCan(r, "bulk.campaign.send")).toBe(r === "owner");
      expect(accountRoleCan(r, "bulk.list.manage")).toBe(r === "owner" || r === "user_admin");
    }
    expect(isCritical("bulk.campaign.send")).toBe(true);
    expect(accountRoleCan("auditor", "bulk.read")).toBe(true);
  });

  it("every role but the Auditor manages app passwords for their own mailboxes; revoking others' takes mailbox.manage", () => {
    for (const r of ACCOUNT_ROLES) expect(accountRoleCan(r, "app_password.manage.own")).toBe(r !== "auditor");
    expect(isCritical("app_password.manage.own")).toBe(false);
    const revokeOthers = ACCOUNT_ROLES.filter((r) => accountRoleCan(r, "mailbox.manage"));
    for (const r of revokeOthers) expect(accountRoleCan(r, "app_password.manage.own")).toBe(true);
  });

  it("setting a mailbox password is Owner and User Admin only, critical, and implies managing mailboxes", () => {
    const holders = ACCOUNT_ROLES.filter((r) => accountRoleCan(r, "mailbox.password.reset"));
    expect([...holders].sort()).toEqual(["owner", "user_admin"]);
    expect(holders.every((r) => accountRoleCan(r, "mailbox.manage"))).toBe(true);
    expect(isCritical("mailbox.password.reset")).toBe(true);
  });

  it("only Owners can require two-factor sign-in or a passkey for the account (critical)", () => {
    for (const r of ACCOUNT_ROLES) expect(accountRoleCan(r, "account.security.manage")).toBe(r === "owner");
    expect(isCritical("account.security.manage")).toBe(true);
  });

  it("creating a platform-domain address in any account is the Global Administrator's only (critical)", () => {
    const holders = PLATFORM_ROLES.filter((r) => platformRoleCan(r, "platform.mailbox.create"));
    expect(holders).toEqual(["global_admin"]);
    expect(isCritical("platform.mailbox.create")).toBe(true);
  });

  it("suspending accounts and people is the Global Administrator's only (critical)", () => {
    expect(PLATFORM_ROLES.filter((r) => platformRoleCan(r, "platform.account.suspend"))).toEqual(["global_admin"]);
    expect(isCritical("platform.account.suspend")).toBe(true);
  });

  it("full IPs in the platform audit are the Global Administrator's only (critical)", () => {
    expect(PLATFORM_ROLES.filter((r) => platformRoleCan(r, "platform.audit.full_ip"))).toEqual(["global_admin"]);
    expect(platformRoleCan("reports_reader", "platform.audit.read")).toBe(true);
    expect(isCritical("platform.audit.full_ip")).toBe(true);
  });
});
