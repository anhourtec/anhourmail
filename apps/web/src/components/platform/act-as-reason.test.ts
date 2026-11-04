// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACT_AS } from "@anhourmail/shared/platform";

import { reasonProblem } from "./act-as-reason";

describe("reasonProblem", () => {
  it("asks for a reason when it is empty or only spaces", () => {
    expect(reasonProblem("")).toBe("Write a reason first.");
    expect(reasonProblem("   ")).toBe("Write a reason first.");
  });

  it("says how many more characters a short reason needs", () => {
    expect(reasonProblem("test")).toBe(
      `Write a little more: the reason needs at least ${String(ACT_AS.reasonMin)} characters (${String(ACT_AS.reasonMin - 4)} more).`,
    );
    // Surrounding spaces don't count, as on the server.
    expect(reasonProblem(`  ${"a".repeat(ACT_AS.reasonMin - 1)}  `)).toMatch(/\(1 more\)/);
  });

  it("accepts a reason at the minimum and at the maximum", () => {
    expect(reasonProblem("a".repeat(ACT_AS.reasonMin))).toBeNull();
    expect(reasonProblem("a".repeat(ACT_AS.reasonMax))).toBeNull();
  });

  it("refuses a reason over the maximum", () => {
    expect(reasonProblem("a".repeat(ACT_AS.reasonMax + 1))).toBe(
      `Keep the reason to ${String(ACT_AS.reasonMax)} characters.`,
    );
  });
});
