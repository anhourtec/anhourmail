// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps, req, user } from "../__tests__/helpers";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "../errors";
import { ACCOUNTS_PAGE_SIZE, normalisePage, normaliseQuery, searchAccounts, viewAccount } from "./service";

function world() {
  const d = deps();
  const s = d.uow.state;
  s.accounts.push(
    { id: ACCOUNT_A, name: "Family A", plan: "plus", createdAt: new Date("2026-10-02T00:00:00Z") },
    { id: ACCOUNT_B, name: "Family B", plan: "free", createdAt: new Date("2026-10-01T00:00:00Z") },
  );
  s.userEmails.kid = "kid@a.test";
  s.memberships.push({ userId: "kid", accountId: ACCOUNT_A, role: "owner", joinedAt: new Date() });
  s.domains.push({
    id: "33333333-3333-4333-8333-333333333333",
    accountId: ACCOUNT_A,
    name: "a.test",
    status: "active",
    verifyToken: "t",
    stalwartId: null,
    lastError: null,
    createdAt: new Date(),
  });
  s.mailboxes.push({
    id: "44444444-4444-4444-8444-444444444444",
    accountId: ACCOUNT_A,
    userId: "kid",
    address: "kid@a.test",
    status: "active",
    quotaBytes: 5,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(),
  });
  return { d, s };
}

const support = user({ id: "staff-1", platform: ["support_admin"] });

describe("searchAccounts", () => {
  it("lists newest first with counts, and searches by name, id or a member's email", async () => {
    const { d } = world();
    const all = await searchAccounts(d, support);
    expect(all).toMatchObject({ total: 2, page: 1, pages: 1, query: "" });
    expect(all.rows.map((r) => [r.name, r.members, r.mailboxes, r.domains])).toEqual([
      ["Family A", 1, 1, 1],
      ["Family B", 0, 0, 0],
    ]);
    expect((await searchAccounts(d, support, { query: " family b " })).rows.map((r) => r.id)).toEqual([ACCOUNT_B]);
    expect((await searchAccounts(d, support, { query: "KID@" })).rows.map((r) => r.id)).toEqual([ACCOUNT_A]);
    expect((await searchAccounts(d, support, { query: ACCOUNT_B })).rows.map((r) => r.id)).toEqual([ACCOUNT_B]);
    expect((await searchAccounts(d, support, { page: 2 })).rows).toEqual([]);
  });

  it("is for staff with platform.accounts.read only", async () => {
    const { d } = world();
    for (const role of ["global_admin", "trust_safety_admin", "billing_admin"] as const) {
      await expect(searchAccounts(d, user({ platform: [role] }))).resolves.toMatchObject({ total: 2 });
    }
    await expect(searchAccounts(d, user({ platform: ["reports_reader"] }))).rejects.toThrow(ForbiddenError);
    await expect(searchAccounts(d, user({ account: [[ACCOUNT_A, "owner"]] }))).rejects.toThrow(ForbiddenError);
    await expect(searchAccounts(d, { kind: "anonymous" })).rejects.toThrow(UnauthenticatedError);
  });

  it("normalises untrusted query and page input", () => {
    expect(normaliseQuery(42)).toBe("");
    expect(normaliseQuery(`  ${"x".repeat(200)}`)).toHaveLength(100);
    expect(normalisePage("3")).toBe(3);
    expect(normalisePage("2.7")).toBe(2);
    for (const bad of [undefined, "x", -1, 0, Number.NaN, Number.POSITIVE_INFINITY]) expect(normalisePage(bad)).toBe(1);
    expect(normalisePage(1e9)).toBe(100_000);
    expect(ACCOUNTS_PAGE_SIZE).toBeGreaterThan(0);
  });
});

describe("viewAccount", () => {
  it("returns metadata only and records the view in the account's own log (rule 49)", async () => {
    const { d, s } = world();
    const out = await viewAccount(d, support, ACCOUNT_A, req);
    expect(out.summary).toMatchObject({ id: ACCOUNT_A, name: "Family A", plan: "plus", members: 1 });
    expect(out.people.map((p) => p.email)).toEqual(["kid@a.test"]);
    expect(out.domains).toEqual([{ id: "33333333-3333-4333-8333-333333333333", name: "a.test", status: "active" }]);
    expect(out.mailboxes).toEqual([
      {
        id: "44444444-4444-4444-8444-444444444444",
        address: "kid@a.test",
        status: "active",
        quotaBytes: 5,
        purgeAfter: null,
        applyFailed: false,
      },
    ]);
    expect(out.pendingInvites).toBe(0);
    const [entry] = s.audit;
    expect(entry).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      action: "staff.account_viewed",
      actor: { type: "staff", role: "support_admin" },
      result: "success",
      target: { type: "account", id: ACCOUNT_A, label: "Family A" },
    });
  });

  it("shows a deleted mailbox's restore date and whether the worker gave up applying it", async () => {
    const { d, s } = world();
    const purge = new Date("2026-11-30T00:00:00Z");
    const m = s.mailboxes[0];
    if (m === undefined) throw new Error("fixture");
    Object.assign(m, { status: "deleting", purgeAfter: purge, lastError: "unreachable" });
    const out = await viewAccount(d, support, ACCOUNT_A, req);
    expect(out.mailboxes[0]).toMatchObject({ status: "deleting", purgeAfter: purge, applyFailed: true });
  });

  it("records staff as staff even when they also belong to the account (rule 49)", async () => {
    const { d, s } = world();
    const both = user({ id: "staff-2", platform: ["support_admin"], account: [[ACCOUNT_A, "owner"]] });
    await viewAccount(d, both, ACCOUNT_A, req);
    expect(s.audit[0]?.actor).toMatchObject({
      type: "staff",
      userId: "staff-2",
      role: "support_admin",
      accountId: null,
    });
  });

  it("404s on unknown and malformed ids, 403s without the permission, and audits neither", async () => {
    const { d, s } = world();
    await expect(viewAccount(d, support, "22222222-2222-4222-8222-999999999999", req)).rejects.toThrow(NotFoundError);
    await expect(viewAccount(d, support, "nope", req)).rejects.toThrow(NotFoundError);
    await expect(viewAccount(d, user({ account: [[ACCOUNT_A, "owner"]] }), ACCOUNT_A, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(viewAccount(d, user({ platform: ["reports_reader"] }), ACCOUNT_A, req)).rejects.toThrow(
      ForbiddenError,
    );
    expect(s.audit).toEqual([]);
  });

  it("an account deleted between the check and the view is still a 404", async () => {
    const { d, s } = world();
    const original = d.uow.run.bind(d.uow);
    let calls = 0;
    d.uow.run = (fn) =>
      original(async (r) => {
        calls += 1;
        if (calls === 2) s.accounts = s.accounts.filter((a) => a.id !== ACCOUNT_A);
        return fn(r);
      });
    await expect(viewAccount(d, support, ACCOUNT_A, req)).rejects.toThrow(NotFoundError);
  });
});
