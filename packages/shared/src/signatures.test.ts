// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { copyName, defaultSignature, sameSignatureName, signatureName, WEBMAIL_SIGNATURES } from "./signatures";

describe("signature names", () => {
  it("tidies names and refuses empty or long ones", () => {
    expect(signatureName("  Work\n signature\u0007 ")).toBe("Work signature");
    expect(signatureName("")).toBeNull();
    expect(signatureName("   ")).toBeNull();
    expect(signatureName(42)).toBeNull();
    expect(signatureName("x".repeat(WEBMAIL_SIGNATURES.nameChars))).toHaveLength(32);
    expect(signatureName("x".repeat(WEBMAIL_SIGNATURES.nameChars + 1))).toBeNull();
    // Counted in characters, not UTF-16 units.
    expect(signatureName("😀".repeat(32))).not.toBeNull();
    expect(signatureName("​Work‎")).toBe("Work");
  });

  it("compares names ignoring case but not accents", () => {
    expect(sameSignatureName("Work", "WORK")).toBe(true);
    expect(sameSignatureName("Résumé", "resume")).toBe(false);
  });

  it("names copies so they fit and don't clash", () => {
    expect(copyName("Work", ["Work"])).toBe("Work (copy)");
    expect(copyName("Work", ["Work", "work (copy)"])).toBe("Work (copy 2)");
    const long = "x".repeat(32);
    expect(copyName(long, [long])).toBe(`${"x".repeat(25)} (copy)`);
    expect(Array.from(copyName(long, [long])).length).toBeLessThanOrEqual(32);
  });
});

describe("default signatures", () => {
  const set = {
    signatures: [
      { id: "a", name: "A", html: "<p>A</p>", text: "A" },
      { id: "b", name: "B", html: "<p>B</p>", text: "B" },
    ],
    defaults: { newMessage: "a", reply: "b" },
  };
  it("picks the default for the kind of message, if it still exists", () => {
    expect(defaultSignature(set, "new")?.id).toBe("a");
    expect(defaultSignature(set, "reply")?.id).toBe("b");
    expect(defaultSignature({ ...set, defaults: { newMessage: null, reply: "gone" } }, "new")).toBeNull();
    expect(defaultSignature({ ...set, defaults: { newMessage: null, reply: "gone" } }, "reply")).toBeNull();
    expect(defaultSignature(null, "new")).toBeNull();
  });
});
