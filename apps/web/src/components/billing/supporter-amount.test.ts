// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { BILLING, PLANS } from "@anhourmail/shared/plans";

import { supporterAmountError } from "./supporter-amount";

describe("supporterAmountError", () => {
  const min = (PLANS.supporter.price?.USD ?? 0) / 100;
  const max = BILLING.supporterMaximum.USD / 100;

  it("accepts whole amounts from the minimum to the maximum", () => {
    expect(supporterAmountError("USD", String(min))).toBeNull();
    expect(supporterAmountError("USD", ` ${String(max)} `)).toBeNull();
    expect(supporterAmountError("CAD", String((PLANS.supporter.price?.CAD ?? 0) / 100))).toBeNull();
  });

  it.each(["", "abc", "20.50", "-5", "1e3"])("refuses %j as not a whole amount", (typed) => {
    expect(supporterAmountError("USD", typed)).toBe("Enter a whole amount (no cents).");
  });

  it("refuses amounts below the minimum or above the maximum, naming the range", () => {
    expect(supporterAmountError("USD", String(min - 1))).toMatch(/^Choose an amount from /);
    expect(supporterAmountError("USD", String(max + 1))).toMatch(/^Choose an amount from /);
  });
});
