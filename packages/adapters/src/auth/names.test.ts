// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { normaliseNames } from ".";

describe("sign-up name rules", () => {
  it("requires a first name", () => {
    expect(normaliseNames({ firstName: "   ", name: "X" })).toBeNull();
    expect(normaliseNames({})).toBeNull();
  });

  it("defaults the display name to first + last, trimmed and collapsed", () => {
    expect(normaliseNames({ firstName: "  Ada ", lastName: " Lovelace  " })).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      name: "Ada Lovelace",
    });
    expect(normaliseNames({ firstName: "Ada", lastName: "", name: "" })).toEqual({
      firstName: "Ada",
      lastName: null,
      name: "Ada",
    });
  });

  it("keeps an edited display name and caps lengths", () => {
    expect(normaliseNames({ firstName: "Ada", lastName: "Lovelace", name: " Countess  Ada " })?.name).toBe(
      "Countess Ada",
    );
    const long = normaliseNames({ firstName: "a".repeat(100), name: "b".repeat(200) });
    expect(long?.firstName).toHaveLength(60);
    expect(long?.name).toHaveLength(80);
  });
});
