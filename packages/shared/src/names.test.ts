// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { NAME_PROBLEMS, nameProblem } from "./names";

describe("name rules", () => {
  it("accepts ordinary names in any script, with punctuation people use", () => {
    for (const ok of [
      "Ada Lovelace",
      "Zoë O'Brien-Smith",
      "J. R. R. Tolkien",
      "St. John",
      "李小龍",
      "محمد",
      "Family (Vancouver)",
      "Demo Family",
      "Mary-Kate & Ashley",
      "Dr. Smith",
      "v2.0 team",
    ]) {
      expect(nameProblem(ok)).toBeNull();
    }
  });

  it("refuses C0 and C1 control characters and DEL", () => {
    for (const bad of ["a\u0000b", "bell\u0007", "a\u001fb", "del\u007f", "c1\u0085", "c1\u009f"]) {
      expect(nameProblem(bad)).toBe(NAME_PROBLEMS.control);
    }
  });

  it("refuses bidirectional-text controls that reorder what's shown", () => {
    for (const cp of [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(nameProblem(`Kim${String.fromCodePoint(cp)}moc.live`)).toBe(NAME_PROBLEMS.control);
    }
  });

  it("refuses @ (ASCII and fullwidth), so a name can't pose as an address", () => {
    expect(nameProblem("support@bank")).toBe(NAME_PROBLEMS.at);
    expect(nameProblem("support＠bank")).toBe(NAME_PROBLEMS.at);
  });

  it("refuses anything that looks like a web address", () => {
    for (const bad of [
      "https://evil.example",
      "Visit evil.example now",
      "javascript://x",
      "www.evil",
      "Go to WWW.Example",
      "pay-me.co.uk",
      "Kim (evil.com)",
      "login.secure-bank.com",
    ]) {
      expect(nameProblem(bad)).toBe(NAME_PROBLEMS.url);
    }
  });

  it("refuses very long input before running the pattern checks", () => {
    expect(nameProblem("a".repeat(201))).toBe(NAME_PROBLEMS.long);
    expect(nameProblem("a".repeat(200))).toBeNull();
  });
});
