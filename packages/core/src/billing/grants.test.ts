// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Staff grants and comps, ending them, the staff refund and the Platform billing views (ADR-0029 §8, §9; slice 12)
 * against the in-memory repositories and the fake provider: permission (403) and scope (404), act-as and the step-up,
 * grants never replacing a subscription, a lapsed account getting its holds lifted, an ended grant holding (never
 * deleting) what doesn't fit, and every staff action recorded in the account's own log as staff (rule 49).
 */
import { describe, expect, it } from "vitest";

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

import { startCheckout } from "./checkout";
import {
  endStaffPlan,
  grantStaffPlan,
  parsePlanGrant,
  platformAccountBilling,
  platformBillingSummary,
  staffRefund,
} from "./grants";
import type { BillingContext } from "./guards";
import { defaultBilling } from "./lifecycle";
import { syncAccountBilling } from "./sync";

const APP = "http://localhost:43200";
const DAY = 86_400_000;
const SESSION = { sessionId: "staff-session" };
const billingStaff = user({ id: "staff-billing", platform: ["billing_admin"] });
const support = user({ id: "staff-support", platform: ["support_admin"] });
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

function world() {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free" }, { id: ACCOUNT_B, name: "Other", plan: "free" });
  s.memberships.push({ userId: owner.userId, accountId: ACCOUNT_A, role: "owner" });
  s.stepUps.push({ userId: billingStaff.userId, sessionId: SESSION.sessionId, expiresAt: new Date("2099-01-01") });
  const box = (id: string, address: string, userId: string | null) => ({
    id,
    accountId: ACCOUNT_A,
    userId,
    address,
    status: "active" as const,
    quotaBytes: GB,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: clock.now(),
  });
  s.mailboxes.push(
    box("a0000000-0000-4000-8000-000000000001", `me@${TEST_PLATFORM.domain}`, owner.userId),
    box("a0000000-0000-4000-8000-000000000002", `two@${TEST_PLATFORM.domain}`, null),
  );
  const fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("grants-test"),
    clock: () => clock.now(),
    nodeEnv: "test",
  });
  const ctx: BillingContext = { provider: fake, appUrl: APP, redirectOrigins: [APP], paidPlansOpen: true };
  const row = async () => (await d.uow.run((r) => r.billing.get(ACCOUNT_A)))!;
  const inAccount = (action: string) =>
    s.audit.filter((e) => e.action === action && e.scope === `account:${ACCOUNT_A}`);
  const inPlatform = (action: string) => s.audit.filter((e) => e.action === action && e.scope === "platform");
  return { clock, d, s, fake, ctx, row, inAccount, inPlatform };
}

describe("parsePlanGrant", () => {
  it("takes Plus or Supporter for 1–365 days, or no end", () => {
    expect(parsePlanGrant({ plan: "plus", days: 30 })).toEqual({ plan: "plus", days: 30 });
    expect(parsePlanGrant({ plan: "supporter" })).toEqual({ plan: "supporter", days: null });
  });
  it.each([{ plan: "free" }, { plan: "plus", days: 0 }, { plan: "plus", days: 366 }, { plan: "plus", days: 1.5 }])(
    "refuses %j",
    (input) => {
      expect(() => parsePlanGrant(input)).toThrow();
    },
  );
});

describe("grantStaffPlan / endStaffPlan", () => {
  it("grants a comp for some days: active at once, audited as staff in the account's log and the platform's", async () => {
    const w = world();
    const out = await grantStaffPlan(w.d, billingStaff, ACCOUNT_A, { plan: "plus", days: 30 }, SESSION, req);
    expect(out).toMatchObject({ state: "active", plan: "plus" });
    expect(out.until?.getTime()).toBe(w.clock.now().getTime() + 30 * DAY);
    expect(await w.row()).toMatchObject({ state: "active", planSource: "comp", paidPlan: "plus" });
    expect(w.s.accounts.find((a) => a.id === ACCOUNT_A)?.plan).toBe("plus");
    const entry = w.inAccount("billing.staff_plan_granted")[0];
    expect(entry).toMatchObject({ result: "success", meta: { plan: "plus", days: 30 } });
    expect(entry?.actor).toMatchObject({ type: "staff", userId: billingStaff.userId });
    expect(w.inAccount("billing.state_changed")[0]?.meta).toMatchObject({ toState: "active", reason: "comp_started" });
    expect(w.inAccount("billing.plan_changed")[0]?.meta).toMatchObject({ fromPlan: "free", toPlan: "plus" });
    expect(w.inPlatform("billing.staff_plan_granted")).toHaveLength(1);
    // A comp makes the account paid, so it is promoted to standard at once (ADR-0034 §2), by the staff member's request.
    expect(await w.d.uow.run((r) => r.trust.get(ACCOUNT_A))).toMatchObject({ tier: "standard", source: "billing" });
    expect(w.inAccount("trust.tier_changed")[0]).toMatchObject({
      result: "success",
      meta: { fromTier: "new", toTier: "standard", source: "billing" },
    });
  });

  it("grants with no end date as a staff grant; ending it drops to Free and holds what doesn't fit", async () => {
    const w = world();
    await grantStaffPlan(w.d, billingStaff, ACCOUNT_A, { plan: "supporter" }, SESSION, req);
    expect(await w.row()).toMatchObject({ planSource: "staff", paidPlan: "supporter", compUntil: null });
    expect(await endStaffPlan(w.d, billingStaff, ACCOUNT_A, SESSION, req)).toEqual({ state: "lapsed" });
    expect(await w.row()).toMatchObject({ state: "lapsed", planSource: "none", paidPlan: null });
    const holds = await w.d.uow.run((r) => r.billing.holds(ACCOUNT_A));
    expect(holds.map((h) => h.subjectId)).toEqual(["a0000000-0000-4000-8000-000000000002"]);
    expect(w.s.mailboxes).toHaveLength(2); // nothing deleted
    expect(w.inAccount("billing.staff_plan_revoked")[0]?.meta).toMatchObject({ source: "staff", toState: "lapsed" });
    expect(w.inAccount("billing.plan_changed").at(-1)?.meta).toMatchObject({ fromPlan: "supporter", toPlan: "free" });
    // Ending the grant keeps the promotion (sticky).
    expect((await w.d.uow.run((r) => r.trust.get(ACCOUNT_A)))?.tier).toBe("standard");
  });

  it("a grant on a lapsed account lifts every hold", async () => {
    const w = world();
    await grantStaffPlan(w.d, billingStaff, ACCOUNT_A, { plan: "plus" }, SESSION, req);
    await endStaffPlan(w.d, billingStaff, ACCOUNT_A, SESSION, req);
    expect((await w.d.uow.run((r) => r.billing.holds(ACCOUNT_A))).length).toBe(1);
    await grantStaffPlan(w.d, billingStaff, ACCOUNT_A, { plan: "plus", days: 10 }, SESSION, req);
    expect(await w.d.uow.run((r) => r.billing.holds(ACCOUNT_A))).toEqual([]);
    expect(w.inAccount("billing.holds_lifted")).toHaveLength(1);
  });

  it("never replaces a paying subscription (409), and ending needs a grant (409)", async () => {
    const w = world();
    await expect(endStaffPlan(w.d, billingStaff, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({
      code: "not_subscribed",
    });
    const { url } = await startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
    await w.fake.completeCheckout(url.split("/").pop() ?? "", "pay");
    await w.fake.drainDeliveries();
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    await expect(
      grantStaffPlan(w.d, billingStaff, ACCOUNT_A, { plan: "supporter" }, SESSION, req),
    ).rejects.toMatchObject({ code: "already_subscribed" });
    expect(w.inAccount("billing.staff_plan_granted").at(-1)).toMatchObject({
      result: "denied",
      errorCode: "already_subscribed",
    });
  });

  it("needs platform.billing.manage (403), a known account (404), a step-up, and never runs while acting", async () => {
    const w = world();
    await expect(grantStaffPlan(w.d, support, ACCOUNT_A, { plan: "plus" }, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(grantStaffPlan(w.d, owner, ACCOUNT_A, { plan: "plus" }, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(grantStaffPlan(w.d, billingStaff, UNKNOWN, { plan: "plus" }, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      grantStaffPlan(w.d, billingStaff, ACCOUNT_A, { plan: "plus" }, { sessionId: "other" }, req),
    ).rejects.toMatchObject({ code: "step_up_required" });
    const acting = { ...billingStaff, actingAs: actAs(ACCOUNT_B) };
    await expect(grantStaffPlan(w.d, acting, ACCOUNT_A, { plan: "plus" }, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(w.s.accounts.find((a) => a.id === ACCOUNT_A)?.plan).toBe("free");
    expect(w.inPlatform("billing.staff_plan_granted").some((e) => e.result === "denied")).toBe(true);
  });
});

describe("staffRefund", () => {
  async function paid() {
    const w = world();
    const { url } = await startCheckout(w.d, w.ctx, owner, ACCOUNT_A, { plan: "plus", currency: "USD" }, req);
    await w.fake.completeCheckout(url.split("/").pop() ?? "", "pay");
    await w.fake.drainDeliveries();
    await syncAccountBilling(w.d, w.fake, ACCOUNT_A);
    return w;
  }

  it("refunds outside the window, records staff: true in the account's log, and can end the subscription", async () => {
    const w = await paid();
    w.clock.set(new Date(w.clock.now().getTime() + 40 * DAY));
    const out = await staffRefund(w.d, w.ctx, billingStaff, ACCOUNT_A, { endSubscription: true }, SESSION, req);
    expect(out).toMatchObject({ ended: true, currency: "USD" });
    expect(out.amountMinor).toBeGreaterThan(0);
    expect(w.inAccount("billing.refunded").at(-1)?.meta).toMatchObject({
      staff: true,
      withinWindow: false,
      ended: true,
    });
    expect((await w.row()).selfServiceRefundAt).toBeNull();
    expect(w.s.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT_A)).toBe(true);
    // The same invoice again: already refunded.
    await expect(staffRefund(w.d, w.ctx, billingStaff, ACCOUNT_A, {}, SESSION, req)).rejects.toMatchObject({
      code: "refund_not_eligible",
    });
  });

  it("refuses an account that never paid, billing off (503) and other staff (403)", async () => {
    const w = world();
    await expect(staffRefund(w.d, w.ctx, billingStaff, ACCOUNT_A, {}, SESSION, req)).rejects.toMatchObject({
      code: "refund_not_eligible",
    });
    await expect(
      staffRefund(w.d, { ...w.ctx, provider: null }, billingStaff, ACCOUNT_A, {}, SESSION, req),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
    await expect(staffRefund(w.d, w.ctx, support, ACCOUNT_A, {}, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("platform billing views", () => {
  it("shows the account's billing to billing staff only, with the ceiling and what they may do", async () => {
    const w = world();
    const v = await platformAccountBilling(w.d, w.ctx, billingStaff, ACCOUNT_A);
    expect(v).toMatchObject({
      available: true,
      plan: "free",
      addresses: 2,
      can: { grant: true, endGrant: false, refund: false, resync: false, clearDisputes: false },
    });
    expect(v.ceiling.effective).toBe(v.ceiling.configured);
    await expect(platformAccountBilling(w.d, w.ctx, support, ACCOUNT_A)).rejects.toMatchObject({ code: "forbidden" });
    await expect(platformAccountBilling(w.d, w.ctx, billingStaff, UNKNOWN)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lists accounts by state and unmatched events", async () => {
    const w = world();
    w.s.billing.push({
      ...defaultBilling(ACCOUNT_B, "plus", w.clock.now()),
      state: "restricted",
      disputedAt: w.clock.now(),
    });
    await w.d.uow.run((r) =>
      r.billing.recordEvent({
        providerEventId: "evt_orphan",
        type: "charge.dispute.created",
        accountId: null,
        objectId: "dp_1",
        providerCreatedAt: w.clock.now(),
        receivedAt: w.clock.now(),
      }),
    );
    const s = await platformBillingSummary(w.d, w.ctx, billingStaff);
    expect(s.lists.restricted).toEqual([{ accountId: ACCOUNT_B, name: "Other", since: w.clock.now(), disputed: true }]);
    expect(s.orphans.map((o) => o.objectId)).toEqual(["dp_1"]);
    await expect(platformBillingSummary(w.d, w.ctx, support)).rejects.toMatchObject({ code: "forbidden" });
  });
});
