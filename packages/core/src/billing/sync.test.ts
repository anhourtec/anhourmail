// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webhook ingestion, `billing.sync`, `billing.resolve` and the nightly reconcile (ADR-0029 §4) against the in-memory
 * repositories and the fake provider, driven through the real signature scheme. Covers duplicates, reordering, an
 * outage that changes nothing, per-dispute tracking (a won dispute never clears another lost one), dispute orphans
 * resolved through the provider, holds on lapse and lift, and the audit entries in the same unit of work.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import { deps as makeDeps, fixedClock, TEST_PLATFORM } from "../__tests__/helpers";
import type { MailServer } from "../provisioning/ports";
import { runNextJob } from "../provisioning/service";

import { defaultBilling } from "./lifecycle";
import { ingestBillingEvent } from "./ingest";
import { type BillingProvider, BillingProviderError, type ProviderEvent } from "./ports";
import { reconcileBilling, resolveOrphanEvent, syncAccountBilling } from "./sync";

const SECRET = fakeWebhookSecret("sync-test-seed");
const DAY = 86_400_000;

async function world() {
  const clock = fixedClock("2026-11-04T12:00:00Z");
  const d = makeDeps(clock);
  const provider = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: "http://localhost:43200",
    webhookSecret: SECRET,
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  const ownerId = `owner-${randomUUID()}`;
  const accountId = await d.uow.run(async (r) => {
    const { id } = await r.accounts.create({ name: "Billing sync", plan: "free" });
    await r.accounts.addMember({ accountId: id, userId: ownerId, role: "owner" });
    for (const [local, userId] of [
      ["owner", ownerId],
      ["second", null],
    ] as const) {
      await r.mailboxes.insert({
        id: randomUUID(),
        accountId: id,
        userId,
        address: `${local}-${id.slice(0, 8)}@${TEST_PLATFORM.domain}`,
        status: "active",
        quotaBytes: 1024 ** 3,
        stalwartId: `s-${local}`,
        lastError: null,
        purgeAfter: null,
        createdAt: new Date(clock.now().getTime() - (local === "owner" ? 2 : 1) * DAY),
      });
    }
    return id;
  });
  const { customerId } = await provider.ensureCustomer({ accountId, email: "o@example.test", name: "O" });
  await d.uow.run(async (r) => {
    const b = (await r.billing.get(accountId)) ?? defaultBilling(accountId, "free", clock.now());
    await r.billing.save({ ...b, providerCustomerId: customerId });
  });

  /** Signed deliveries → verify → ingest, as the webhook route does. */
  const deliver = async (): Promise<ProviderEvent[]> => {
    const out: ProviderEvent[] = [];
    for (const { body, signature } of await provider.drainDeliveries()) {
      const e = provider.verifyWebhook(body, signature, clock.now());
      await ingestBillingEvent(d, e, clock.now());
      out.push(e);
    }
    return out;
  };
  const subscribe = async () => {
    const { url } = await provider.createCheckout({
      accountId,
      customerId,
      currency: "USD",
      plan: "plus",
      storageBlocks: 1,
      extraMailboxes: 0,
      successUrl: "http://localhost/s",
      cancelUrl: "http://localhost/c",
      intentId: randomUUID(),
    });
    await provider.completeCheckout(decodeURIComponent(url.split("/").pop() ?? ""), "pay");
  };
  const billing = () => d.uow.run((r) => r.billing.get(accountId));
  const audit = () =>
    d.uow.state.audit.filter((e) => e.scope === `account:${accountId}`).map((e) => `${e.action}:${e.result}`);
  return { clock, d, provider, accountId, customerId, deliver, subscribe, billing, audit };
}

describe("webhook ingestion (ADR-0029 §4)", () => {
  it("records each event once and queues one sync per account; unknown types are dropped unstored", async () => {
    const w = await world();
    await w.subscribe();
    const events = await w.deliver();
    expect(events.map((e) => e.type)).toEqual([
      "checkout.session.completed",
      "customer.subscription.created",
      "invoice.paid",
    ]);
    expect(w.d.uow.state.billingEvents.map((e) => e.status)).toEqual(["queued", "queued", "queued"]);
    // One queued job for the account, however many events (coalesced).
    expect(w.d.uow.state.jobs.filter((j) => j.kind === "billing.sync" && j.subjectId === w.accountId)).toHaveLength(1);
    // A redelivery is a duplicate: nothing new.
    const first = events[0];
    if (!first) throw new Error("no event");
    expect(await ingestBillingEvent(w.d, first, w.clock.now())).toBe("duplicate");
    expect(w.d.uow.state.billingEvents).toHaveLength(3);
    expect(await ingestBillingEvent(w.d, { ...first, id: "evt_other", type: "customer.updated" }, w.clock.now())).toBe(
      "ignored",
    );
    expect(w.d.uow.state.billingEvents).toHaveLength(3);
    // Ingestion audits nothing: the sync audits what changes.
    expect(w.audit()).toEqual([]);
  });

  it("an unknown customer, or a hint that names another account, is an orphan: no sync queued", async () => {
    const w = await world();
    const base: ProviderEvent = {
      id: "evt_1",
      type: "invoice.paid",
      createdAt: w.clock.now(),
      livemode: false,
      customerId: "cus_unknown",
      objectId: "in_1",
      paymentIntentId: null,
      chargeId: null,
      accountIdHint: null,
    };
    expect(await ingestBillingEvent(w.d, base, w.clock.now())).toBe("orphan");
    expect(
      await ingestBillingEvent(
        w.d,
        { ...base, id: "evt_2", customerId: w.customerId, accountIdHint: randomUUID() },
        w.clock.now(),
      ),
    ).toBe("orphan");
    expect(w.d.uow.state.billingEvents.map((e) => [e.status, e.accountId])).toEqual([
      ["orphan", null],
      ["orphan", null],
    ]);
    expect(w.d.uow.state.jobs).toEqual([]);
  });
});

describe("billing.sync", () => {
  it("checkout paid → active Plus: the row, the effective plan and the audit entries, in one unit of work", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    const out = await syncAccountBilling(w.d, w.provider, w.accountId);
    expect(out).toMatchObject({ status: "synced" });
    expect(await w.billing()).toMatchObject({
      state: "active",
      planSource: "stripe",
      paidPlan: "plus",
      storageBlocks: 1,
    });
    expect((await w.d.uow.run((r) => r.accounts.get(w.accountId)))?.plan).toBe("plus");
    expect(w.d.uow.state.billingEvents.every((e) => e.status === "processed")).toBe(true);
    expect(w.audit()).toEqual([
      "billing.state_changed:success",
      "billing.plan_changed:success",
      "billing.addons_changed:success",
      "billing.payment_succeeded:success",
      "trust.tier_changed:success",
    ]);
    const state = w.d.uow.state.audit.find((e) => e.action === "billing.state_changed");
    expect(state?.meta).toEqual({ fromState: "free", toState: "active", reason: "checkout_paid" });
    expect(state?.actor).toMatchObject({ type: "system", email: "billing-sync" });
    // Paying promotes the new account to standard at once (ADR-0034 §2), in the same unit of work, by the sync.
    const tier = w.d.uow.state.audit.find((e) => e.action === "trust.tier_changed");
    expect(tier?.meta).toEqual({ fromTier: "new", toTier: "standard", source: "billing", mailboxesQueued: 2 });
    expect(tier?.actor).toMatchObject({ type: "system", email: "billing-sync" });
    expect(await w.d.uow.run((r) => r.trust.get(w.accountId))).toMatchObject({ tier: "standard", source: "billing" });
    // Its mailboxes are queued so the mail server lets mail apps send.
    expect(w.d.uow.state.jobs.filter((j) => j.kind === "mailbox.ensure")).toHaveLength(2);
    // A second run with nothing new changes nothing and audits nothing.
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect(w.audit()).toHaveLength(5);
  });

  it("paying leaves a staff-set or restricted tier alone, and a lapse never lowers a promoted one", async () => {
    for (const row of [
      { tier: "new" as const, source: "staff" as const },
      { tier: "restricted" as const, source: "staff" as const },
    ]) {
      const w = await world();
      w.d.uow.state.trust.push({
        accountId: w.accountId,
        ...row,
        since: w.d.clock.now(),
        reason: null,
        note: null,
        setBy: "ga",
        lastRestrictedAt: null,
      });
      await w.subscribe();
      await w.deliver();
      await syncAccountBilling(w.d, w.provider, w.accountId);
      expect((await w.billing())?.state).toBe("active");
      expect((await w.d.uow.run((r) => r.trust.get(w.accountId)))?.tier).toBe(row.tier);
      expect(w.audit()).not.toContain("trust.tier_changed:success");
    }
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    const sub = await w.provider.getSubscription(w.customerId);
    await w.provider.cancel({ subscriptionId: sub?.subscriptionId ?? "", when: "period_end", intentId: randomUUID() });
    await w.provider.advanceClock(366);
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect((await w.billing())?.state).toBe("lapsed");
    expect((await w.d.uow.run((r) => r.trust.get(w.accountId)))?.tier).toBe("standard");
  });

  it("past due → retries exhausted → restricted: every mailbox's access is re-applied; paying lifts it", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    await w.provider.setCardFails(w.customerId, true);
    await w.provider.advanceClock(366);
    w.clock.set(new Date(w.clock.now().getTime() + 60_000)); // real time moves on a little
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect((await w.billing())?.state).toBe("past_due");
    await w.provider.exhaustRetries(w.customerId);
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect(await w.billing()).toMatchObject({ state: "restricted" });
    expect(w.d.uow.state.jobs.filter((j) => j.kind === "mailbox.ensure").map((j) => j.status)).toEqual([
      "queued",
      "queued",
    ]);
    await w.provider.setCardFails(w.customerId, false);
    await w.provider.payOpenInvoice(w.customerId);
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect((await w.billing())?.state).toBe("active");
    expect(w.audit()).toContain("billing.payment_failed:success");
  });

  it("a provider outage throws before anything is written: no state change, events stay queued", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    const down: BillingProvider = {
      ...w.provider,
      getSubscription: () => Promise.reject(new BillingProviderError("unavailable", "down")),
    };
    await expect(syncAccountBilling(w.d, down, w.accountId)).rejects.toThrow(BillingProviderError);
    expect(await w.billing()).toMatchObject({ state: "free", lastSyncedAt: null });
    expect(w.d.uow.state.billingEvents.every((e) => e.status === "queued")).toBe(true);
    expect(w.audit()).toEqual([]);
  });

  it("catalogue drift or two live subscriptions: audited as sync_failed (platform), state unchanged", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    const drift: BillingProvider = {
      ...w.provider,
      getSubscription: () => Promise.reject(new BillingProviderError("catalogue_drift", "unknown price")),
    };
    expect(await syncAccountBilling(w.d, drift, w.accountId)).toEqual({ status: "failed", code: "catalogue_drift" });
    expect((await w.billing())?.state).toBe("free");
    const failed = w.d.uow.state.audit.find((e) => e.action === "billing.sync_failed");
    expect(failed).toMatchObject({ scope: "platform", meta: { accountId: w.accountId, error: "catalogue_drift" } });
  });

  it("reordered events end in the same state as ordered ones", async () => {
    const a = await world();
    await a.subscribe();
    await a.deliver();
    const b = await world();
    await b.subscribe();
    const deliveries = await b.provider.drainDeliveries();
    for (const { body, signature } of [...deliveries].reverse()) {
      await ingestBillingEvent(b.d, b.provider.verifyWebhook(body, signature, b.clock.now()), b.clock.now());
    }
    await syncAccountBilling(a.d, a.provider, a.accountId);
    await syncAccountBilling(b.d, b.provider, b.accountId);
    const pick = (x: Awaited<ReturnType<typeof a.billing>>) => ({
      state: x?.state,
      paidPlan: x?.paidPlan,
      storageBlocks: x?.storageBlocks,
    });
    expect(pick(await b.billing())).toEqual(pick(await a.billing()));
  });

  it("an account that is gone is skipped; with billing off the job does nothing", async () => {
    const w = await world();
    expect(await syncAccountBilling(w.d, w.provider, randomUUID())).toEqual({ status: "no_account" });
    await w.subscribe();
    await w.deliver();
    const mail = {} as MailServer; // billing jobs never touch the mail server
    const job = await runNextJob(w.d, mail, { billing: null });
    expect(job).toMatchObject({ kind: "billing.sync", lockLost: false });
    expect((await w.billing())?.state).toBe("free");
    expect(w.d.uow.state.billingEvents.every((e) => e.status === "queued")).toBe(true);
  });

  it("runs as a queue job with the provider", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    const job = await runNextJob(w.d, {} as MailServer, { billing: w.provider });
    expect(job).toMatchObject({ kind: "billing.sync", lockLost: false });
    expect(w.d.uow.state.jobs.find((j) => j.id === job?.id)?.status).toBe("succeeded");
    expect((await w.billing())?.state).toBe("active");
  });

  it("cancel at period end → lapsed with holds (nothing deleted) → resubscribe lifts every hold", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    const sub = await w.provider.getSubscription(w.customerId);
    await w.provider.cancel({ subscriptionId: sub?.subscriptionId ?? "", when: "period_end", intentId: randomUUID() });
    await w.provider.advanceClock(366);
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect(await w.billing()).toMatchObject({ state: "lapsed", paidPlan: null });
    const holds = await w.d.uow.run((r) => r.billing.holds(w.accountId));
    // The Owner's platform mailbox stays; the second one is held (receiving for a while, never deleted).
    expect(holds.map((h) => h.subjectType)).toEqual(["mailbox"]);
    expect(w.d.uow.state.mailboxes).toHaveLength(2);
    expect(w.audit()).toContain("billing.holds_applied:success");
    expect(w.d.uow.state.audit.find((e) => e.action === "billing.holds_applied")?.meta).toEqual({
      mailboxes: 1,
      domains: 0,
      aliases: 0,
    });
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect((await w.billing())?.state).toBe("active");
    expect(await w.d.uow.run((r) => r.billing.holds(w.accountId))).toEqual([]);
    expect(w.audit()).toContain("billing.holds_lifted:success");
  });
});

describe("disputes, one by one", () => {
  it("dispute events are orphans resolved through the provider, then sync: restricted at once", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    await w.provider.openDispute(w.customerId);
    const [opened] = await w.deliver();
    const orphan = w.d.uow.state.billingEvents.find((e) => e.providerEventId === opened?.id);
    expect(orphan).toMatchObject({ status: "orphan", accountId: null });
    const resolve = w.d.uow.state.jobs.find((j) => j.kind === "billing.resolve");
    expect(resolve?.subjectId).toBe(orphan?.id);
    expect(await resolveOrphanEvent(w.d, w.provider, orphan?.id ?? "")).toBe("adopted");
    expect(await resolveOrphanEvent(w.d, w.provider, orphan?.id ?? "")).toBe("skipped");
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect(await w.billing()).toMatchObject({ state: "restricted" });
    expect(w.audit()).toContain("billing.dispute_opened:success");
  });

  it("a won dispute never clears another one that was lost (the residual, fixed)", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    const adoptAll = async () => {
      for (const e of w.d.uow.state.billingEvents.filter((x) => x.status === "orphan")) {
        await resolveOrphanEvent(w.d, w.provider, e.id);
      }
      await syncAccountBilling(w.d, w.provider, w.accountId);
    };
    // Dispute 1 on the first payment: lost.
    await w.provider.openDispute(w.customerId);
    await w.provider.closeDispute(w.customerId, "lost");
    await w.deliver();
    await adoptAll();
    expect((await w.billing())?.state).toBe("restricted");
    // The renewal is paid; dispute 2 on it opens, then is won.
    await w.provider.advanceClock(366);
    w.clock.set(new Date(w.clock.now().getTime() + 60_000));
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    await w.provider.openDispute(w.customerId);
    await w.provider.closeDispute(w.customerId, "won");
    await w.deliver();
    await adoptAll();
    const disputes = await w.d.uow.run((r) => r.billing.disputes(w.accountId));
    expect(disputes.map((x) => x.status)).toEqual(["lost", "won"]);
    expect((await w.billing())?.state).toBe("restricted");
    expect(w.d.uow.state.audit.filter((e) => e.action === "billing.dispute_closed").map((e) => e.meta.outcome)).toEqual(
      ["lost", "won"],
    );
  });

  it("an open dispute whose close event never arrives heals on the next sync (fresh read)", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    await w.provider.openDispute(w.customerId);
    await w.deliver();
    for (const e of w.d.uow.state.billingEvents.filter((x) => x.status === "orphan")) {
      await resolveOrphanEvent(w.d, w.provider, e.id);
    }
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect((await w.billing())?.state).toBe("restricted");
    await w.provider.closeDispute(w.customerId, "won");
    await w.provider.drainDeliveries(); // the close is lost
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect((await w.billing())?.state).toBe("active");
    expect(w.audit()).toContain("billing.dispute_closed:success");
  });

  it("an unresolvable dispute stays an orphan (provider down, unknown customer); never dropped", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await w.provider.openDispute(w.customerId);
    await w.deliver();
    const orphan = w.d.uow.state.billingEvents.find((e) => e.status === "orphan");
    const down: BillingProvider = {
      ...w.provider,
      getDispute: () => Promise.reject(new BillingProviderError("unavailable", "down")),
    };
    await expect(resolveOrphanEvent(w.d, down, orphan?.id ?? "")).rejects.toThrow(BillingProviderError);
    const stranger: BillingProvider = {
      ...w.provider,
      getDispute: async (id) => ({ id, status: "open", customerId: "cus_stranger", paymentIntentId: null }),
    };
    expect(await resolveOrphanEvent(w.d, stranger, orphan?.id ?? "")).toBe("unresolved");
    const gone: BillingProvider = {
      ...w.provider,
      getDispute: () => Promise.reject(new BillingProviderError("not_found", "no such dispute")),
    };
    expect(await resolveOrphanEvent(w.d, gone, orphan?.id ?? "")).toBe("unresolved");
    expect(w.d.uow.state.billingEvents.find((e) => e.id === orphan?.id)?.status).toBe("orphan");
  });
});

describe("billing.reconcile (nightly)", () => {
  it("queues syncs for stale accounts, resolves dispute orphans, prunes old processed events", async () => {
    const w = await world();
    await w.subscribe();
    await w.deliver();
    await syncAccountBilling(w.d, w.provider, w.accountId);
    await w.provider.openDispute(w.customerId);
    await w.deliver();
    // A day later: the account is stale and the dispute orphan is still there.
    w.clock.set(new Date(w.clock.now().getTime() + 25 * 3600_000));
    w.d.uow.state.jobs = [];
    const run = await reconcileBilling(w.d, w.provider);
    expect(run).toMatchObject({ syncsQueued: 1, orphansAdopted: 1, orphansLeft: 0 });
    expect(w.d.uow.state.jobs.filter((j) => j.kind === "billing.sync")).toHaveLength(1);
    w.clock.set(new Date(w.clock.now().getTime() + 40 * DAY));
    await syncAccountBilling(w.d, w.provider, w.accountId);
    expect((await reconcileBilling(w.d, w.provider)).pruned).toBeGreaterThan(0);
  });
});
