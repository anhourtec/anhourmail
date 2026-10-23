// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { normaliseNames, refuseBadNames } from ".";

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

describe("shared name rules at sign-up and profile edits", () => {
  const names = (over: Partial<{ firstName: string; lastName: string | null; name: string }>) => ({
    firstName: "Ada",
    lastName: null,
    name: "Ada",
    ...over,
  });

  it("refuses control and text-direction characters, @ and web addresses in any of the three names", () => {
    for (const bad of [
      names({ firstName: "Ada\u202eevil" }),
      names({ lastName: "x@y" }),
      names({ name: "Visit evil.example" }),
      names({ name: "https://evil.example" }),
    ]) {
      expect(() => {
        refuseBadNames(bad);
      }).toThrow(/Names can't contain/);
    }
  });

  it("accepts ordinary names", () => {
    expect(() => {
      refuseBadNames(names({ firstName: "Zoë", lastName: "O'Brien", name: "Zoë O'Brien" }));
    }).not.toThrow();
  });
});
