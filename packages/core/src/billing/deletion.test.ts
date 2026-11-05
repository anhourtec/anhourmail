// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing when an account is deleted (ADR-0029 §9, ADR-0025) against the in-memory repositories and the fake
 * provider: asking sets the subscription to end at the period's end (audited, once), the hourly timers retry a request
 * whose provider call failed, removal ends it now before anything else starts, and a provider failure or billing off
 * makes removal wait (audited) rather than leave a deleted account paying. Grants and comps need nothing.
 */
import { describe, expect, it } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import { ACCOUNT_A, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";
import { requestAccountDeletion, runDueDeletions } from "../data/deletion-service";

import { startCheckout } from "./checkout";
import { cancelBillingForDeletion } from "./deletion";
import type { BillingContext } from "./guards";
import { runBillingTimers } from "./lapse";
import { type BillingProvider, BillingProviderError } from "./ports";
import { syncAccountBilling } from "./sync";

const APP = "http://localhost:43200";
const DAY = 86_400_000;
const SESSION = { sessionId: "owner-session" };
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });

function world() {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free" });
  s.memberships.push({ userId: owner.userId, accountId: ACCOUNT_A, role: "owner" });
  s.stepUps.push({ userId: owner.userId, sessionId: SESSION.sessionId, expiresAt: new Date("2099-01-01") });
  const fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("deletion-test"),
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  const ctx: BillingContext = { provider: fake, appUrl: APP, redirectOrigins: [APP], paidPlansOpen: true };
  const inAccount = (action: string) =>
    s.audit.filter((e) => e.action === action && e.scope === `account:${ACCOUNT_A}`);
  const down: BillingProvider = {
    ...fake,
    getSubscription: () => Promise.reject(new BillingProviderError("unavailable", "down")),
  };
  return { clock, d, s, fake, ctx, inAccount, down };
}

async function paying() {
  const w = world();
  const { url } = await startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
  await w.fake.completeCheckout(url.split("/").pop() ?? "", "pay");
  await w.fake.drainDeliveries();
  await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
  const customerId = (await w.d.uow.run((r) => r.billing.get(ACCOUNT_A)))?.providerCustomerId ?? "";
  const subscription = async () => (await w.fake.describe("customer", customerId))?.subscription;
  return { ...w, customerId, subscription };
}

const ask = (w: ReturnType<typeof world>, provider: BillingProvider | null) =>
  requestAccountDeletion(w.d, owner, ACCOUNT_A, { confirmName: "Acme" }, SESSION, req, provider);

describe("asking to delete the account", () => {
  it("sets a paid subscription to end at the period's end, audited with the reason; the sync records it", async () => {
    const w = await paying();
    await ask(w, w.fake);
    expect(await w.subscription()).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(w.inAccount("billing.cancel_scheduled").at(-1)).toMatchObject({
      result: "success",
      meta: { reason: "account_deletion" },
    });
    expect(w.inAccount("billing.cancel_scheduled").at(-1)?.actor).toMatchObject({ email: "account-deletion" });
    expect(w.s.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT_A)).toBe(true);
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    expect((await w.d.uow.run((r) => r.billing.get(ACCOUNT_A)))?.cancelAt).not.toBeNull();
  });

  it("a provider failure never stops the deletion; the hourly timers set it later, once", async () => {
    const w = await paying();
    await ask(w, w.down);
    expect((await w.d.uow.run((r) => r.dataLifecycle.getDeletion(ACCOUNT_A)))?.startedAt).toBeNull();
    expect((await w.subscription())?.cancelAtPeriodEnd).toBe(false);
    const run = await runBillingTimers(w.d, w.fake);
    expect(run).toMatchObject({ deletionCancels: 1, deletionCancelsFailed: 0 });
    expect((await w.subscription())?.cancelAtPeriodEnd).toBe(true);
    // Once our row knows (after the sync), the timers leave it alone.
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    expect((await runBillingTimers(w.d, w.fake)).deletionCancels).toBe(0);
    expect(w.inAccount("billing.cancel_scheduled").filter((e) => e.meta.reason === "account_deletion")).toHaveLength(1);
  });

  it("a retry has its own intent: undone outside the console, the request's replayed answer is never taken for it", async () => {
    const w = await paying();
    await ask(w, w.fake);
    const d = await w.d.uow.run((r) => r.dataLifecycle.getDeletion(ACCOUNT_A));
    // Undone in the portal (outside our console), before our row heard of the cancellation.
    await w.fake.undoCancel({ subscriptionId: (await w.subscription())?.id ?? "", intentId: "portal-undo" });
    // The request's own key again is a replay: nothing changes, and nothing is audited as scheduled.
    expect(await cancelBillingForDeletion(w.d, w.fake, ACCOUNT_A, "period_end", d!)).toBe("failed");
    expect((await w.subscription())?.cancelAtPeriodEnd).toBe(false);
    expect(w.inAccount("billing.cancel_scheduled").filter((e) => e.meta.reason === "account_deletion")).toHaveLength(1);
    // The hourly retry uses its own intent and really sets it again.
    expect((await runBillingTimers(w.d, w.fake)).deletionCancels).toBe(1);
    expect((await w.subscription())?.cancelAtPeriodEnd).toBe(true);
    expect(w.inAccount("billing.cancel_scheduled").filter((e) => e.meta.reason === "account_deletion")).toHaveLength(2);
    // Within the same hour the retry's key replays too: undone again, it isn't counted as scheduled.
    await w.fake.undoCancel({ subscriptionId: (await w.subscription())?.id ?? "", intentId: "portal-undo-2" });
    expect((await runBillingTimers(w.d, w.fake)).deletionCancelsFailed).toBe(1);
    w.clock.set(new Date(w.clock.now().getTime() + 3_600_000));
    expect((await runBillingTimers(w.d, w.fake)).deletionCancels).toBe(1);
  });

  it("the timers count a provider that still fails", async () => {
    const w = await paying();
    await ask(w, null);
    expect((await runBillingTimers(w.d, w.down)).deletionCancelsFailed).toBe(1);
  });

  it("nothing to cancel: never paid, a staff grant, or an ended subscription", async () => {
    const w = world();
    const at = { deleteAfter: new Date() };
    expect(await cancelBillingForDeletion(w.d, w.fake, ACCOUNT_A, "period_end", at)).toBe("none");
    expect(await cancelBillingForDeletion(w.d, null, ACCOUNT_A, "now", at)).toBe("none");
    const p = await paying();
    await p.fake.cancel({ subscriptionId: (await p.subscription())?.id ?? "", when: "now", intentId: "x" });
    expect(await cancelBillingForDeletion(p.d, p.fake, ACCOUNT_A, "now", at)).toBe("none");
  });

  it("already ending at the period's end: nothing more", async () => {
    const w = await paying();
    await ask(w, w.fake);
    const d = await w.d.uow.run((r) => r.dataLifecycle.getDeletion(ACCOUNT_A));
    expect(await cancelBillingForDeletion(w.d, w.fake, ACCOUNT_A, "period_end", d!)).toBe("already");
  });
});

describe("removal after the grace period", () => {
  it("ends the subscription now before removal starts (audited), then removes as before", async () => {
    const w = await paying();
    await ask(w, w.fake);
    w.clock.set(new Date(w.clock.now().getTime() + 40 * DAY));
    const steps = await runDueDeletions(w.d, 10, w.fake);
    expect(steps).toEqual([{ accountId: ACCOUNT_A, step: "started" }]);
    expect((await w.subscription())?.status).toBe("canceled");
    expect(w.inAccount("billing.subscription_ended").at(-1)).toMatchObject({
      result: "success",
      meta: { reason: "account_deletion" },
    });
  });

  it("a past-due renewal's open invoice is voided when removal ends the subscription", async () => {
    const w = await paying();
    await w.fake.setCardFails(w.customerId, true);
    await w.fake.renewNow(w.customerId);
    await ask(w, w.fake);
    expect((await w.subscription())?.latestInvoice?.status).toBe("open");
    w.clock.set(new Date(w.clock.now().getTime() + 40 * DAY));
    expect(await runDueDeletions(w.d, 10, w.fake)).toEqual([{ accountId: ACCOUNT_A, step: "started" }]);
    expect(await w.subscription()).toMatchObject({ status: "canceled", latestInvoice: { status: "void" } });
  });

  it("waits while the provider can't end it, audited once a day as billing_pending; then goes on", async () => {
    const w = await paying();
    await ask(w, w.fake);
    w.clock.set(new Date(w.clock.now().getTime() + 40 * DAY));
    expect(await runDueDeletions(w.d, 10, w.down)).toEqual([{ accountId: ACCOUNT_A, step: "waiting_for_billing" }]);
    expect(await runDueDeletions(w.d, 10, w.down)).toEqual([{ accountId: ACCOUNT_A, step: "waiting_for_billing" }]);
    const waits = w.inAccount("data.deletion_started").filter((e) => e.result === "denied");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ errorCode: "billing_pending", meta: { waitingFor: "billing_pending" } });
    expect((await w.d.uow.run((r) => r.dataLifecycle.getDeletion(ACCOUNT_A)))?.startedAt).toBeNull();
    // Billing off while our row says the account pays: it waits too.
    expect(await runDueDeletions(w.d, 10, null)).toEqual([{ accountId: ACCOUNT_A, step: "waiting_for_billing" }]);
    expect(await runDueDeletions(w.d, 10, w.fake)).toEqual([{ accountId: ACCOUNT_A, step: "started" }]);
  });

  it("a Free account starts at once with billing off", async () => {
    const w = world();
    await ask(w, null);
    w.clock.set(new Date(w.clock.now().getTime() + 40 * DAY));
    expect(await runDueDeletions(w.d, 10, null)).toEqual([{ accountId: ACCOUNT_A, step: "started" }]);
  });
});
