// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lapse, holds and timers (ADR-0029 §5, §6; slice 10) against the in-memory repositories and the fake provider, through
 * the real checkout and sync: a cancelled subscription lapses with holds (pending invites revoked), "Choose what stays
 * on" with receive windows that never restart, the restricted timeout, ended comps, holds dropped for deleted items,
 * held mailboxes out of the storage pool (pinned to their mail), and a resubscribe lifting every hold. Nothing is
 * deleted.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BILLING } from "@anhourmail/shared/plans";
import { minQuotaBytes } from "@anhourmail/shared/storage";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  actAs,
  deps as makeDeps,
  fixedClock,
  req,
  TEST_PLATFORM,
  user,
} from "../__tests__/helpers";
import { GB } from "../mailboxes/entity";
import { mailboxStoragePool, setMailboxQuota } from "../mailboxes/service";
import { rebalanceStoragePools } from "../mailboxes/quota-cap";
import type { MailboxUsageReader } from "../mailboxes/storage";

import { cancelSubscription } from "./changes";
import { startCheckout } from "./checkout";
import type { BillingContext } from "./guards";
import { chooseHolds, parseHoldsChoice, runBillingTimers, swapReceiveWindows } from "./lapse";
import { defaultBilling } from "./lifecycle";
import { type BillingProvider, BillingProviderError } from "./ports";
import { syncAccountBilling } from "./sync";

const APP = "http://localhost:43200";
const DAY = 86_400_000;
const SESSION = { sessionId: "session-1" };
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const member = user({ id: "member-1", account: [[ACCOUNT_A, "member"]] });
const outsider = user({ id: "outsider-1", account: [[ACCOUNT_B, "owner"]] });

const ids = {
  own: "a0000000-0000-4000-8000-000000000001",
  second: "a0000000-0000-4000-8000-000000000002",
  custom: "a0000000-0000-4000-8000-000000000003",
  domain: "d0000000-0000-4000-8000-000000000001",
};

async function world() {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free" }, { id: ACCOUNT_B, name: "Other", plan: "free" });
  s.memberships.push({ userId: owner.userId, accountId: ACCOUNT_A, role: "owner" });
  const box = (id: string, address: string, userId: string | null, ageDays: number) => ({
    id,
    accountId: ACCOUNT_A,
    userId,
    address,
    status: "active" as const,
    quotaBytes: 3 * GB,
    stalwartId: `s-${id.slice(-2)}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(clock.now().getTime() - ageDays * DAY),
  });
  s.mailboxes.push(
    box(ids.own, `owner@${TEST_PLATFORM.domain}`, owner.userId, 10),
    box(ids.second, `second@${TEST_PLATFORM.domain}`, null, 20),
    box(ids.custom, "desk@acme.test", null, 5),
  );
  const fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("lapse-test"),
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  const ctx: BillingContext = { provider: fake, appUrl: APP, redirectOrigins: [APP] };
  const sync = () => syncAccountBilling(d, fake, ACCOUNT_A);
  const subscribe = async () => {
    const { url } = await startCheckout(d, ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
    await fake.completeCheckout(url.split("/").pop() ?? "", "pay");
    await fake.drainDeliveries();
    await sync();
  };
  await subscribe();
  // Paid now: a custom domain on the account (a held domain stays on the mail server after a lapse).
  s.domains.push({
    id: ids.domain,
    accountId: ACCOUNT_A,
    name: "acme.test",
    status: "active",
    verifyToken: "t",
    stalwartId: "sd",
    lastError: null,
    createdAt: clock.now(),
  });
  const row = async () => (await d.uow.run((r) => r.billing.get(ACCOUNT_A)))!;
  const holds = () => d.uow.run((r) => r.billing.holds(ACCOUNT_A));
  const audit = (action: string) => s.audit.filter((e) => e.action === action && e.scope === `account:${ACCOUNT_A}`);
  const lapse = async () => {
    s.stepUps.push({ userId: owner.userId, sessionId: SESSION.sessionId, expiresAt: new Date("2099-01-01") });
    await cancelSubscription(d, ctx, owner, ACCOUNT_A, SESSION, req);
    await fake.advanceClock(366);
    await fake.drainDeliveries();
    await sync();
  };
  return { clock, d, s, fake, ctx, sync, subscribe, row, holds, audit, lapse };
}

const usage = (bytes: Record<string, number>): MailboxUsageReader => ({
  usage: async (externalIds) =>
    externalIds.map((externalId) => ({
      externalId,
      localPart: externalId === "s-01" ? "owner" : externalId === "s-02" ? "second" : "desk",
      usedBytes: bytes[externalId] ?? 0,
    })),
});

describe("lapse: holds applied, invites revoked", () => {
  it("a subscription that ends lapses the account: the Owner's platform mailbox stays on, the rest is held", async () => {
    const w = await world();
    w.s.invites.push({
      id: randomUUID(),
      accountId: ACCOUNT_A,
      email: "new@example.test",
      role: "member",
      status: "pending",
      expiresAt: new Date("2099-01-01"),
      createdBy: owner.userId,
      createdAt: w.clock.now(),
      tokenHash: "h",
      acceptedUserId: null,
      acceptedAt: null,
    });
    await w.lapse();
    const b = await w.row();
    expect(b.state).toBe("lapsed");
    expect(w.s.accounts.find((a) => a.id === ACCOUNT_A)?.plan).toBe("free");
    const held = await w.holds();
    expect(held.map((h) => `${h.subjectType}:${h.subjectId}`).sort()).toEqual(
      [`mailbox:${ids.second}`, `mailbox:${ids.custom}`, `domain:${ids.domain}`].sort(),
    );
    expect(held.find((h) => h.subjectId === ids.second)?.receiveUntil?.getTime()).toBe(
      w.clock.now().getTime() + BILLING.heldReceiveDays * DAY,
    );
    expect(w.s.invites[0]?.status).toBe("revoked");
    expect(w.audit("account.invite_revoked")[0]?.meta).toMatchObject({ reason: "plan_lapsed" });
    expect(w.s.mailboxes).toHaveLength(3); // nothing deleted
    expect(w.s.domains).toHaveLength(1);
  });

  it("resubscribing lifts every hold", async () => {
    const w = await world();
    await w.lapse();
    expect((await w.holds()).length).toBeGreaterThan(0);
    w.clock.set(new Date(w.clock.now().getTime() + DAY));
    await w.subscribe();
    expect((await w.row()).state).toBe("active");
    expect(await w.holds()).toEqual([]);
    expect(w.audit("billing.holds_lifted")).toHaveLength(1);
  });
});

describe("Choose what stays on", () => {
  it("swaps the kept platform mailbox; windows already running keep their date, a newly held one never runs past the lapse's", async () => {
    const w = await world();
    await w.lapse();
    const before = await w.holds();
    w.clock.set(new Date(w.clock.now().getTime() + 10 * DAY));
    const out = await chooseHolds(w.d, owner, ACCOUNT_A, { mailboxId: ids.second }, req);
    expect(out.keptMailboxId).toBe(ids.second);
    const after = await w.holds();
    expect(after.some((h) => h.subjectId === ids.second)).toBe(false);
    const own = after.find((h) => h.subjectId === ids.own);
    const lapsedAt = (await w.row()).lapsedAt!;
    expect(own?.receiveUntil?.getTime()).toBe(lapsedAt.getTime() + BILLING.heldReceiveDays * DAY);
    expect(after.find((h) => h.subjectId === ids.custom)?.receiveUntil).toEqual(
      before.find((h) => h.subjectId === ids.custom)?.receiveUntil,
    );
    expect(w.audit("billing.holds_changed").at(-1)).toMatchObject({ result: "success" });
    expect(w.s.jobs.filter((j) => j.kind === "mailbox.ensure").map((j) => j.subjectId)).toEqual(
      expect.arrayContaining([ids.own, ids.second, ids.custom]),
    );
  });

  it("refuses what doesn't fit Free (400), outside a lapse (400 invalid_change, audited), and the wrong people", async () => {
    const w = await world();
    await expect(chooseHolds(w.d, owner, ACCOUNT_A, { mailboxId: ids.second }, req)).rejects.toMatchObject({
      code: "invalid_change",
    });
    expect(w.audit("billing.holds_changed").at(-1)).toMatchObject({ result: "denied", errorCode: "invalid_change" });
    await w.lapse();
    await expect(chooseHolds(w.d, owner, ACCOUNT_A, { mailboxId: ids.custom }, req)).rejects.toThrow(
      "not a custom domain",
    );
    await expect(chooseHolds(w.d, owner, ACCOUNT_A, { mailboxId: randomUUID() }, req)).rejects.toThrow(
      "Choose a mailbox in this account",
    );
    await expect(chooseHolds(w.d, owner, ACCOUNT_A, { mailboxId: "x" }, req)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(chooseHolds(w.d, member, ACCOUNT_A, {}, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(chooseHolds(w.d, outsider, ACCOUNT_A, {}, req)).rejects.toMatchObject({ code: "not_found" });
    await expect(chooseHolds(w.d, { ...owner, actingAs: actAs(ACCOUNT_A) }, ACCOUNT_A, {}, req)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("parses the choice", () => {
    expect(parseHoldsChoice({})).toEqual({});
    expect(parseHoldsChoice({ aliasIds: [ids.own] })).toEqual({ aliasIds: [ids.own] });
    expect(() => parseHoldsChoice({ aliasIds: "x" })).toThrow();
    expect(() => parseHoldsChoice({ aliasIds: ["not-an-id"] })).toThrow();
  });

  it("caps a newly held window at the lapse's", () => {
    const lapsedAt = new Date("2026-11-01T00:00:00Z");
    const late = new Date(lapsedAt.getTime() + 40 * DAY);
    expect(
      swapReceiveWindows([{ subjectType: "mailbox", subjectId: "m1", receiveUntil: late }], [], lapsedAt)[0]
        ?.receiveUntil,
    ).toEqual(new Date(lapsedAt.getTime() + BILLING.heldReceiveDays * DAY));
    expect(
      swapReceiveWindows([{ subjectType: "mailbox", subjectId: "m1", receiveUntil: late }], [], null)[0]?.receiveUntil,
    ).toEqual(late);
  });
});

describe("billing.timers", () => {
  it("ends a subscription restricted past restrictedDays, and the sync lapses the account with holds", async () => {
    const w = await world();
    const customerId = (await w.row()).providerCustomerId ?? "";
    await w.fake.setCardFails(customerId, true);
    await w.fake.advanceClock(366);
    await w.fake.exhaustRetries(customerId);
    await w.sync();
    expect((await w.row()).state).toBe("restricted");
    // Not yet: inside the grace period nothing happens.
    w.clock.set(new Date(w.clock.now().getTime() + (BILLING.restrictedDays - 1) * DAY));
    expect((await runBillingTimers(w.d, w.fake)).restrictedEnded).toBe(0);
    w.clock.set(new Date(w.clock.now().getTime() + 2 * DAY));
    const run = await runBillingTimers(w.d, w.fake);
    expect(run).toMatchObject({ restrictedEnded: 1, restrictedFailed: 0 });
    expect(await w.fake.getSubscription(customerId)).toBeNull();
    expect(w.audit("billing.subscription_ended")[0]?.meta).toMatchObject({ reason: "restricted_timeout" });
    expect(w.s.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT_A)).toBe(true);
    await w.sync();
    expect((await w.row()).state).toBe("lapsed");
    expect((await w.holds()).length).toBeGreaterThan(0);
  });

  it("leaves a dispute-only restriction alone, counts a provider failure and carries on", async () => {
    const w = await world();
    const customerId = (await w.row()).providerCustomerId ?? "";
    await w.fake.openDispute(customerId);
    await w.sync();
    expect((await w.row()).state).toBe("restricted");
    w.clock.set(new Date(w.clock.now().getTime() + 90 * DAY));
    expect((await runBillingTimers(w.d, w.fake)).restrictedEnded).toBe(0);
    // A payment restriction past its time while the provider is down: counted, retried next hour.
    const row = await w.row();
    await w.d.uow.run((r) => r.billing.save({ ...row, disputedAt: null, restrictedAt: new Date(0) }));
    const down: BillingProvider = {
      ...w.fake,
      cancel: () => Promise.reject(new BillingProviderError("unavailable", "down")),
    };
    expect(await runBillingTimers(w.d, down)).toMatchObject({ restrictedEnded: 0, restrictedFailed: 1 });
    // Billing off: nothing is ended without the provider.
    expect((await runBillingTimers(w.d, null)).restrictedEnded).toBe(0);
  });

  it("syncs an ended comp", async () => {
    const w = await world();
    await w.d.uow.run((r) =>
      r.billing.save({
        ...defaultBilling(ACCOUNT_B, "plus", w.clock.now()),
        planSource: "comp",
        compUntil: new Date(w.clock.now().getTime() - 1000),
      }),
    );
    const run = await runBillingTimers(w.d, w.fake);
    expect(run.compsEnded).toBe(1);
    expect(w.s.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT_B)).toBe(true);
  });

  it("drops holds on deleted items; with none left the sync makes the account free", async () => {
    const w = await world();
    await w.lapse();
    // The Owner deletes the custom-domain mailbox and the domain: their holds go; the second mailbox stays held.
    w.s.mailboxes = w.s.mailboxes.filter((m) => m.id !== ids.custom);
    w.s.domains = [];
    const run = await runBillingTimers(w.d, w.fake);
    expect(run.holdsPruned).toBe(1);
    expect((await w.holds()).map((h) => h.subjectId)).toEqual([ids.second]);
    expect(w.audit("billing.holds_changed").at(-1)?.meta).toMatchObject({ reason: "removed", mailboxes: 1 });
    // Past its window the held mailbox is counted but still receives (send-blocked; the maintainer's call).
    w.clock.set(new Date(w.clock.now().getTime() + (BILLING.heldReceiveDays + 1) * DAY));
    expect((await runBillingTimers(w.d, w.fake)).receiveWindowsPassed).toBe(1);
    w.s.mailboxes = w.s.mailboxes.filter((m) => m.id !== ids.second);
    await runBillingTimers(w.d, w.fake);
    expect(await w.holds()).toEqual([]);
    await w.sync();
    expect((await w.row()).state).toBe("free");
  });
});

describe("held mailboxes and the storage pool", () => {
  it("leave the pool arithmetic: pinned to their mail, the kept mailbox fits Free's pool on its own", async () => {
    const w = await world();
    await w.lapse();
    const run = await rebalanceStoragePools(w.d, usage({ "s-01": 200 * 1024 ** 2, "s-02": 1.5 * GB, "s-03": 0 }));
    expect(run.unmeasured).toBe(0);
    const quota = (id: string) => w.s.mailboxes.find((m) => m.id === id)?.quotaBytes;
    expect(quota(ids.second)).toBe(minQuotaBytes(1.5 * GB));
    expect(quota(ids.custom)).toBe(minQuotaBytes(0));
    const pool = await mailboxStoragePool(w.d, owner, ACCOUNT_A);
    expect(pool.assignedBytes).toBeLessThanOrEqual(pool.poolBytes);
    expect(quota(ids.own)).toBe(pool.poolBytes);
    const reasons = w.s.audit.filter((e) => e.action === "mailbox.quota_changed").map((e) => e.meta.reason);
    expect(reasons).toEqual(expect.arrayContaining(["plan_hold", "storage_pooled"]));
    // A held mailbox's storage can't be changed while held.
    await expect(setMailboxQuota(w.d, owner, ACCOUNT_A, ids.second, { quotaGb: 2 }, req)).rejects.toMatchObject({
      code: "plan_limit",
    });
  });
});
