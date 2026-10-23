// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps as makeDeps, fixedClock } from "../__tests__/helpers";
import { GB, type Mailbox } from "./entity";
import { capQuotasToPlan, cappedQuota } from "./quota-cap";
import type { MailboxUsageReader } from "./storage";

const ids = {
  freeBig: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  freeFull: "a2a2a2a2-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  plusBig: "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  plusOk: "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  plusNew: "b3b3b3b3-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  plusOver: "b4b4b4b4-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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

describe("cappedQuota", () => {
  it("the plan's storage, or what the mailbox holds rounded up to the next GB; never more than now", () => {
    expect(cappedQuota(30 * GB, 10 * GB, 2 * GB)).toBe(10 * GB);
    expect(cappedQuota(30 * GB, 10 * GB, 0)).toBe(10 * GB);
    expect(cappedQuota(30 * GB, 10 * GB, 12.1 * GB)).toBe(13 * GB);
    expect(cappedQuota(30 * GB, 10 * GB, 13 * GB)).toBe(13 * GB);
    expect(cappedQuota(12 * GB, 10 * GB, 14 * GB)).toBe(12 * GB);
    expect(cappedQuota(5 * GB, 10 * GB, 1 * GB)).toBe(5 * GB);
    expect(cappedQuota(10 * GB, 1 * GB, -5)).toBe(1 * GB);
  });
});

describe("capQuotasToPlan", () => {
  it("caps quotas above the plan, keeps room for mail already there, queues the mail server change, audits it", async () => {
    const { d, s } = setup();
    const r = reader();
    const run = await capQuotasToPlan(d, r);
    expect(run).toEqual({ above: 5, capped: 3, keptAbovePlan: [ids.freeFull, ids.plusOver], unmeasured: 0 });
    // Only mailboxes above their plan were measured, never one that isn't on the mail server.
    expect(r.asked.sort()).toEqual(["s1", "s2", "s3", "s6"]);
    const quota = (id: string) => (s.mailboxes.find((m) => m.id === id)?.quotaBytes ?? 0) / GB;
    expect(quota(ids.freeBig)).toBe(1);
    expect(quota(ids.freeFull)).toBe(4); // holds 3.2 GB: kept at 4, above Free's 1 GB
    expect(quota(ids.plusBig)).toBe(10);
    expect(quota(ids.plusOk)).toBe(5); // already within the plan: untouched
    expect(quota(ids.plusNew)).toBe(10); // not on the mail server yet: holds nothing
    expect(quota(ids.plusOver)).toBe(12); // already over its quota: unchanged, never raised
    // The mail server gets the change through the provisioning queue (nothing for one not created yet).
    expect(s.jobs.map((j) => j.subjectId).sort()).toEqual([ids.freeBig, ids.freeFull, ids.plusBig].sort());
    expect(s.jobs.every((j) => j.kind === "mailbox.ensure")).toBe(true);
    // Audited in each mailbox's account as a system action, with the reason and the size that decided it.
    const entries = s.audit.filter((e) => e.action === "mailbox.quota_changed");
    expect(entries.find((e) => e.target.id === ids.freeFull)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      actor: { type: "system" },
      meta: { fromGb: 10, toGb: 4, planGb: 1, abovePlan: true, reason: "plan_storage_reduced" },
    });
    expect(entries.find((e) => e.target.id === ids.plusBig)).toMatchObject({
      scope: `account:${ACCOUNT_B}`,
      meta: { fromGb: 30, toGb: 10, planGb: 10, abovePlan: false, usedBytes: 2 * GB },
    });
    // The fresh measurement is kept for the console.
    expect(s.mailboxStorage.find((x) => x.mailboxId === ids.plusBig)?.usedBytes).toBe(2 * GB);
  });

  it("is idempotent: a second run changes nothing and writes no audit", async () => {
    const { d, s } = setup();
    await capQuotasToPlan(d, reader());
    const before = s.audit.length;
    const run = await capQuotasToPlan(d, reader());
    expect(run).toEqual({ above: 2, capped: 0, keptAbovePlan: [ids.freeFull, ids.plusOver], unmeasured: 0 });
    // freeFull at 4 GB holding 3.2 GB is above the plan but can't go lower; plusOver stays as is.
    expect(s.audit.length).toBe(before);
  });

  it("never caps blind: when the mail server can't say what a mailbox holds, its quota stays", async () => {
    const { d, s } = setup();
    const run = await capQuotasToPlan(d, reader(true));
    expect(run).toEqual({ above: 5, capped: 1, keptAbovePlan: [], unmeasured: 4 });
    expect((s.mailboxes.find((m) => m.id === ids.freeFull)?.quotaBytes ?? 0) / GB).toBe(10);
    // Only the one that isn't on the mail server (holds nothing) was capped.
    expect((s.mailboxes.find((m) => m.id === ids.plusNew)?.quotaBytes ?? 0) / GB).toBe(10);
  });

  it("an account moved to a bigger plan meanwhile is left alone", async () => {
    const { d, s } = setup();
    const r: MailboxUsageReader = {
      usage: async (externalIds) => {
        const a = s.accounts.find((x) => x.id === ACCOUNT_A);
        if (a) a.plan = "supporter"; // changes between the list and the unit of work
        return reader().usage(externalIds);
      },
    };
    await capQuotasToPlan(d, r);
    // jane (10 GB) is at Supporter's 10 GB: unchanged.
    expect((s.mailboxes.find((m) => m.id === ids.freeBig)?.quotaBytes ?? 0) / GB).toBe(10);
    expect(s.audit.find((e) => e.target.id === ids.freeBig)?.meta).toMatchObject({ unchanged: true });
  });

  it("an account whose mailbox is renamed on the mail server isn't measured (left unmeasured)", async () => {
    const { d } = setup();
    const r: MailboxUsageReader = {
      usage: async (externalIds) => externalIds.map((id) => ({ externalId: id, localPart: "other", usedBytes: 0 })),
    };
    const run = await capQuotasToPlan(d, r);
    expect(run.unmeasured).toBe(4);
  });
});
