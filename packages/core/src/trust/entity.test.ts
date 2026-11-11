// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { effectiveTier, storedRestriction } from "./entity";

const AT = new Date("2026-11-11T12:00:00Z");

describe("storedRestriction (both adapters read a mailbox restriction through it)", () => {
  it("no restriction time: not restricted, whatever else is stored", () => {
    expect(storedRestriction({ at: null, reason: null, note: null, byUserId: null })).toBeNull();
    expect(storedRestriction({ at: null, reason: "spam", note: "n", byUserId: "ga" })).toBeNull();
  });

  it("a known reason is kept with the note and the setter", () => {
    expect(storedRestriction({ at: AT, reason: "phishing", note: "n", byUserId: "ga" })).toEqual({
      at: AT,
      reason: "phishing",
      note: "n",
      byUserId: "ga",
    });
  });

  it("a reason the code no longer knows, or none, still reads as restricted (as other), never as unrestricted", () => {
    for (const reason of ["retired_reason", "", null, "__proto__"]) {
      const r = storedRestriction({ at: AT, reason, note: null, byUserId: null });
      expect(r).toEqual({ at: AT, reason: "other", note: null, byUserId: null });
      expect(effectiveTier("standard", r !== null)).toBe("restricted");
    }
  });
});
