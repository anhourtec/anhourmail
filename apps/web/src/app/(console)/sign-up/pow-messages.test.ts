// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { powProgress } from "./pow-messages";

describe("powProgress", () => {
  it("rises with proofs tried, relative to the difficulty, and never reaches 100 before a proof is found", () => {
    expect(powProgress(0, 17)).toBe(0);
    expect(powProgress(2 ** 17, 17)).toBe(63);
    expect(powProgress(2 ** 16, 16)).toBe(63);
    expect(powProgress(2 ** 30, 17)).toBe(99);
    expect(powProgress(2 ** 15, 17)).toBeLessThan(powProgress(2 ** 16, 17));
  });
});
