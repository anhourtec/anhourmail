// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan and add-on changes, cancelling and the self-service refund (ADR-0029 §7, §9; slice 9) against the in-memory
 * repositories and the fake provider, with the account subscribed through the real checkout and sync: increases need
 * the confirmed amount, decreases renew lower and never strand anything, a declined card changes nothing, step-up for
 * cancel, undo and refund, the 14-day refund rules, and permission (403) and scope (404) for every service.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { accountPoolBytes, BILLING, PLANS } from "@anhourmail/shared/plans";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import { ACCOUNT_A, ACCOUNT_B, actAs, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";

import {
  cancelSubscription,
  changeBilling,
  parseChange,
  previewBillingChange,
  refundSubscription,
  undoCancelSubscription,
} from "./changes";
import { billingOverview, startCheckout } from "./checkout";
import type { BillingContext } from "./guards";
import { defaultBilling } from "./lifecycle";
import { syncAccountBilling } from "./sync";

const APP = "http://localhost:43200";
const DAY = 86_400_000;
const SESSION = { sessionId: "session-1" };
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const billingAdmin = user({ id: "billing-1", account: [[ACCOUNT_A, "billing_admin"]] });
const auditor = user({ id: "auditor-1", account: [[ACCOUNT_A, "auditor"]] });
const member = user({ id: "member-1", account: [[ACCOUNT_A, "member"]] });
const outsider = user({ id: "outsider-1", account: [[ACCOUNT_B, "owner"]] });

async function subscribed(opts: { storageBlocks?: number; extraMailboxes?: number; plan?: "plus" | "supporter" } = {}) {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  d.uow.state.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free" });
  d.uow.state.accounts.push({ id: ACCOUNT_B, name: "Other", plan: "free" });
  const fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("changes-test"),
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  const ctx: BillingContext = { provider: fake, appUrl: APP, redirectOrigins: [APP], paidPlansOpen: true };
  const { url } = await startCheckout(
    d,
    ctx,
    owner,
    ACCOUNT_A,
    {
      plan: opts.plan ?? "plus",
      currency: "USD",
      ...(opts.plan === "supporter" ? { supporterAmountMinor: 5000 } : {}),
      storageBlocks: opts.storageBlocks ?? 1,
      extraMailboxes: opts.extraMailboxes ?? 1,
    },
    req,
  );
  await fake.completeCheckout(url.split("/").pop() ?? "", "pay");
  await fake.drainDeliveries();
  const sync = () => syncAccountBilling(d, fake, ACCOUNT_A);
  await sync();
  const row = async () => {
    const b = await d.uow.run((r) => r.billing.get(ACCOUNT_A));
    if (!b) throw new Error("no billing row");
    return b;
  };
  const customerId = (await row()).providerCustomerId ?? "";
  const sub = async () => (await fake.getSubscription(customerId))!;
  const audit = (action: string) =>
    d.uow.state.audit.filter(
      (e) => e.action === action && e.scope === `account:${ACCOUNT_A}` && e.actor.type !== "system",
    );
  const stepUp = (userId: string) =>
    d.uow.state.stepUps.push({ userId, sessionId: SESSION.sessionId, expiresAt: new Date("2099-01-01") });
  const addMailboxes = (n: number, quotaBytes = 1024 ** 3) => {
    for (let i = 0; i < n; i++) {
      d.uow.state.mailboxes.push({
        id: randomUUID(),
        accountId: ACCOUNT_A,
        userId: null,
        address: `m${String(i)}-${randomUUID().slice(0, 6)}@example.test`,
        status: "active",
        quotaBytes,
        stalwartId: null,
        lastError: null,
        purgeAfter: null,
        createdAt: clock.now(),
      });
    }
  };
  return { clock, d, fake, ctx, sync, row, sub, audit, stepUp, addMailboxes, customerId };
}

describe("parseChange", () => {
  const plus = { paidPlan: "plus" as const, currency: "USD" as const };
  it("reads quantities and plan switches, and checks the Supporter amount against the account's currency", () => {
    expect(parseChange({ storageBlocks: 3 }, plus)).toEqual({ storageBlocks: 3 });
    expect(parseChange({ plan: "supporter", supporterAmountMinor: 4000 }, plus)).toEqual({
      plan: "supporter",
      supporterAmountMinor: 4000,
    });
    expect(parseChange({ supporterAmountMinor: 4000 }, { paidPlan: "supporter", currency: "USD" })).toEqual({
      supporterAmountMinor: 4000,
    });
  });

  it.each([
    [{ plan: "free" }, "Choose Plus or Supporter."],
    [{ storageBlocks: -1 }, "Storage blocks"],
    [{ extraMailboxes: "2" }, "Extra mailboxes"],
    [{ plan: "supporter" }, "how much"],
    [{ supporterAmountMinor: 4000 }, "only with the Supporter plan"],
    [{ plan: "supporter", supporterAmountMinor: 50 }, "whole amount"],
  ])("refuses %j", (input, message) => {
    expect(() => parseChange(input, plus)).toThrow(message);
  });
});

describe("preview and change: add-ons", () => {
  it("previews an increase (charged now, prorated) and a decrease (nothing now)", async () => {
    const w = await subscribed();
    const up = await previewBillingChange(w.d, w.ctx, billingAdmin, ACCOUNT_A, { storageBlocks: 3 });
    expect(up.billed).toBe("now");
    expect(up.amountDueNowMinor).toBeGreaterThan(0);
    expect(up.amountDueNowMinor).toBeLessThanOrEqual(2 * (PLANS.plus.storageBlockPrice?.USD ?? 0));
    expect(await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 0 })).toEqual({
      amountDueNowMinor: 0,
      currency: "USD",
      billed: "renewal",
    });
    expect(w.audit("billing.addons_changed")).toHaveLength(0); // a read: nothing audited
  });

  it("charges an increase only with the confirmed amount", async () => {
    const w = await subscribed();
    const { amountDueNowMinor } = await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { extraMailboxes: 3 });
    await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { extraMailboxes: 3 }, req)).rejects.toMatchObject({
      code: "confirmation_required",
    });
    await expect(
      changeBilling(
        w.d,
        w.ctx,
        owner,
        ACCOUNT_A,
        { extraMailboxes: 3, confirmAmountMinor: amountDueNowMinor - 1 },
        req,
      ),
    ).rejects.toThrow(`charges ${(amountDueNowMinor / 100).toFixed(2)} USD now`);
    expect((await w.sub()).extraMailboxes).toBe(1);
    expect(w.audit("billing.addons_changed").map((e) => e.errorCode)).toEqual([
      "confirmation_required",
      "confirmation_required",
    ]);

    const out = await changeBilling(
      w.d,
      w.ctx,
      owner,
      ACCOUNT_A,
      { extraMailboxes: 3, confirmAmountMinor: amountDueNowMinor },
      req,
    );
    expect(out).toEqual({ amountDueNowMinor, currency: "USD", billed: "now" });
    expect((await w.sub()).extraMailboxes).toBe(3);
    const ok = w.audit("billing.addons_changed").at(-1);
    expect(ok).toMatchObject({ result: "success" });
    expect(ok?.meta).toMatchObject({ extraMailboxesFrom: 1, extraMailboxesTo: 3, chargedNowMinor: amountDueNowMinor });
    expect(w.d.uow.state.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT_A)).toBe(true);
    await w.sync();
    expect((await w.row()).extraMailboxes).toBe(3);
  });

  it("a declined card is a 402 that changes nothing, audited failed", async () => {
    const w = await subscribed();
    await w.fake.setCardFails(w.customerId, true);
    const { amountDueNowMinor } = await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 2 });
    await expect(
      changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 2, confirmAmountMinor: amountDueNowMinor }, req),
    ).rejects.toMatchObject({ code: "card_declined" });
    expect((await w.sub()).storageBlocks).toBe(1);
    expect(w.audit("billing.addons_changed").at(-1)).toMatchObject({ result: "failed", errorCode: "card_declined" });
  });

  it("a decrease renews lower, keeps the capacity paid for this period, and is refused while it wouldn't fit", async () => {
    const w = await subscribed({ storageBlocks: 2, extraMailboxes: 2 });
    w.addMailboxes(PLANS.plus.includedMailboxes + 2);
    await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { extraMailboxes: 1 }, req)).rejects.toMatchObject({
      code: "addon_in_use",
      message: expect.stringContaining("Delete a mailbox first") as unknown,
    });
    expect(w.audit("billing.addons_changed").at(-1)).toMatchObject({ result: "denied", errorCode: "addon_in_use" });
    // Storage: the account assigns more than the smaller pool would hold.
    w.d.uow.state.mailboxes.find((m) => m.accountId === ACCOUNT_A)!.quotaBytes = accountPoolBytes("plus", 2);
    await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 1 }, req)).rejects.toThrow(
      "Lower mailbox storage first",
    );
    // Remove what doesn't fit, and it goes through: nothing charged, renews lower, capacity kept to period end.
    w.d.uow.state.mailboxes = w.d.uow.state.mailboxes.slice(0, PLANS.plus.includedMailboxes);
    for (const m of w.d.uow.state.mailboxes) m.quotaBytes = 1024 ** 3;
    expect(await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { extraMailboxes: 0, storageBlocks: 0 }, req)).toEqual({
      amountDueNowMinor: 0,
      currency: "USD",
      billed: "renewal",
    });
    await w.sync();
    const b = await w.row();
    expect([b.extraMailboxes, b.periodPaidExtraMailboxes]).toEqual([0, 2]);
    expect([b.storageBlocks, b.periodPaidStorageBlocks]).toEqual([0, 2]);
  });

  it("refuses a mix of an increase and a decrease (400 invalid_change), and nothing to change", async () => {
    const w = await subscribed();
    await expect(
      changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 2, extraMailboxes: 0 }, req),
    ).rejects.toMatchObject({ code: "invalid_change" });
    await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, {}, req)).rejects.toMatchObject({
      code: "invalid_change",
    });
  });

  it("no increase while restricted (403 billing_restricted); decreases still go", async () => {
    const w = await subscribed();
    const row = await w.row();
    await w.d.uow.run((r) => r.billing.save({ ...row, state: "restricted" }));
    await expect(previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 3 })).rejects.toMatchObject({
      code: "billing_restricted",
    });
    await expect(
      changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 3, confirmAmountMinor: 1 }, req),
    ).rejects.toMatchObject({ code: "billing_restricted" });
    await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 0 }, req)).resolves.toMatchObject({
      billed: "renewal",
    });
  });
});

describe("preview and change: plans", () => {
  it("switches Plus → Supporter at once (price at renewal) and changes the Supporter amount, each audited", async () => {
    const w = await subscribed();
    await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { plan: "supporter", supporterAmountMinor: 6000 }, req);
    expect(await w.sub()).toMatchObject({ plan: "supporter", planAmountMinor: 6000 });
    expect(w.audit("billing.plan_changed").at(-1)?.meta).toMatchObject({ fromPlan: "plus", toPlan: "supporter" });
    await w.sync();
    expect((await w.row()).paidPlan).toBe("supporter");
    await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { supporterAmountMinor: 3000 }, req);
    expect(w.audit("billing.supporter_amount_changed").at(-1)?.meta).toMatchObject({
      fromMinor: 6000,
      toMinor: 3000,
      chargedNowMinor: 0,
    });
    await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus" }, req);
    expect(await w.sub()).toMatchObject({ plan: "plus", planAmountMinor: PLANS.plus.price?.USD });
  });
});

describe("who may change billing", () => {
  it("403 for Auditors and Members, 404 outside the account, 403 while acting as someone; 409 without a subscription", async () => {
    const w = await subscribed();
    for (const [actor, code] of [
      [auditor, "forbidden"],
      [member, "forbidden"],
      [outsider, "not_found"],
      [{ ...owner, actingAs: actAs(ACCOUNT_A) }, "forbidden"],
    ] as const) {
      await expect(previewBillingChange(w.d, w.ctx, actor, ACCOUNT_A, { storageBlocks: 2 })).rejects.toMatchObject({
        code,
      });
      await expect(changeBilling(w.d, w.ctx, actor, ACCOUNT_A, { storageBlocks: 0 }, req)).rejects.toMatchObject({
        code,
      });
      await expect(cancelSubscription(w.d, w.ctx, actor, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({ code });
      await expect(refundSubscription(w.d, w.ctx, actor, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({ code });
    }
    expect(w.audit("billing.cancel_scheduled").map((e) => e.result)).toEqual(["denied", "denied", "denied"]);
    // A staff grant or a comp has no subscription to change.
    w.d.uow.state.billing = [defaultBilling(ACCOUNT_A, "plus", w.clock.now())];
    await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 0 }, req)).rejects.toMatchObject({
      code: "not_subscribed",
    });
    await expect(cancelSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "not_subscribed",
    });
    await expect(
      previewBillingChange(w.d, { ...w.ctx, provider: null }, owner, ACCOUNT_A, { storageBlocks: 2 }),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
  });
});

describe("paid plans not open on this deployment (run-67 N3)", () => {
  it("refuses previews and changes (503, audited), but cancelling still works", async () => {
    const w = await subscribed();
    const closed = { ...w.ctx, paidPlansOpen: false };
    await expect(previewBillingChange(w.d, closed, owner, ACCOUNT_A, { storageBlocks: 2 })).rejects.toMatchObject({
      code: "billing_unavailable",
    });
    await expect(
      changeBilling(w.d, closed, owner, ACCOUNT_A, { storageBlocks: 2, confirmAmountMinor: 0 }, req),
    ).rejects.toMatchObject({
      code: "billing_unavailable",
      message: "Paid plans aren't open yet. Nothing can be bought for now.",
    });
    expect(w.audit("billing.addons_changed").at(-1)).toMatchObject({ result: "denied", errorCode: "not_open" });
    expect((await w.row()).storageBlocks).toBe(1);
    w.stepUp(owner.userId);
    await expect(cancelSubscription(w.d, closed, owner, ACCOUNT_A, SESSION, req)).resolves.toHaveProperty("cancelAt");
  });
});

describe("cancel and undo", () => {
  it("need a fresh step-up, schedule the end at period end and undo it, each audited", async () => {
    const w = await subscribed();
    await expect(cancelSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect(w.audit("billing.cancel_scheduled").at(-1)).toMatchObject({
      result: "denied",
      errorCode: "step_up_required",
    });
    expect((await w.sub()).cancelAt).toBeNull();
    w.stepUp(owner.userId);
    const out = await cancelSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req);
    expect(out.cancelAt?.getTime()).toBe((await w.sub()).currentPeriodEnd.getTime());
    expect((await w.sub()).cancelAt).not.toBeNull();
    await w.sync();
    expect((await w.row()).state).toBe("active"); // nothing changes until period end
    await expect(cancelSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "invalid_change",
    });
    await undoCancelSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req);
    expect((await w.sub()).cancelAt).toBeNull();
    await w.sync();
    await expect(undoCancelSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "invalid_change",
    });
    expect(w.audit("billing.cancel_undone").map((e) => e.result)).toEqual(["success", "denied"]);
    // Billing Administrators need their own step-up.
    await expect(cancelSubscription(w.d, w.ctx, billingAdmin, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
  });
});

describe("self-service refund", () => {
  it("refunds the first payment within the window, ends the subscription now and the sync lapses the account", async () => {
    const w = await subscribed();
    w.stepUp(owner.userId);
    w.clock.set(new Date(w.clock.now().getTime() + 13 * DAY));
    const out = await refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req);
    expect(out.amountMinor).toBeGreaterThan(0);
    expect(await w.fake.getSubscription(w.customerId)).toBeNull();
    expect(w.audit("billing.refunded").at(-1)?.meta).toMatchObject({
      amountMinor: out.amountMinor,
      currency: "USD",
      withinWindow: true,
      staff: false,
    });
    await w.sync();
    const b = await w.row();
    expect(["lapsed", "free"]).toContain(b.state);
    expect(b.paidPlan).toBeNull();
    // A second press: nothing to refund any more.
    await expect(refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "not_subscribed",
    });
  });

  it("is refused after the window, needs a step-up, and refuses an add-on proration invoice", async () => {
    const w = await subscribed();
    await expect(refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    w.stepUp(owner.userId);
    w.clock.set(new Date(w.clock.now().getTime() + (BILLING.refundWindowDays * DAY + 60_000)));
    await expect(refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toThrow(
      `within ${String(BILLING.refundWindowDays)} days`,
    );
    const w2 = await subscribed();
    w2.stepUp(owner.userId);
    const { amountDueNowMinor } = await previewBillingChange(w2.d, w2.ctx, owner, ACCOUNT_A, { storageBlocks: 2 });
    await changeBilling(
      w2.d,
      w2.ctx,
      owner,
      ACCOUNT_A,
      { storageBlocks: 2, confirmAmountMinor: amountDueNowMinor },
      req,
    );
    await expect(refundSubscription(w2.d, w2.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toThrow(
      "Only the first payment or a renewal",
    );
    expect(w2.audit("billing.refunded").at(-1)).toMatchObject({ result: "denied", errorCode: "refund_not_eligible" });
    expect(await w2.fake.getSubscription(w2.customerId)).not.toBeNull();
  });

  it("is refused while a dispute is open", async () => {
    const w = await subscribed();
    w.stepUp(owner.userId);
    await w.fake.openDispute(w.customerId);
    await expect(refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toThrow("disputed");
    await w.sync();
    await expect(refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toThrow("disputed");
  });

  it("finishes the cancellation when the refund went through but the cancel didn't (a retry never refunds twice)", async () => {
    const w = await subscribed();
    w.stepUp(owner.userId);
    await w.fake.refundLatest(w.customerId); // refunded, subscription still live
    const out = await refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req);
    expect(out.amountMinor).toBeGreaterThan(0);
    expect(await w.fake.getSubscription(w.customerId)).toBeNull();
    expect(w.audit("billing.refunded").at(-1)?.meta).toMatchObject({ resumed: true });
  });
});

describe("capacity already paid for this period", () => {
  it("adding back up to what was paid this period is free; adding beyond it after a decrease is refused until restored", async () => {
    const w = await subscribed({ storageBlocks: 2 });
    await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 0 }, req);
    await w.sync();
    expect([(await w.row()).storageBlocks, (await w.row()).periodPaidStorageBlocks]).toEqual([0, 2]);
    // Back to 2: nothing charged now (paid for already), no confirmation needed.
    expect(await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 2 })).toMatchObject({
      amountDueNowMinor: 0,
      billed: "renewal",
    });
    // Straight to 3 would be prorated from 0: refused, restore first.
    await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 3 }, req)).rejects.toThrow(
      "Go back to 2 storage blocks first",
    );
    expect(await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 2 }, req)).toMatchObject({
      amountDueNowMinor: 0,
    });
    expect((await w.sub()).storageBlocks).toBe(2);
    expect((await w.sub()).latestInvoice?.billingReason).toBe("subscription_create"); // no new invoice
    await w.sync();
    // Above the paid quantity is charged as usual.
    const { amountDueNowMinor } = await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 3 });
    expect(amountDueNowMinor).toBeGreaterThan(0);
  });
});

describe("paid capacity belongs to its period (security review run-62 F1)", () => {
  it.each([
    ["storageBlocks", 3],
    ["extraMailboxes", 2],
  ] as const)(
    "%s: decrease → renewal → re-increase is charged, before and after the renewal invoice is synced",
    async (kind, n) => {
      const w = await subscribed({ storageBlocks: 0, extraMailboxes: 0, [kind]: n });
      await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { [kind]: 0 }, req);
      await w.sync();
      // The renewal bills 0 and is paid; our row hasn't synced it yet (webhook latency).
      await w.fake.advanceClock(366);
      const before = await w.row();
      expect(before.periodPaidFor?.getTime()).toBe(before.currentPeriodEnd?.getTime()); // still the old period
      const stale = await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { [kind]: n });
      expect(stale.billed).toBe("now");
      expect(stale.amountDueNowMinor).toBeGreaterThan(0);
      await expect(changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { [kind]: n }, req)).rejects.toMatchObject({
        code: "confirmation_required",
      });
      // After the sync: the paid 0-quantity renewal invoice sets the period's paid quantity to 0, for the new period.
      await w.sync();
      const after = await w.row();
      expect(kind === "storageBlocks" ? after.periodPaidStorageBlocks : after.periodPaidExtraMailboxes).toBe(0);
      expect(after.periodPaidFor?.getTime()).toBe((await w.sub()).currentPeriodEnd.getTime());
      expect((await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { [kind]: n })).billed).toBe("now");
    },
  );

  it("an unpaid renewal (card failing) doesn't make the old period's capacity free again", async () => {
    const w = await subscribed({ storageBlocks: 3 });
    await changeBilling(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 0 }, req);
    await w.sync();
    await w.fake.setCardFails(w.customerId, true);
    await w.fake.advanceClock(366);
    await w.sync();
    expect((await w.row()).state).toBe("past_due");
    expect((await w.row()).periodPaidStorageBlocks).toBe(3); // tagged with the old period
    const { entitled } = await billingOverview(w.d, w.ctx, owner, ACCOUNT_A);
    expect(entitled.storageBlocks).toBe(0);
    expect((await previewBillingChange(w.d, w.ctx, owner, ACCOUNT_A, { storageBlocks: 3 })).billed).toBe("now");
  });
});

describe("one self-service refund per account (security review run-62 F2)", () => {
  it("a second refund after resubscribing is refused with a pointer to staff; the subscription stays", async () => {
    const w = await subscribed();
    w.stepUp(owner.userId);
    await refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req);
    await w.sync();
    expect((await w.row()).selfServiceRefundAt).toEqual(w.clock.now());
    // Subscribe again a day later and ask for a refund inside the new window.
    w.clock.set(new Date(w.clock.now().getTime() + DAY));
    const { url } = await startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
    await w.fake.completeCheckout(url.split("/").pop() ?? "", "pay");
    await w.sync();
    expect((await w.row()).state).toBe("active");
    await expect(refundSubscription(w.d, w.ctx, owner, ACCOUNT_A, SESSION, req)).rejects.toThrow(
      "already had its self-service refund",
    );
    expect(w.audit("billing.refunded").at(-1)).toMatchObject({ result: "denied", errorCode: "refund_not_eligible" });
    expect(await w.fake.getSubscription(w.customerId)).not.toBeNull();
    expect((await billingOverview(w.d, w.ctx, owner, ACCOUNT_A)).refund.mayBeEligible).toBe(false);
  });
});
