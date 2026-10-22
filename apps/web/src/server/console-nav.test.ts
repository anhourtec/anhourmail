// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { UserActor } from "@anhourmail/core";

import { NAV, navTree, SECTIONS, visibleNav } from "./console-nav";

const actor = (platform: UserActor["platformRoles"], account: UserActor["memberships"] = []): UserActor => ({
  kind: "user",
  userId: "u",
  email: "u@x.test",
  platformRoles: platform,
  memberships: account,
  suspended: false,
});

describe("console navigation follows the matrix", () => {
  it("owner sees every account section, a member only aliases and app passwords", () => {
    const owner = visibleNav(actor([], [{ accountId: "a", role: "owner" }]), "a").map((n) => n.label);
    expect(owner).toEqual(NAV.filter((n) => n.scope === "account").map((n) => n.label));
    expect(visibleNav(actor([], [{ accountId: "a", role: "member" }]), "a").map((n) => n.label)).toEqual([
      "Aliases",
      "App passwords",
    ]);
    // The Auditor holds no write permission, so no app passwords of their own.
    expect(visibleNav(actor([], [{ accountId: "a", role: "auditor" }]), "a").map((n) => n.label)).not.toContain(
      "App passwords",
    );
    expect(visibleNav(actor([], [{ accountId: "a", role: "auditor" }]), "a").map((n) => n.label)).toContain(
      "People and roles",
    );
    expect(visibleNav(actor([], [{ accountId: "a", role: "billing_admin" }]), "a").map((n) => n.label)).not.toContain(
      "People and roles",
    );
  });

  it("staff see platform sections for their role only", () => {
    expect(visibleNav(actor(["reports_reader"])).map((n) => n.label)).toEqual(["Platform audit"]);
    expect(visibleNav(actor(["global_admin"])).filter((n) => n.scope === "platform")).toHaveLength(
      NAV.filter((n) => n.scope === "platform").length,
    );
    expect(visibleNav({ kind: "anonymous" })).toEqual([]);
  });

  it("built pages link to their routes", () => {
    const href = (label: string) => NAV.find((n) => n.label === label)?.href?.("acc");
    expect(href("People and roles")).toBe("/accounts/acc/people");
    expect(href("App passwords")).toBe("/accounts/acc/app-passwords");
    expect(href("Audit log")).toBe("/accounts/acc/audit");
    expect(href("Customer accounts")).toBe("/platform/accounts");
    expect(href("Platform audit")).toBe("/platform/audit");
  });
});

describe("left navigation sections", () => {
  const sections = (a: UserActor, accountId?: string) =>
    navTree(a, accountId).map((s) => [s.label, s.items.map((i) => i.label)]);

  it("groups an owner's account pages under Mail and People, then Billing and the audit log", () => {
    expect(sections(actor([], [{ accountId: "a", role: "owner" }]), "a")).toEqual([
      ["Mail", ["Mailboxes", "Aliases", "App passwords", "Domains"]],
      ["People", ["People and roles"]],
      ["Billing", ["Billing"]],
      ["Audit log", ["Audit log"]],
    ]);
  });

  it("leaves out sections with nothing visible: a member gets Mail with Aliases and App passwords only", () => {
    expect(sections(actor([], [{ accountId: "a", role: "member" }]), "a")).toEqual([
      ["Mail", ["Aliases", "App passwords"]],
    ]);
  });

  it("resolves links for the current account and leaves unbuilt pages without one", () => {
    const tree = navTree(actor([], [{ accountId: "a", role: "owner" }]), "a");
    const links = tree.flatMap((s) => s.items);
    expect(links.find((l) => l.label === "Mailboxes")?.href).toBe("/accounts/a/mailboxes");
    expect(links.find((l) => l.label === "Billing")?.href).toBeUndefined();
  });

  it("gives staff a Platform section for their role, and no account sections without an account", () => {
    expect(sections(actor(["reports_reader"]))).toEqual([["Platform", ["Platform audit"]]]);
    const admin = navTree(actor(["global_admin"]));
    expect(admin.map((s) => s.id)).toEqual(["platform"]);
    expect(admin[0]?.items.map((i) => i.href)).toContain("/platform/accounts");
  });

  it("never shows another account's pages: memberships elsewhere grant nothing here", () => {
    expect(navTree(actor([], [{ accountId: "a", role: "owner" }]), "b")).toEqual([]);
    expect(navTree({ kind: "anonymous" }, "a")).toEqual([]);
  });

  it("keeps every section's group flag and order stable", () => {
    expect(SECTIONS.map((s) => [s.id, s.group])).toEqual([
      ["mail", true],
      ["people", true],
      ["billing", false],
      ["audit", false],
      ["platform", true],
    ]);
  });
});
