// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, type UserActor } from "@anhourmail/core";
import type * as People from "@anhourmail/core/people";

type Options = {
  remaining: number;
  maxQuotaGb: number;
  domains: { id: string; name: string }[];
  platform: { allowed: boolean; emailVerified: boolean };
};
let options: Options | Error;
let limits: { addPeople: boolean; used: number; max: number; planName: string } | Error;

vi.mock("./container", () => ({ container: () => ({ deps: {} }) }));
vi.mock("@anhourmail/core/mailboxes", () => ({
  mailboxOptions: async () => {
    if (options instanceof Error) throw options;
    return options;
  },
}));
vi.mock("@anhourmail/core/people", async (importOriginal) => ({
  ...(await importOriginal<typeof People>()),
  listPeople: async () => {
    if (limits instanceof Error) throw limits;
    return { limits };
  },
}));

const { peopleActions } = await import("./people-actions");

const as = (role: "owner" | "member" | "user_admin"): UserActor => ({
  kind: "user",
  userId: `${role}-1`,
  email: `${role}@a.test`,
  platformRoles: [],
  memberships: [{ accountId: "A", role }],
  suspended: false,
});

describe("peopleActions", () => {
  beforeEach(() => {
    options = { remaining: 5, maxQuotaGb: 20, domains: [], platform: { allowed: true, emailVerified: true } };
    limits = { addPeople: true, used: 1, max: 6, planName: "Supporter" };
  });

  it("offers Add a user on the free platform domain alone, and invites", async () => {
    expect(await peopleActions(as("owner"), "A")).toEqual({ addUser: { state: "ready" }, invite: { state: "ready" } });
  });

  it("reports a full account as full for both", async () => {
    limits = { addPeople: true, used: 6, max: 6, planName: "Plus" };
    const out = await peopleActions(as("owner"), "A");
    expect(out.addUser).toMatchObject({ state: "full", code: "people_full" });
    expect(out.invite).toMatchObject({ state: "full", code: "people_full" });
  });

  it("doesn't offer either on a one-person plan or to a Member", async () => {
    limits = { addPeople: false, used: 1, max: 6, planName: "Free" };
    expect((await peopleActions(as("owner"), "A")).addUser).toMatchObject({ code: "single_person_plan" });
    const member = await peopleActions(as("member"), "A");
    expect(member.addUser).toMatchObject({ state: "unavailable", code: "not_permitted" });
    expect(member.invite).toMatchObject({ state: "unavailable", code: "not_permitted" });
  });

  it("treats a refusal as not offered and lets other errors through", async () => {
    options = new ForbiddenError();
    expect((await peopleActions(as("owner"), "A")).addUser).toMatchObject({ code: "not_permitted" });
    options = new Error("database down");
    await expect(peopleActions(as("owner"), "A")).rejects.toThrow("database down");
  });
});
