// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { accountPoolBytes } from "@anhourmail/shared/plans";

import { DomainError } from "../errors";

import {
  addonQuantityProblem,
  addressCeiling,
  assertDecreaseFits,
  BillingError,
  changeProration,
  checkoutBlock,
  entitledAddons,
  entitlements,
  refundEligibility,
  supporterAmountProblem,
} from "./entitlements";
import { defaultBilling } from "./lifecycle";
import type { ProviderInvoice } from "./ports";

const NOW = new Date("2026-11-15T00:00:00Z");
const DAY = 86_400_000;
const GB = 1024 ** 3;

const row = defaultBilling("00000000-0000-4000-8000-000000000001", "plus", NOW);

describe("entitlements (ADR-0029 §7)", () => {
  it("the larger of the current and the period-paid quantity, in paid states only", () => {
    const b = { ...row, storageBlocks: 1, periodPaidStorageBlocks: 3, extraMailboxes: 4, periodPaidExtraMailboxes: 2 };
    expect(entitledAddons(b)).toEqual({ storageBlocks: 3, extraMailboxes: 4 });
    expect(entitledAddons({ ...b, state: "past_due" })).toEqual({ storageBlocks: 3, extraMailboxes: 4 });
    expect(entitledAddons({ ...b, state: "lapsed" })).toEqual({ storageBlocks: 0, extraMailboxes: 0 });
    expect(entitledAddons({ ...b, storageBlocks: 99 }).storageBlocks).toBe(10);
  });

  it("ceilings and pool follow the effective plan and the entitled add-ons", () => {
    const e = entitlements({ ...row, storageBlocks: 2, extraMailboxes: 15 });
    expect(e).toEqual({
      plan: "plus",
      storageBlocks: 2,
      extraMailboxes: 15,
      mailboxCeiling: 25,
      peopleCeiling: 25,
      poolBytes: 30 * GB,
    });
    expect(entitlements({ ...row, state: "lapsed", storageBlocks: 2 })).toMatchObject({
      plan: "free",
      mailboxCeiling: 1,
      peopleCeiling: 1,
      poolBytes: GB,
    });
  });

  it("add-on quantities are whole numbers within the public bounds", () => {
    expect(addonQuantityProblem("storageBlocks", 0)).toBeNull();
    expect(addonQuantityProblem("storageBlocks", 10)).toBeNull();
    expect(addonQuantityProblem("storageBlocks", 11)).toMatch(/0 to 10/);
    expect(addonQuantityProblem("extraMailboxes", 40)).toBeNull();
    expect(addonQuantityProblem("extraMailboxes", 41)).toMatch(/Extra mailboxes.*0 to 40/);
    expect(addonQuantityProblem("extraMailboxes", -1)).not.toBeNull();
    expect(addonQuantityProblem("extraMailboxes", 1.5)).not.toBeNull();
  });

  it("the address ceiling is the configured one unless staff overrode it", () => {
    expect(addressCeiling(null, 5000)).toBe(5000);
    expect(addressCeiling({ addressCeilingOverride: null }, 5000)).toBe(5000);
    expect(addressCeiling({ addressCeilingOverride: 9000 }, 5000)).toBe(9000);
  });
});

describe("Supporter amount (ADR-0029 §2)", () => {
  it.each([
    ["USD", 2000, null],
    ["USD", 200_000, null],
    ["USD", 1900, /from 20 to 2000 USD/],
    ["USD", 200_100, /from 20 to 2000 USD/],
    ["CAD", 2700, null],
    ["CAD", 2000, /from 27 to 2700 CAD/],
    ["USD", 2050, /whole amount/],
    ["USD", Number.NaN, /whole amount/],
  ] as const)("%s %d", (currency, amount, problem) => {
    const got = supporterAmountProblem(currency, amount) ?? "ok";
    expect(got).toMatch(problem ?? /^ok$/);
  });
});

describe("checkout eligibility", () => {
  it("only from Free, lapsed or a comp, and not while one is pending", () => {
    const free = { state: "free" as const, planSource: "none" as const, checkoutPendingUntil: null };
    expect(checkoutBlock(free, NOW)).toBeNull();
    expect(checkoutBlock({ ...free, state: "lapsed" }, NOW)).toBeNull();
    expect(checkoutBlock({ ...free, state: "active", planSource: "comp" }, NOW)).toBeNull();
    expect(checkoutBlock({ ...free, state: "active", planSource: "stripe" }, NOW)).toBe("already_subscribed");
    expect(checkoutBlock({ ...free, state: "restricted", planSource: "stripe" }, NOW)).toBe("already_subscribed");
    expect(checkoutBlock({ ...free, checkoutPendingUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe("checkout_pending");
    expect(checkoutBlock({ ...free, checkoutPendingUntil: NOW }, NOW)).toBeNull();
  });
});

describe("changeProration", () => {
  const current = { storageBlocks: 2, extraMailboxes: 2, paidPlan: "plus" as const, planAmountMinor: 900 };

  it("increases are charged now; decreases, plan switches and amounts renew", () => {
    expect(changeProration(current, { storageBlocks: 3 })).toBe("charge_now");
    expect(changeProration(current, { extraMailboxes: 5, storageBlocks: 2 })).toBe("charge_now");
    expect(changeProration(current, { storageBlocks: 1 })).toBe("none");
    expect(changeProration(current, { plan: "supporter", supporterAmountMinor: 2000 })).toBe("none");
    expect(
      changeProration({ ...current, paidPlan: "supporter", planAmountMinor: 2000 }, { supporterAmountMinor: 3000 }),
    ).toBe("none");
  });

  it("refuses no-ops and mixed directions", () => {
    expect(() => changeProration(current, {})).toThrow(/Nothing to change/);
    expect(() => changeProration(current, { plan: "plus", storageBlocks: 2 })).toThrow(BillingError);
    expect(() => changeProration(current, { storageBlocks: 3, extraMailboxes: 1 })).toThrow(/on its own/);
    expect(() => changeProration(current, { storageBlocks: 3, plan: "supporter" })).toThrow(/on its own/);
    expect(() => changeProration(current, {})).toThrow(
      expect.objectContaining({ code: "invalid_change" }) as DomainError,
    );
    expect(new BillingError("addon_in_use", "x")).toBeInstanceOf(DomainError);
  });
});

describe("assertDecreaseFits", () => {
  it("refuses a decrease that would strand mailboxes or storage at renewal", () => {
    const fits = { mailboxes: 12, assignedQuotaBytes: accountPoolBytes("plus", 1) };
    expect(() => {
      assertDecreaseFits("plus", { storageBlocks: 1, extraMailboxes: 2 }, fits);
    }).not.toThrow();
    expect(() => {
      assertDecreaseFits("plus", { storageBlocks: 1, extraMailboxes: 1 }, fits);
    }).toThrow(/Delete a mailbox first/);
    expect(() => {
      assertDecreaseFits("plus", { storageBlocks: 0, extraMailboxes: 2 }, fits);
    }).toThrow(/Lower mailbox storage first/);
  });
});

describe("refundEligibility (ADR-0029 §9)", () => {
  const invoice = (over: Partial<ProviderInvoice> = {}): ProviderInvoice => ({
    id: "in_1",
    status: "paid",
    amountMinor: 900,
    paidAt: new Date(NOW.getTime() - 14 * DAY),
    billingReason: "subscription_create",
    refundedMinor: 0,
    ...over,
  });

  it("day 14 is in the window, day 14 plus a second isn't", () => {
    expect(refundEligibility(invoice(), NOW)).toEqual({ eligible: true });
    expect(refundEligibility(invoice({ paidAt: new Date(NOW.getTime() - 14 * DAY - 1000) }), NOW)).toEqual({
      eligible: false,
      reason: "outside_window",
    });
  });

  it("a renewal is refundable; a proration invoice, an unpaid or refunded one isn't", () => {
    expect(refundEligibility(invoice({ billingReason: "subscription_cycle" }), NOW).eligible).toBe(true);
    expect(refundEligibility(invoice({ billingReason: "other" }), NOW)).toEqual({
      eligible: false,
      reason: "not_plan_invoice",
    });
    expect(refundEligibility(invoice({ status: "open", paidAt: null }), NOW)).toEqual({
      eligible: false,
      reason: "not_paid",
    });
    expect(refundEligibility(invoice({ paidAt: null }), NOW)).toMatchObject({ reason: "not_paid" });
    expect(refundEligibility(invoice({ refundedMinor: 1 }), NOW)).toMatchObject({ reason: "already_refunded" });
    expect(refundEligibility(null, NOW)).toEqual({ eligible: false, reason: "no_invoice" });
  });
});
