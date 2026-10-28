// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps, fixedClock, req, user } from "../__tests__/helpers";
import type { Actor } from "../actor";
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "../errors";
import {
  changedFields,
  getOwnProfile,
  getPersonProfile,
  OTHER_ACCOUNT_PROFILE,
  ROLE_PROFILE,
  updateOwnProfile,
  updatePersonProfile,
} from "./profile-service";

/**
 * Account A with an Owner, a User Admin, a second User Admin, an Auditor and two Members (`solo` only there, `kid` also
 * in B); B with its Owner.
 */
function world() {
  const d = deps(fixedClock("2026-10-28T12:00:00Z"));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  const people: [string, "owner" | "user_admin" | "auditor" | "member", string][] = [
    ["owner", "owner", ACCOUNT_A],
    ["admin", "user_admin", ACCOUNT_A],
    ["admin2", "user_admin", ACCOUNT_A],
    ["auditor", "auditor", ACCOUNT_A],
    ["kid", "member", ACCOUNT_A],
    ["solo", "member", ACCOUNT_A],
    ["kid", "member", ACCOUNT_B],
    ["owner-b", "owner", ACCOUNT_B],
  ];
  for (const [id, role, accountId] of people) {
    s.userEmails[id] = `${id}@a.test`;
    s.memberships.push({ userId: id, accountId, role });
  }
  s.profiles.kid = { jobTitle: "Student", city: "Halifax" };
  s.profiles.solo = { jobTitle: "Student", city: "Halifax" };
  const as = (id: string): Actor => {
    const u = user({
      id,
      account: s.memberships
        .filter((m) => m.userId === id)
        .map((m) => [m.accountId, m.role] as [string, typeof m.role]),
    });
    return { ...u, email: s.userEmails[id] ?? u.email };
  };
  return { d, s, as };
}

describe("changedFields", () => {
  it("lists added, changed and removed fields in the shared order", () => {
    expect(changedFields({ city: "A", jobTitle: "X" }, { jobTitle: "Y", country: "CA" })).toEqual([
      "jobTitle",
      "city",
      "country",
    ]);
    expect(changedFields({ city: "A" }, { city: "A" })).toEqual([]);
  });
});

describe("updatePersonProfile", () => {
  it("lets an admin edit a Member's details; the audit names the changed fields, never values", async () => {
    const { d, s, as } = world();
    const out = await updatePersonProfile(
      d,
      as("admin"),
      ACCOUNT_A,
      "solo",
      { profile: { jobTitle: "Intern", city: "Halifax", mobilePhone: "+1 902 555 0100" } },
      req,
    );
    expect(out.changed).toEqual(["jobTitle", "mobilePhone"]);
    expect(s.profiles.solo).toEqual({ jobTitle: "Intern", city: "Halifax", mobilePhone: "+1 902 555 0100" });
    const entry = s.audit.at(-1);
    expect(entry).toMatchObject({
      action: "account.profile_changed",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      target: { type: "person", id: "solo", label: "solo@a.test" },
      meta: { fields: ["jobTitle", "mobilePhone"], self: false },
    });
    expect(JSON.stringify(s.audit)).not.toMatch(/Intern|555/);
  });

  it("clears fields left empty and writes nothing when nothing changed", async () => {
    const { d, s, as } = world();
    const out = await updatePersonProfile(d, as("owner"), ACCOUNT_A, "solo", { profile: { city: "" } }, req);
    expect(out.changed).toEqual(["jobTitle", "city"]);
    expect(s.profiles.solo).toEqual({});
    const again = await updatePersonProfile(d, as("owner"), ACCOUNT_A, "solo", { profile: {} }, req);
    expect(again.changed).toEqual([]);
    expect(s.audit.at(-1)).toMatchObject({ result: "success", meta: { fields: [] } });
  });

  it("an admin's profile needs an Owner (403, audited as denied); a person may always edit their own", async () => {
    const { d, s, as } = world();
    await expect(
      updatePersonProfile(d, as("admin"), ACCOUNT_A, "admin2", { profile: { jobTitle: "Boss" } }, req),
    ).rejects.toThrow(ForbiddenError);
    expect(s.audit.at(-1)).toMatchObject({ action: "account.profile_changed", result: "denied" });
    expect(s.profiles.admin2).toBeUndefined();
    await updatePersonProfile(d, as("owner"), ACCOUNT_A, "admin2", { profile: { jobTitle: "Boss" } }, req);
    expect(s.profiles.admin2).toEqual({ jobTitle: "Boss" });
    // Own details, whatever the role: an Auditor and a Member too.
    await updatePersonProfile(d, as("admin"), ACCOUNT_A, "admin", { profile: { office: "HQ" } }, req);
    await updatePersonProfile(d, as("auditor"), ACCOUNT_A, "auditor", { profile: { office: "Home" } }, req);
    const own = await updatePersonProfile(d, as("kid"), ACCOUNT_A, "kid", { profile: { city: "Truro" } }, req);
    expect(own.changed).toEqual(["jobTitle", "city"]);
    expect(s.audit.at(-1)).toMatchObject({ meta: { self: true } });
  });

  it("someone who also belongs to another account: only they edit their details (403 for admins, audited)", async () => {
    const { d, s, as } = world();
    for (const admin of ["admin", "owner", "owner-b"]) {
      const accountId = admin === "owner-b" ? ACCOUNT_B : ACCOUNT_A;
      await expect(
        updatePersonProfile(d, as(admin), accountId, "kid", { profile: { jobTitle: "Intern" } }, req),
      ).rejects.toThrow(OTHER_ACCOUNT_PROFILE);
      expect(s.audit.at(-1)).toMatchObject({
        action: "account.profile_changed",
        result: "denied",
        errorCode: "other_account",
        scope: `account:${accountId}`,
        target: { id: "kid" },
      });
    }
    expect(s.profiles.kid).toEqual({ jobTitle: "Student", city: "Halifax" });
    // Once they belong to this account only, its admins may edit them again.
    s.memberships = s.memberships.filter((m) => !(m.userId === "kid" && m.accountId === ACCOUNT_B));
    await updatePersonProfile(d, as("admin"), ACCOUNT_A, "kid", { profile: { jobTitle: "Intern" } }, req);
    expect(s.profiles.kid).toEqual({ jobTitle: "Intern" });
  });

  it("403 without member.manage, 404 for another account or someone outside it, 401 signed out", async () => {
    const { d, as } = world();
    const edit = (actor: Actor, accountId: string, userId: string) =>
      updatePersonProfile(d, actor, accountId, userId, { profile: { city: "X" } }, req);
    await expect(edit(as("auditor"), ACCOUNT_A, "kid")).rejects.toThrow(ForbiddenError);
    await expect(edit(as("kid"), ACCOUNT_A, "admin")).rejects.toThrow(ForbiddenError);
    await expect(edit(as("owner-b"), ACCOUNT_A, "kid")).rejects.toThrow(NotFoundError);
    await expect(edit(as("owner"), ACCOUNT_A, "owner-b")).rejects.toThrow(NotFoundError);
    await expect(edit(as("owner"), ACCOUNT_A, "x".repeat(300))).rejects.toThrow(NotFoundError);
    // Your own id through an account you're not in is still a 404.
    await expect(edit(as("owner"), ACCOUNT_B, "owner")).rejects.toThrow(NotFoundError);
    await expect(edit(anonymous, ACCOUNT_A, "kid")).rejects.toThrow(UnauthenticatedError);
  });

  it("checks the values", async () => {
    const { d, as } = world();
    const edit = (profile: unknown) => updatePersonProfile(d, as("owner"), ACCOUNT_A, "solo", { profile }, req);
    await expect(edit({ country: "Nowhere" })).rejects.toThrow(ValidationError);
    await expect(edit({ officePhone: "call me" })).rejects.toThrow(ValidationError);
    await expect(edit({ jobTitle: "see example.com" })).rejects.toThrow(ValidationError);
    await expect(edit(["x"])).rejects.toThrow(ValidationError);
  });
});

describe("getPersonProfile / own profile", () => {
  it("reads with member.read and says who may edit", async () => {
    const { d, as } = world();
    expect(await getPersonProfile(d, as("admin"), ACCOUNT_A, "solo")).toEqual({
      details: { jobTitle: "Student", city: "Halifax" },
      canEdit: true,
    });
    // Someone who also belongs to another account edits their details themself: the admin sees them, and why.
    expect(await getPersonProfile(d, as("owner"), ACCOUNT_A, "kid")).toEqual({
      details: { jobTitle: "Student", city: "Halifax" },
      canEdit: false,
      readOnlyReason: OTHER_ACCOUNT_PROFILE,
    });
    expect(await getPersonProfile(d, as("admin"), ACCOUNT_A, "admin2")).toEqual({
      details: {},
      canEdit: false,
      readOnlyReason: ROLE_PROFILE,
    });
    // A role that doesn't manage people reads them without a reason to edit.
    expect(await getPersonProfile(d, as("auditor"), ACCOUNT_A, "kid")).toEqual({
      details: { jobTitle: "Student", city: "Halifax" },
      canEdit: false,
    });
    expect((await getPersonProfile(d, as("auditor"), ACCOUNT_A, "auditor")).canEdit).toBe(true);
    await expect(getPersonProfile(d, as("kid"), ACCOUNT_A, "kid")).rejects.toThrow(ForbiddenError);
    await expect(getPersonProfile(d, as("owner-b"), ACCOUNT_A, "kid")).rejects.toThrow(NotFoundError);
    await expect(getPersonProfile(d, as("owner"), ACCOUNT_A, "owner-b")).rejects.toThrow(NotFoundError);
  });

  it("the person edits their own; each of their accounts' logs records which fields changed", async () => {
    const { d, s, as } = world();
    expect(await getOwnProfile(d, as("kid"))).toEqual({
      details: { jobTitle: "Student", city: "Halifax" },
      canEdit: true,
    });
    const out = await updateOwnProfile(d, as("kid"), { profile: { jobTitle: "Student", country: "CA" } }, req);
    expect(out.changed).toEqual(["city", "country"]);
    expect(s.profiles.kid).toEqual({ jobTitle: "Student", country: "CA" });
    const entries = s.audit.filter((e) => e.action === "account.profile_changed");
    expect(entries.map((e) => e.scope).sort()).toEqual([`account:${ACCOUNT_A}`, `account:${ACCOUNT_B}`].sort());
    for (const e of entries) expect(e.meta).toEqual({ fields: ["city", "country"], self: true });
    // Someone in no account: the platform log.
    s.userEmails.lone = "lone@a.test";
    await updateOwnProfile(d, user({ id: "lone", account: [] }), { profile: { city: "Truro" } }, req);
    expect(s.audit.at(-1)).toMatchObject({ scope: "platform", meta: { fields: ["city"] } });
    await expect(updateOwnProfile(d, anonymous, { profile: {} }, req)).rejects.toThrow(UnauthenticatedError);
    await expect(getOwnProfile(d, anonymous)).rejects.toThrow(UnauthenticatedError);
  });
});
