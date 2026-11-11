// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  isStaffSettableTrustTier,
  isTrustTier,
  isTrustTierSource,
  STAFF_SETTABLE_TRUST_TIERS,
  stricterTier,
  TRUST_TIER_ORDER,
  TRUST_TIER_SOURCES,
  TRUST_TIERS,
} from "./sending";

describe("trust tiers (ADR-0034)", () => {
  it("orders every published tier once, strictest first, and the limits grow along the order", () => {
    expect([...TRUST_TIER_ORDER].sort()).toEqual(Object.keys(TRUST_TIERS).sort());
    for (let i = 1; i < TRUST_TIER_ORDER.length; i++) {
      const before = TRUST_TIERS[TRUST_TIER_ORDER[i - 1] ?? "restricted"].limits;
      const after = TRUST_TIERS[TRUST_TIER_ORDER[i] ?? "restricted"].limits;
      expect(after.messagesPerHour).toBeGreaterThan(before.messagesPerHour);
      expect(after.messagesPerDay).toBeGreaterThan(before.messagesPerDay);
      expect(after.recipientsPerMessage).toBeGreaterThan(before.recipientsPerMessage);
    }
  });

  it("recognises tiers and nothing else", () => {
    for (const t of TRUST_TIER_ORDER) expect(isTrustTier(t)).toBe(true);
    for (const v of ["", "New", "toString", "constructor", "suspended", 1, null, undefined, {}]) {
      expect(isTrustTier(v)).toBe(false);
    }
  });

  it("picks the stricter of two tiers, whichever comes first", () => {
    expect(stricterTier("standard", "new")).toBe("new");
    expect(stricterTier("new", "standard")).toBe("new");
    expect(stricterTier("trusted", "restricted")).toBe("restricted");
    expect(stricterTier("standard", "trusted")).toBe("standard");
    for (const t of TRUST_TIER_ORDER) {
      expect(stricterTier(t, t)).toBe(t);
      expect(stricterTier(t, "restricted")).toBe("restricted");
      expect(stricterTier("trusted", t)).toBe(t);
    }
  });

  it("lists the sources of a tier and recognises only them", () => {
    expect(TRUST_TIER_SOURCES).toEqual(["default", "automatic", "billing", "staff"]);
    for (const s of TRUST_TIER_SOURCES) expect(isTrustTierSource(s)).toBe(true);
    for (const v of ["system", "Staff", "", 0, null]) expect(isTrustTierSource(v)).toBe(false);
  });

  it("lets staff set every tier except the reserved trusted", () => {
    expect(STAFF_SETTABLE_TRUST_TIERS).toEqual(["new", "standard", "restricted"]);
    for (const t of STAFF_SETTABLE_TRUST_TIERS) {
      expect(isStaffSettableTrustTier(t)).toBe(true);
      expect(isTrustTier(t)).toBe(true);
    }
    expect(isStaffSettableTrustTier("trusted")).toBe(false);
    expect(isStaffSettableTrustTier("default")).toBe(false);
    expect(isStaffSettableTrustTier(undefined)).toBe(false);
  });
});
