// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import type { Deps, UserActor } from "@anhourmail/core";
import type { AccountRole, PlatformRole } from "@anhourmail/shared/rbac";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { consoleSearch, normaliseSearch, rank, SEARCH_PER_KIND } from "./search";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const at = new Date("2026-10-01T00:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function world(): Deps {
  const uow = new MemoryUnitOfWork();
  const s = uow.state;
  s.accounts.push({ id: A, name: "Demo Family", plan: "plus" }, { id: B, name: "Other Group", plan: "plus" });
  s.memberships.push(
    { userId: "owner", accountId: A, role: "owner" },
    { userId: "kid", accountId: A, role: "member" },
    { userId: "other", accountId: B, role: "owner" },
  );
  Object.assign(s.userEmails, { owner: "parent@family.test", kid: "kid@family.test", other: "boss@group.test" });
  Object.assign(s.userNames, { owner: "Pat Parent", kid: "Kim Kid", other: "Bo Boss" });
  const mailbox = (n: number, accountId: string, userId: string | null, address: string) => ({
    id: uuid(n),
    accountId,
    userId,
    address,
    status: "active" as const,
    quotaBytes: 1024 ** 3,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: at,
  });
  s.mailboxes.push(
    mailbox(1, A, "owner", "pat@family.test"),
    mailbox(2, A, "kid", "kim@family.test"),
    mailbox(3, B, "other", "pat@group.test"),
  );
  s.aliases.push(
    {
      id: uuid(11),
      accountId: A,
      mailboxId: uuid(2),
      address: "school@family.test",
      kind: "alias",
      enabled: true,
      adminLocked: false,
      description: null,
      createdAt: at,
    },
    {
      id: uuid(12),
      accountId: A,
      mailboxId: uuid(1),
      address: "shopping@family.test",
      kind: "masked",
      enabled: true,
      adminLocked: false,
      description: "store",
      createdAt: at,
    },
  );
  s.domains.push(
    {
      id: uuid(21),
      accountId: A,
      name: "family.test",
      status: "active",
      verifyToken: "t",
      stalwartId: "x",
      lastError: null,
      createdAt: at,
    },
    {
      id: uuid(22),
      accountId: B,
      name: "group.test",
      status: "active",
      verifyToken: "t",
      stalwartId: "x",
      lastError: null,
      createdAt: at,
    },
  );
  return { uow, clock: { now: () => new Date("2026-10-22T12:00:00Z") }, platform: PUBLIC_PLATFORM };
}

const user = (id: string, account: [string, AccountRole][] = [], platform: PlatformRole[] = []): UserActor => ({
  kind: "user",
  userId: id,
  email: `${id}@x.test`,
  platformRoles: platform,
  memberships: account.map(([accountId, role]) => ({ accountId, role })),
  suspended: false,
});

const labels = async (deps: Deps, actor: UserActor, q: string) =>
  (await consoleSearch(deps, actor, q)).hits.map((h) => `${h.kind}:${h.label}`);

describe("console search", () => {
  it("finds an owner's mailboxes, aliases, domains and people, with links into the account", async () => {
    const deps = world();
    const result = await consoleSearch(deps, user("owner", [[A, "owner"]]), "  FAMILY ");
    expect(result.query).toBe("family");
    expect(result.hits.map((h) => h.kind)).toEqual([
      "mailbox",
      "mailbox",
      "alias",
      "alias",
      "domain",
      "person",
      "person",
    ]);
    const mailbox = result.hits.find((h) => h.label === "kim@family.test");
    expect(mailbox?.href).toBe(`/accounts/${A}/mailboxes?mailbox=${uuid(2)}`);
    expect(mailbox?.detail).toBe("Belongs to kid@family.test");
    expect(result.hits.find((h) => h.kind === "domain")?.href).toBe(`/accounts/${A}/domains?domain=${uuid(21)}`);
    expect(result.hits.find((h) => h.kind === "alias")?.href).toBe(
      `/accounts/${A}/aliases?q=${encodeURIComponent("school@family.test")}`,
    );
  });

  it("never returns another account's data (cross-account isolation)", async () => {
    const deps = world();
    expect(await labels(deps, user("owner", [[A, "owner"]]), "group")).toEqual([]);
    // An alias also matches on the mailbox it delivers to.
    expect(await labels(deps, user("owner", [[A, "owner"]]), "pat@")).toEqual([
      "mailbox:pat@family.test",
      "alias:shopping@family.test",
    ]);
  });

  it("gives a member only their own aliases: no mailboxes, domains or people", async () => {
    const deps = world();
    expect(await labels(deps, user("kid", [[A, "member"]]), "family")).toEqual(["alias:school@family.test"]);
  });

  it("finds customer accounts for staff who can look them up, and nothing for staff who can't", async () => {
    const deps = world();
    expect(await labels(deps, user("staff", [], ["global_admin"]), "group")).toEqual(["account:Other Group"]);
    expect((await consoleSearch(deps, user("staff", [], ["global_admin"]), "demo")).hits[0]?.href).toBe(
      `/platform/accounts/${A}`,
    );
    expect(await labels(deps, user("reader", [], ["reports_reader"]), "group")).toEqual([]);
  });

  it("names the account when the person belongs to more than one", async () => {
    const deps = world();
    const both = user("owner", [
      [A, "owner"],
      [B, "auditor"],
    ]);
    const result = await consoleSearch(deps, both, "pat@", { [A]: "Demo Family", [B]: "Other Group" });
    expect(result.hits.map((h) => h.detail)).toEqual([
      "Belongs to parent@family.test · Demo Family",
      "Belongs to boss@group.test · Other Group",
      "Masked alias to pat@family.test · Demo Family",
    ]);
  });

  it("answers nothing to short queries, signed-out callers and junk input", async () => {
    const deps = world();
    expect((await consoleSearch(deps, user("owner", [[A, "owner"]]), "p")).hits).toEqual([]);
    expect((await consoleSearch(deps, { kind: "anonymous" }, "family")).hits).toEqual([]);
    expect((await consoleSearch(deps, user("owner", [[A, "owner"]]), ["family"])).hits).toEqual([]);
    expect(normaliseSearch("x".repeat(500))).toHaveLength(100);
    expect(normaliseSearch(42)).toBe("");
  });
});

describe("ranking", () => {
  it("puts prefix matches first and caps the list", () => {
    const items = ["xabc", "abc", "zzz", ...Array.from({ length: 10 }, (_, i) => `abc${String(i)}`)];
    const out = rank(items, "abc", (s) => [s]);
    expect(out).toHaveLength(SEARCH_PER_KIND);
    expect(out[0]).toBe("abc");
    expect(out).not.toContain("zzz");
    expect(rank(["xabc", null], "abc", (s) => [s])).toEqual(["xabc"]);
  });
});
