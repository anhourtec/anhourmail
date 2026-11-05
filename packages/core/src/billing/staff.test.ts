// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Platform billing actions (ADR-0029 §9, slice 12 remainder) against the in-memory repositories and the fake
 * provider: clearing disputes (the provider's and ours, never restricting again), re-sync now and dismissing an orphan,
 * each with its permission (403), scope (404), act-as and step-up refusals, and every staff action recorded in the
 * account's own log as staff (rule 49) or, for an orphan, in the platform log.
 */
import { describe, expect, it } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import { ACCOUNT_A, actAs, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";

import { startCheckout } from "./checkout";
import type { BillingContext } from "./guards";
import { ingestBillingEvent } from "./ingest";
import { clearDisputes, dismissBillingOrphan, resyncAccountBilling } from "./staff";
import { syncAccountBilling } from "./sync";

const APP = "http://localhost:43200";
const SESSION = { sessionId: "staff-session" };
const billingStaff = user({ id: "staff-billing", platform: ["billing_admin"] });
const support = user({ id: "staff-support", platform: ["support_admin"] });
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const UNKNOWN = "33333333-3333-4333-8333-333333333333";
const NONE = { disputeIds: [] as string[] };

/** The open or lost disputes the staff panel shows for the account. */
const shown = async (w: { d: ReturnType<typeof makeDeps> }) => ({
  disputeIds: (await w.d.uow.run((r) => r.billing.disputes(ACCOUNT_A)))
    .filter((d) => d.status === "open" || d.status === "lost")
    .map((d) => d.disputeId),
});

function world() {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free" });
  s.memberships.push({ userId: owner.userId, accountId: ACCOUNT_A, role: "owner" });
  s.stepUps.push({ userId: billingStaff.userId, sessionId: SESSION.sessionId, expiresAt: new Date("2099-01-01") });
  const fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("staff-test"),
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  const ctx: BillingContext = { provider: fake, appUrl: APP, redirectOrigins: [APP], paidPlansOpen: true };
  const row = async () => (await d.uow.run((r) => r.billing.get(ACCOUNT_A)))!;
  const inAccount = (action: string) =>
    s.audit.filter((e) => e.action === action && e.scope === `account:${ACCOUNT_A}`);
  const inPlatform = (action: string) => s.audit.filter((e) => e.action === action && e.scope === "platform");
  /** Delivers the fake's signed events through ingestion, as the webhook route does. */
  const deliver = async () => {
    for (const x of await fake.drainDeliveries()) {
      await ingestBillingEvent(d, fake.verifyWebhook(x.body, x.signature, clock.now()), clock.now());
    }
  };
  return { clock, d, s, fake, ctx, row, inAccount, inPlatform, deliver };
}

/** An account paying for Plus through the fake, synced. */
async function paying() {
  const w = world();
  const { url } = await startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
  await w.fake.completeCheckout(url.split("/").pop() ?? "", "pay");
  await w.deliver();
  await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
  const customerId = (await w.row()).providerCustomerId ?? "";
  return { ...w, customerId };
}

describe("clearDisputes", () => {
  it("clears a lost dispute: sending comes back on the next sync and the dispute never restricts again", async () => {
    const w = await paying();
    await w.fake.openDispute(w.customerId);
    await w.fake.closeDispute(w.customerId, "lost");
    await w.deliver();
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    expect(await w.row()).toMatchObject({ state: "restricted" });

    expect(await clearDisputes(w.d, w.ctx, billingStaff, ACCOUNT_A, await shown(w), SESSION, req)).toEqual({
      cleared: 1,
    });
    expect(await w.row()).toMatchObject({ disputedAt: null });
    expect((await w.d.uow.run((r) => r.billing.disputes(ACCOUNT_A))).map((d) => d.status)).toEqual(["cleared"]);
    expect(w.s.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT_A)).toBe(true);
    const entry = w.inAccount("billing.dispute_closed").at(-1);
    expect(entry).toMatchObject({ result: "success", meta: { outcome: "cleared", staff: true, cleared: 1 } });
    expect(entry?.actor).toMatchObject({ type: "staff", userId: billingStaff.userId });
    expect(w.inPlatform("billing.dispute_closed").at(-1)?.meta).toMatchObject({ accountId: ACCOUNT_A });

    // The provider still reports the lost dispute on the latest payment: the sync honours the clear.
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    expect(await w.row()).toMatchObject({ state: "active", disputedAt: null, restrictedAt: null });
    expect(w.inAccount("billing.state_changed").at(-1)?.meta).toMatchObject({
      fromState: "restricted",
      toState: "active",
    });
  });

  it("clears a dispute the provider reports before its event was resolved (not tracked yet)", async () => {
    const w = await paying();
    await w.fake.openDispute(w.customerId);
    await w.fake.drainDeliveries(); // the dispute event is lost: only the provider's view restricts
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    expect(await w.row()).toMatchObject({ state: "restricted" });
    expect(await clearDisputes(w.d, w.ctx, billingStaff, ACCOUNT_A, await shown(w), SESSION, req)).toEqual({
      cleared: 1,
    });
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    expect((await w.row()).state).toBe("active");
  });

  it("clears only what staff saw: a dispute that arrived since is 409 changed (audited), nothing cleared", async () => {
    const w = await paying();
    await w.fake.openDispute(w.customerId);
    await w.deliver();
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    const before = await shown(w);
    expect(before.disputeIds).toHaveLength(1);
    // The panel showed nothing (it loaded before the dispute arrived): refused.
    await expect(clearDisputes(w.d, w.ctx, billingStaff, ACCOUNT_A, NONE, SESSION, req)).rejects.toMatchObject({
      code: "changed",
    });
    expect(w.inAccount("billing.dispute_closed").at(-1)).toMatchObject({ result: "denied", errorCode: "changed" });
    expect((await shown(w)).disputeIds).toEqual(before.disputeIds);
    // A list with an extra id is refused too; the exact list clears.
    await expect(
      clearDisputes(
        w.d,
        w.ctx,
        billingStaff,
        ACCOUNT_A,
        { disputeIds: [...before.disputeIds, "dp_other"] },
        SESSION,
        req,
      ),
    ).rejects.toMatchObject({ code: "changed" });
    expect(await clearDisputes(w.d, w.ctx, billingStaff, ACCOUNT_A, before, SESSION, req)).toEqual({ cleared: 1 });
  });

  it("400 for a list that isn't dispute ids", async () => {
    const w = await paying();
    for (const bad of [undefined, "dp_1", [1], [""], Array.from({ length: 101 }, (_, i) => `dp_${String(i)}`)]) {
      await expect(
        clearDisputes(w.d, w.ctx, billingStaff, ACCOUNT_A, { disputeIds: bad }, SESSION, req),
      ).rejects.toMatchObject({ code: "bad_request" });
    }
  });

  it("409 when nothing is disputed (audited as denied)", async () => {
    const w = await paying();
    await expect(clearDisputes(w.d, w.ctx, billingStaff, ACCOUNT_A, NONE, SESSION, req)).rejects.toMatchObject({
      code: "not_disputed",
    });
    expect(w.inAccount("billing.dispute_closed").at(-1)).toMatchObject({
      result: "denied",
      errorCode: "not_disputed",
    });
  });

  it("refuses other staff (403), unknown accounts (404), act-as and a missing step-up (403), billing off (503)", async () => {
    const w = await paying();
    await expect(clearDisputes(w.d, w.ctx, support, ACCOUNT_A, NONE, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(clearDisputes(w.d, w.ctx, owner, ACCOUNT_A, NONE, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(clearDisputes(w.d, w.ctx, billingStaff, UNKNOWN, NONE, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(clearDisputes(w.d, w.ctx, billingStaff, "not-an-id", NONE, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(w.inPlatform("billing.dispute_closed").at(-1)).toMatchObject({ result: "denied", errorCode: "not_found" });
    await expect(
      clearDisputes(w.d, w.ctx, { ...billingStaff, actingAs: actAs(ACCOUNT_A) }, ACCOUNT_A, NONE, SESSION, req),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      clearDisputes(w.d, w.ctx, billingStaff, ACCOUNT_A, NONE, { sessionId: "other" }, req),
    ).rejects.toMatchObject({ code: "step_up_required" });
    await expect(
      clearDisputes(w.d, { ...w.ctx, provider: null }, billingStaff, ACCOUNT_A, NONE, SESSION, req),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
  });
});

describe("resyncAccountBilling", () => {
  it("queues a sync now, audited as staff in the account's log and the platform log; no step-up needed", async () => {
    const w = await paying();
    w.s.jobs.length = 0;
    expect(await resyncAccountBilling(w.d, w.ctx, billingStaff, ACCOUNT_A, req)).toEqual({ queued: true });
    expect(w.s.jobs.filter((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT_A)).toHaveLength(1);
    const entry = w.inAccount("billing.resynced").at(-1);
    expect(entry).toMatchObject({ result: "success", meta: { state: "active" } });
    expect(entry?.actor).toMatchObject({ type: "staff" });
    expect(w.inPlatform("billing.resynced")).toHaveLength(1);
  });

  it("refuses other staff, unknown accounts, act-as and billing off", async () => {
    const w = world();
    await expect(resyncAccountBilling(w.d, w.ctx, support, ACCOUNT_A, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(resyncAccountBilling(w.d, w.ctx, billingStaff, UNKNOWN, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      resyncAccountBilling(w.d, w.ctx, { ...billingStaff, actingAs: actAs(ACCOUNT_A) }, ACCOUNT_A, req),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(w.inAccount("billing.resynced").at(-1)).toMatchObject({ result: "denied", errorCode: "act_as" });
    await expect(
      resyncAccountBilling(w.d, { ...w.ctx, provider: null }, billingStaff, ACCOUNT_A, req),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
  });
});

describe("dismissBillingOrphan", () => {
  async function withOrphan() {
    const w = world();
    const id = await w.d.uow.run((r) =>
      r.billing.recordEvent({
        providerEventId: "evt_orphan",
        type: "charge.dispute.created",
        accountId: null,
        objectId: "dp_unknown",
        providerCreatedAt: w.clock.now(),
        receivedAt: w.clock.now(),
      }),
    );
    return { ...w, id: id ?? "" };
  }

  it("dismisses an orphan, audited in the platform log; a second dismissal is a 404", async () => {
    const w = await withOrphan();
    expect(await dismissBillingOrphan(w.d, billingStaff, w.id, SESSION, req)).toEqual({ dismissed: true });
    expect((await w.d.uow.run((r) => r.billing.getEvent(w.id)))?.status).toBe("dismissed");
    expect(w.inPlatform("billing.orphan_dismissed").at(-1)).toMatchObject({
      result: "success",
      meta: { type: "charge.dispute.created", objectId: "dp_unknown" },
    });
    await expect(dismissBillingOrphan(w.d, billingStaff, w.id, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(w.inPlatform("billing.orphan_dismissed").at(-1)).toMatchObject({
      result: "denied",
      errorCode: "not_found",
    });
  });

  it("404 for unknown ids and events that aren't orphans; 403 for other staff, act-as and no step-up", async () => {
    const w = await withOrphan();
    await expect(dismissBillingOrphan(w.d, billingStaff, UNKNOWN, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(dismissBillingOrphan(w.d, billingStaff, "nope", SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(dismissBillingOrphan(w.d, support, w.id, SESSION, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      dismissBillingOrphan(w.d, { ...billingStaff, actingAs: actAs(ACCOUNT_A) }, w.id, SESSION, req),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(dismissBillingOrphan(w.d, billingStaff, w.id, { sessionId: null }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect((await w.d.uow.run((r) => r.billing.getEvent(w.id)))?.status).toBe("orphan");
  });
});
