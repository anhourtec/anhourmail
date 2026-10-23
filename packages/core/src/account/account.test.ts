// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { deps, req } from "../__tests__/helpers";
import { personalAccountName, provisionSignUp } from "./service";

const system = { kind: "system", name: "sign-up" } as const;

describe("provisionSignUp", () => {
  it("creates a Free personal account with the person as Owner, and audits it", async () => {
    const d = deps();
    const out = await provisionSignUp(d, system, { userId: "u1", email: "sam@example.com", name: "Sam" }, req);
    expect(out.accountId).toBeTruthy();
    expect(d.uow.state.accounts).toEqual([
      { id: out.accountId, name: "Sam", plan: "free", createdAt: expect.any(Date) as Date },
    ]);
    expect(d.uow.state.memberships).toEqual([
      { accountId: out.accountId, userId: "u1", role: "owner", joinedAt: expect.any(Date) as Date },
    ]);
    expect(d.uow.state.userStates.u1).toBe("free");
    const [entry] = d.uow.state.audit;
    expect(entry).toMatchObject({ action: "account.created", result: "success", target: { label: "Sam" } });
    expect(JSON.stringify(entry)).not.toContain("sam@example.com");
  });

  it("is idempotent for a user who already has an account", async () => {
    const d = deps();
    await provisionSignUp(d, system, { userId: "u1", email: "sam@example.com", name: "Sam" }, req);
    const again = await provisionSignUp(d, system, { userId: "u1", email: "sam@example.com", name: "Sam" }, req);
    expect(again.accountId).toBeNull();
    expect(d.uow.state.accounts).toHaveLength(1);
  });

  it("names the account from the email when the name is blank", () => {
    expect(personalAccountName("  ", "river@example.com")).toBe("river");
    expect(personalAccountName("x".repeat(100), "a@b.c")).toHaveLength(80);
    // Account names follow the shared name rules: anything else becomes "My account".
    expect(personalAccountName("Visit evil.example", "river@example.com")).toBe("My account");
    expect(personalAccountName("Kim\u202e", "river@example.com")).toBe("My account");
    expect(personalAccountName("", "jane.doe@example.com")).toBe("My account");
    expect(personalAccountName("", "@example.com")).toBe("My account");
  });
});
