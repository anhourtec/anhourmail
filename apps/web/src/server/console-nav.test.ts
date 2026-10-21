// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { UserActor } from "@anhourmail/core";

import { NAV, visibleNav } from "./console-nav";

const actor = (platform: UserActor["platformRoles"], account: UserActor["memberships"] = []): UserActor => ({
  kind: "user",
  userId: "u",
  email: "u@x.test",
  platformRoles: platform,
  memberships: account,
  suspended: false,
});

describe("console navigation follows the matrix", () => {
  it("owner sees every account section, member only aliases", () => {
    const owner = visibleNav(actor([], [{ accountId: "a", role: "owner" }]), "a").map((n) => n.label);
    expect(owner).toEqual(NAV.filter((n) => n.scope === "account").map((n) => n.label));
    expect(visibleNav(actor([], [{ accountId: "a", role: "member" }]), "a").map((n) => n.label)).toEqual(["Aliases"]);
  });

  it("staff see platform sections for their role only", () => {
    expect(visibleNav(actor(["reports_reader"])).map((n) => n.label)).toEqual(["Platform audit"]);
    expect(visibleNav(actor(["global_admin"])).filter((n) => n.scope === "platform")).toHaveLength(
      NAV.filter((n) => n.scope === "platform").length,
    );
    expect(visibleNav({ kind: "anonymous" })).toEqual([]);
  });
});
