// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps as makeDeps, fixedClock } from "../__tests__/helpers";
import { GB, type Mailbox } from "./entity";
import { rebalancedQuotas, rebalanceStoragePools } from "./quota-cap";
import type { MailboxUsageReader } from "./storage";

const ids = {
  freeBig: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  freeFull: "a2a2a2a2-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  plusBig: "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  plusOk: "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  plusNew: "b3b3b3b3-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  plusOver: "b4b4b4b4-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const base: Mailbox = {
  id: "",
  accountId: "",
  userId: null,
  address: "b@plus.test",
  status: "active",
  quotaBytes: GB,
  stalwartId: "s4",
  lastError: null,
  purgeAfter: null,
  createdAt: new Date(0),
};

function setup() {
  const d = makeDeps(fixedClock("2026-10-23T12:00:00Z"));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Free", plan: "free" }, { id: ACCOUNT_B, name: "Plus", plan: "plus" });
  const box = (
    id: string,
    accountId: string,
    address: string,
    quotaGb: number,
    stalwartId: string | null,
  ): Mailbox => ({
    id,
    accountId,
    userId: null,
    address,
    status: stalwartId ? "active" : "provisioning",
    quotaBytes: quotaGb * GB,
    stalwartId,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    box(ids.freeBig, ACCOUNT_A, "jane@anhourmail.test", 10, "s1"),
    box(ids.freeFull, ACCOUNT_A, "full@anhourmail.test", 10, "s2"),
    box(ids.plusBig, ACCOUNT_B, "a@plus.test", 30, "s3"),
    box(ids.plusOk, ACCOUNT_B, "b@plus.test", 5, "s4"),
    box(ids.plusNew, ACCOUNT_B, "c@plus.test", 30, null),
    box(ids.plusOver, ACCOUNT_B, "d@plus.test", 12, "s6"),
  );
  return { d, s };
}

const sizes: Record<string, { name: string; used: number }> = {
  s1: { name: "jane", used: 200 * 1024 ** 2 },
  s2: { name: "full", used: 3.2 * GB },
  s3: { name: "a", used: 2 * GB },
  s4: { name: "b", used: 1 * GB },
  // Already over its own 12 GB quota: never raised.
  s6: { name: "d", used: 14 * GB },
};

const reader = (fail = false): MailboxUsageReader & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    usage: async (externalIds) => {
      asked.push(...externalIds);
      if (fail) throw new Error("mail server unavailable");
      return externalIds.flatMap((id) => {
        const a = sizes[id];
        return a ? [{ externalId: id, localPart: a.name, usedBytes: Math.round(a.used) }] : [];
      });
    },
  };
};

describe("rebalancedQuotas", () => {
  const gb = (m: Map<string, number>) => Object.fromEntries([...m].map(([k, v]) => [k, v / GB]));
  const box = (id: string, quotaGb: number, usedGb = 0) => ({ id, quotaBytes: quotaGb * GB, usedBytes: usedGb * GB });

  it("leaves an account within its pool as it is", () => {
    expect(gb(rebalancedQuotas(10 * GB, [box("a", 4), box("b", 6)]))).toEqual({ a: 4, b: 6 });
  });

  it("scales quotas down in proportion, in whole GB, using the whole pool", () => {
    expect(gb(rebalancedQuotas(10 * GB, [box("a", 10), box("b", 10)]))).toEqual({ a: 5, b: 5 });
    expect(gb(rebalancedQuotas(10 * GB, [box("a", 20), box("b", 10), box("c", 10)]))).toEqual({ a: 5, b: 3, c: 2 });
    const three = rebalancedQuotas(10 * GB, [box("a", 10), box("b", 10), box("c", 10)]);
    expect([...three.values()].reduce((s, v) => s + v, 0)).toBe(10 * GB);
  });

  it("never goes below what a mailbox holds (rounded up, at least 1 GB): the others give up more", () => {
    expect(gb(rebalancedQuotas(10 * GB, [box("a", 10, 8.2), box("b", 10)]))).toEqual({ a: 9, b: 1 });
    expect(gb(rebalancedQuotas(1 * GB, [box("a", 10, 0.2), box("b", 10, 3.2)]))).toEqual({ a: 1, b: 4 });
  });

  it("never raises a quota, even for a mailbox already over it", () => {
    expect(gb(rebalancedQuotas(10 * GB, [box("a", 12, 14), box("b", 30)]))).toEqual({ a: 12, b: 1 });
  });
});

describe("rebalanceStoragePools", () => {
  it("scales over-assigned accounts into their pool, keeps room for mail, queues the change, audits it", async () => {
    const { d, s } = setup();
    const r = reader();
    const run = await rebalanceStoragePools(d, r);
    expect(run).toEqual({ overPool: 2, lowered: 5, keptAbovePool: [ACCOUNT_A, ACCOUNT_B], unmeasured: 0 });
    // Every mailbox on the mail server in an over-assigned account was measured, never one that isn't there.
    expect(r.asked.sort()).toEqual(["s1", "s2", "s3", "s4", "s6"]);
    const quota = (id: string) => (s.mailboxes.find((m) => m.id === id)?.quotaBytes ?? 0) / GB;
    expect(quota(ids.freeBig)).toBe(1);
    expect(quota(ids.freeFull)).toBe(4); // holds 3.2 GB: kept at 4, so Free's 1 GB pool stays exceeded
    expect(quota(ids.plusBig)).toBe(2); // holds 2 GB
    expect(quota(ids.plusOk)).toBe(1);
    expect(quota(ids.plusNew)).toBe(1); // not on the mail server yet: holds nothing
    expect(quota(ids.plusOver)).toBe(12); // already over its quota: never raised, never lowered below its mail
    // The mail server gets the change through the provisioning queue (nothing for one not created yet).
    expect(s.jobs.map((j) => j.subjectId).sort()).toEqual([ids.freeBig, ids.freeFull, ids.plusBig, ids.plusOk].sort());
    expect(s.jobs.every((j) => j.kind === "mailbox.ensure")).toBe(true);
    // Audited in each mailbox's account as a system action, with the reason and the size that decided it.
    const entries = s.audit.filter((e) => e.action === "mailbox.quota_changed");
    expect(entries.find((e) => e.target.id === ids.freeFull)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      actor: { type: "system" },
      meta: { fromGb: 10, toGb: 4, poolGb: 1, reason: "storage_pooled" },
    });
    expect(entries.find((e) => e.target.id === ids.plusBig)).toMatchObject({
      scope: `account:${ACCOUNT_B}`,
      meta: { fromGb: 30, toGb: 2, poolGb: 10, usedBytes: 2 * GB, reason: "storage_pooled" },
    });
    // The fresh measurement is kept for the console.
    expect(s.mailboxStorage.find((x) => x.mailboxId === ids.plusBig)?.usedBytes).toBe(2 * GB);
  });

  it("is idempotent: a second run changes nothing and writes no audit", async () => {
    const { d, s } = setup();
    await rebalanceStoragePools(d, reader());
    const before = s.audit.length;
    const run = await rebalanceStoragePools(d, reader());
    expect(run).toEqual({ overPool: 2, lowered: 0, keptAbovePool: [ACCOUNT_A, ACCOUNT_B], unmeasured: 0 });
    expect(s.audit.length).toBe(before);
  });

  it("leaves an account within its pool alone and never measures it", async () => {
    const { d, s } = setup();
    s.mailboxes.splice(0, s.mailboxes.length);
    s.mailboxes.push({ ...base, id: ids.plusOk, accountId: ACCOUNT_B, quotaBytes: 10 * GB });
    const r = reader();
    expect(await rebalanceStoragePools(d, r)).toEqual({ overPool: 0, lowered: 0, keptAbovePool: [], unmeasured: 0 });
    expect(r.asked).toEqual([]);
  });

  it("never rebalances blind: when the mail server can't say what a mailbox holds, its account stays", async () => {
    const { d, s } = setup();
    const run = await rebalanceStoragePools(d, reader(true));
    expect(run).toEqual({ overPool: 2, lowered: 0, keptAbovePool: [], unmeasured: 2 });
    expect((s.mailboxes.find((m) => m.id === ids.freeFull)?.quotaBytes ?? 0) / GB).toBe(10);
    expect((s.mailboxes.find((m) => m.id === ids.plusNew)?.quotaBytes ?? 0) / GB).toBe(30);
  });

  it("an account moved to another plan meanwhile is left alone", async () => {
    const { d, s } = setup();
    const r: MailboxUsageReader = {
      usage: async (externalIds) => {
        const a = s.accounts.find((x) => x.id === ACCOUNT_A);
        if (a) a.plan = "supporter"; // changes between the list and the unit of work
        return reader().usage(externalIds);
      },
    };
    await rebalanceStoragePools(d, r);
    expect((s.mailboxes.find((m) => m.id === ids.freeBig)?.quotaBytes ?? 0) / GB).toBe(10);
    expect(s.audit.find((e) => e.target.id === ids.freeBig)?.meta).toMatchObject({ unchanged: true });
  });

  it("an account whose mailbox is renamed on the mail server isn't measured (left unmeasured)", async () => {
    const { d } = setup();
    const r: MailboxUsageReader = {
      usage: async (externalIds) => externalIds.map((id) => ({ externalId: id, localPart: "other", usedBytes: 0 })),
    };
    expect((await rebalanceStoragePools(d, r)).unmeasured).toBe(2);
  });
});
