// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  BILLING,
  isPaidPlan,
  MAX_EXTRA_MAILBOXES,
  MAX_PEOPLE,
  mailboxCeiling,
  PAID_PLANS,
  peopleCeiling,
  planHighlights,
  PLANS,
  storageText,
} from "./plans";

describe("billing facts (ADR-0029)", () => {
  it("billing is planned until the launch change, with the published day counts", () => {
    expect(BILLING.status).toBe("planned");
    expect(BILLING.restrictedDays).toBe(30);
    expect(BILLING.heldReceiveDays).toBe(30);
    expect(BILLING.trialDays).toBe(0);
  });

  it("the Supporter maximum is 100 times the minimum in each currency", () => {
    expect(BILLING.supporterMaximum).toEqual({ USD: 200_000, CAD: 270_000 });
    for (const c of BILLING.currencies) {
      expect(BILLING.supporterMaximum[c]).toBe((PLANS.supporter.price?.[c] ?? 0) * 100);
    }
  });

  it("paid plans are Plus and Supporter", () => {
    expect(PAID_PLANS).toEqual(["plus", "supporter"]);
    expect(isPaidPlan("plus")).toBe(true);
    expect(isPaidPlan("supporter")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan("enterprise")).toBe(false);
  });

  it("mailbox ceiling: included mailboxes plus entitled extras on paid plans only, capped", () => {
    expect(mailboxCeiling("free")).toBe(1);
    expect(mailboxCeiling("free", 5)).toBe(1);
    expect(mailboxCeiling("plus")).toBe(10);
    expect(mailboxCeiling("plus", 3)).toBe(13);
    expect(mailboxCeiling("supporter", 2.9)).toBe(12);
    expect(mailboxCeiling("plus", -4)).toBe(10);
    expect(mailboxCeiling("plus", MAX_EXTRA_MAILBOXES + 10)).toBe(10 + MAX_EXTRA_MAILBOXES);
  });

  it("people ceiling follows the mailbox ceiling above MAX_PEOPLE; Free has one person", () => {
    expect(peopleCeiling("free", 9)).toBe(1);
    expect(peopleCeiling("plus")).toBe(MAX_PEOPLE);
    expect(peopleCeiling("plus", 15)).toBe(25);
  });

  it("storage text drops the 'coming with billing' suffix once billing is open", () => {
    expect(storageText(PLANS.plus, "USD", "open")).toEqual({
      pool: "10 GB shared by the whole account",
      block: "More storage: +10 GB for $10/year",
      extraMailbox: "Extra mailboxes: $1/year each",
    });
    expect(storageText(PLANS.plus).block).toMatch(/\(coming with billing\)$/);
  });

  it("plan highlights: Free's own lines, the paid plans' shared ones, and Supporter adds only its badge", () => {
    expect(planHighlights(PLANS.free)).toEqual([
      "1 GB storage",
      "1 mailbox",
      "An @anhourmail.com address",
      "10 aliases",
      "10 masked aliases",
    ]);
    const plus = planHighlights(PLANS.plus);
    expect(plus).toContain("10 GB shared by the whole account");
    expect(plus).toContain("Bring your own domains");
    expect(plus).toContain("Catch-all addresses");
    expect(plus).not.toContain("Supporter badge and early features");
    expect(planHighlights(PLANS.supporter).filter((l) => !plus.includes(l))).toEqual([
      "Supporter badge and early features",
    ]);
  });
});
