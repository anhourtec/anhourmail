// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserActor } from "@anhourmail/core";

let actor: UserActor;

vi.mock("./console-frame", () => ({ requireUser: async () => actor }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("404");
  },
  forbidden: () => {
    throw new Error("403");
  },
}));

const { requireAccountMember, requireAccountSection, requirePlatformPermission } = await import("./route-guard");

const person = (over: Partial<UserActor> = {}): UserActor => ({
  kind: "user",
  userId: "u1",
  email: "u1@a.test",
  platformRoles: [],
  memberships: [{ accountId: "A", role: "member" }],
  suspended: false,
  ...over,
});

describe("console route guards", () => {
  beforeEach(() => {
    actor = person();
  });

  it("answers 404 for an account the person isn't in (staff included)", async () => {
    await expect(requireAccountMember("A")).resolves.toBe(actor);
    await expect(requireAccountMember("B")).rejects.toThrow("404");
    actor = person({ platformRoles: ["global_admin"], memberships: [] });
    await expect(requireAccountSection("A", "mailbox.read")).rejects.toThrow("404");
  });

  it("answers 403 for a section the role lacks, and lets the page through otherwise", async () => {
    await expect(requireAccountSection("A", "alias.manage.own")).resolves.toBe(actor);
    await expect(requireAccountSection("A", "member.read")).rejects.toThrow("403");
    await expect(requireAccountSection("A", "audit.read")).rejects.toThrow("403");
  });

  it("lets a suspended account's pages render (the frame shows the suspension instead)", async () => {
    actor = person({ suspendedAccountIds: ["A"] });
    await expect(requireAccountSection("A", "member.read")).resolves.toBe(actor);
  });

  it("answers 404 on staff pages for customers and for staff without the permission", async () => {
    await expect(requirePlatformPermission()).rejects.toThrow("404");
    actor = person({ platformRoles: ["reports_reader"], memberships: [] });
    await expect(requirePlatformPermission()).resolves.toBe(actor);
    await expect(requirePlatformPermission("platform.audit.read")).resolves.toBe(actor);
    await expect(requirePlatformPermission("platform.accounts.read")).rejects.toThrow("404");
  });
});
