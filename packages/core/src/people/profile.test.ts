// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ValidationError } from "../errors";
import { displayName, profileDetails } from "./entity";

describe("displayName", () => {
  it("trims and collapses spaces, and refuses empty, long or address-like names", () => {
    expect(displayName("  Jane   Doe ")).toBe("Jane Doe");
    for (const bad of [undefined, "", "   ", "x".repeat(81), "jane@x.test", "www.example.com", "a‮b"]) {
      expect(() => displayName(bad)).toThrow(ValidationError);
    }
  });
});

describe("profileDetails", () => {
  it("keeps known, non-empty fields and drops the rest", () => {
    expect(profileDetails(undefined)).toEqual({});
    expect(profileDetails(null)).toEqual({});
    expect(
      profileDetails({
        jobTitle: "  Head  of  editing ",
        department: "",
        officePhone: "+1 (902) 555-0100",
        country: "CA",
        unknown: "ignored",
      }),
    ).toEqual({ jobTitle: "Head of editing", officePhone: "+1 (902) 555-0100", country: "CA" });
  });

  it("refuses bad phones, unknown countries, long values, links and non-text", () => {
    for (const bad of [
      { mobilePhone: "call me" },
      { country: "Canada" },
      { country: "XX" },
      { postalCode: "1".repeat(21) },
      { city: "visit example.com" },
      { office: 12 },
      "text",
      [],
    ]) {
      expect(() => profileDetails(bad)).toThrow(ValidationError);
    }
  });
});
