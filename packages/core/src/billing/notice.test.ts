// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The console's billing banner (ADR-0029 §9, slice 11) and the Billing page's extra overview fields: who sees the
 * banner in each state, when a restricted account's subscription ends, the pending checkout's end, and the choices
 * "Choose what stays on" offers after a lapse.
 */
import { describe, expect, it } from "vitest";

import { BILLING } from "@anhourmail/shared/plans";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "../../../adapters/src/billing-fake";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  actingStaff,
  deps as makeDeps,
  fixedClock,
  TEST_PLATFORM,
  user,
} from "../__tests__/helpers";
import { GB } from "../mailboxes/entity";

import { billingOverview } from "./checkout";
import type { AccountBilling } from "./entity";
import type { BillingContext } from "./guards";
import { defaultBilling } from "./lifecycle";
import { accountBillingNotice } from "./notice";

const APP = "http://localhost:43200";
const DAY = 86_400_000;
const owner = user({ id: "owner-1", account: [[ACCOUNT_A, "owner"]] });
const billingAdmin = user({ id: "billing-1", account: [[ACCOUNT_A, "billing_admin"]] });
const auditor = user({ id: "auditor-1", account: [[ACCOUNT_A, "auditor"]] });
const member = user({ id: "member-1", account: [[ACCOUNT_A, "member"]] });
const outsider = user({ id: "outsider-1", account: [[ACCOUNT_B, "owner"]] });

function world(row: Partial<AccountBilling> = {}) {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  d.uow.state.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "free" });
  d.uow.state.billing.push({ ...defaultBilling(ACCOUNT_A, "plus", clock.now()), planSource: "stripe", ...row });
  return { clock, d };
}

describe("accountBillingNotice", () => {
  it("shows nothing for a healthy account, to outsiders or to anonymous callers", async () => {
    const { d } = world();
    expect(await accountBillingNotice(d, owner, ACCOUNT_A)).toBeNull();
    const past = world({ state: "past_due" });
    expect(await accountBillingNotice(past.d, outsider, ACCOUNT_A)).toBeNull();
    expect(await accountBillingNotice(past.d, { kind: "anonymous" }, ACCOUNT_A)).toBeNull();
  });

  it("past due: only people who see billing; the Owner and Billing Administrator can fix it, the Auditor reads", async () => {
    const { d } = world({ state: "past_due" });
    expect(await accountBillingNotice(d, owner, ACCOUNT_A)).toMatchObject({
      state: "past_due",
      canRead: true,
      canManage: true,
      reason: null,
      endsAt: null,
    });
    expect(await accountBillingNotice(d, billingAdmin, ACCOUNT_A)).toMatchObject({ canManage: true });
    expect(await accountBillingNotice(d, auditor, ACCOUNT_A)).toMatchObject({ canRead: true, canManage: false });
    expect(await accountBillingNotice(d, member, ACCOUNT_A)).toBeNull();
  });

  it("restricted for a payment: everyone, with the day the subscription ends unless paid", async () => {
    const { d, clock } = world({ state: "restricted", restrictedAt: new Date("2026-11-01T00:00:00Z") });
    const n = await accountBillingNotice(d, member, ACCOUNT_A);
    expect(n).toMatchObject({ state: "restricted", reason: "payment", canRead: false, canManage: false });
    expect(n?.endsAt?.getTime()).toBe(new Date("2026-11-01T00:00:00Z").getTime() + BILLING.restrictedDays * DAY);
    expect(clock.now() < (n?.endsAt ?? clock.now())).toBe(true);
  });

  it("restricted by a dispute: no end date (staff handle disputes)", async () => {
    const { d } = world({ state: "restricted", restrictedAt: new Date(), disputedAt: new Date() });
    expect(await accountBillingNotice(d, owner, ACCOUNT_A)).toMatchObject({ reason: "dispute", endsAt: null });
  });

  it("lapsed: everyone; staff acting read-only see it but can't act", async () => {
    const { d } = world({ state: "lapsed", paidPlan: null, planSource: "none" });
    expect(await accountBillingNotice(d, member, ACCOUNT_A)).toMatchObject({ state: "lapsed", canRead: false });
    expect(await accountBillingNotice(d, actingStaff(ACCOUNT_A), ACCOUNT_A)).toMatchObject({
      canRead: true,
      canManage: false,
    });
  });
});

describe("billingOverview: pending checkout and hold choices", () => {
  const ctx: BillingContext = { provider: null, appUrl: APP, redirectOrigins: [], paidPlansOpen: true };

  it("says when a new checkout can start while one is pending, and nothing once it has passed", async () => {
    const until = new Date("2026-11-05T10:30:00Z");
    const { d, clock } = world({ state: "free", planSource: "none", paidPlan: null, checkoutPendingUntil: until });
    expect(await billingOverview(d, ctx, owner, ACCOUNT_A)).toMatchObject({
      checkoutBlocked: "checkout_pending",
      checkoutPendingUntil: until,
      holdChoices: null,
    });
    clock.set(new Date("2026-11-05T11:00:00Z"));
    expect((await billingOverview(d, ctx, owner, ACCOUNT_A)).checkoutPendingUntil).toBeNull();
  });

  it("after a lapse offers the platform mailboxes and their enabled platform aliases, marking what is held", async () => {
    const fake = createFakeBillingProvider({
      store: memoryFakeBillingStore(),
      appUrl: APP,
      webhookSecret: fakeWebhookSecret("notice-test"),
      nodeEnv: "test",
    });
    const { d, clock } = world({ state: "lapsed", paidPlan: null, planSource: "none", lapsedAt: new Date() });
    const s = d.uow.state;
    const box = (id: string, address: string, status: "active" | "deleting" = "active") => ({
      id,
      accountId: ACCOUNT_A,
      userId: null,
      address,
      status,
      quotaBytes: GB,
      stalwartId: null,
      lastError: null,
      purgeAfter: null,
      createdAt: clock.now(),
    });
    const kept = "a0000000-0000-4000-8000-000000000001";
    const held = "a0000000-0000-4000-8000-000000000002";
    const custom = "a0000000-0000-4000-8000-000000000003";
    const gone = "a0000000-0000-4000-8000-000000000004";
    s.mailboxes.push(
      box(kept, `me@${TEST_PLATFORM.domain}`),
      box(held, `two@${TEST_PLATFORM.domain}`),
      box(custom, "desk@acme.test"),
      box(gone, `old@${TEST_PLATFORM.domain}`, "deleting"),
    );
    const alias = (id: string, mailboxId: string, address: string, enabled = true) => ({
      id,
      accountId: ACCOUNT_A,
      mailboxId,
      address,
      kind: "alias" as const,
      enabled,
      adminLocked: false,
      description: null,
      createdAt: clock.now(),
    });
    const a1 = "b0000000-0000-4000-8000-000000000001";
    const a2 = "b0000000-0000-4000-8000-000000000002";
    const a3 = "b0000000-0000-4000-8000-000000000003";
    s.aliases.push(
      alias(a1, kept, `shop@${TEST_PLATFORM.domain}`),
      alias(a2, kept, `off@${TEST_PLATFORM.domain}`, false),
      alias(a3, custom, "sales@acme.test"),
    );
    await d.uow.run((r) =>
      r.billing.replaceHolds(
        ACCOUNT_A,
        [
          { subjectType: "mailbox", subjectId: held, receiveUntil: new Date(clock.now().getTime() + 30 * DAY) },
          { subjectType: "mailbox", subjectId: custom, receiveUntil: new Date(clock.now().getTime() + 30 * DAY) },
        ],
        clock.now(),
      ),
    );
    const o = await billingOverview(d, { ...ctx, provider: fake }, owner, ACCOUNT_A);
    expect(o.holdChoices?.mailboxes).toEqual([
      { id: kept, address: `me@${TEST_PLATFORM.domain}`, kept: true },
      { id: held, address: `two@${TEST_PLATFORM.domain}`, kept: false },
    ]);
    expect(o.holdChoices?.aliases).toEqual([
      { id: a1, address: `shop@${TEST_PLATFORM.domain}`, kind: "alias", mailboxId: kept, kept: true },
    ]);
  });
});
