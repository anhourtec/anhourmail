// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { type ComposeSeed, initialBody, signatureBlock, swapSignature } from "./composer";

const seed = (over: Partial<ComposeSeed> = {}): ComposeSeed => ({
  title: "New message",
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  text: "",
  attachments: [],
  focus: "to",
  ...over,
});

describe("signatures in the composer", () => {
  it("adds the signature after the conventional separator, above any quoted text", () => {
    expect(signatureBlock("Sam")).toBe("\n\n-- \nSam");
    expect(signatureBlock("  ")).toBe("");
    expect(signatureBlock(undefined)).toBe("");
    expect(initialBody(seed({ signature: true }), "Sam")).toBe("\n\n-- \nSam");
    expect(initialBody(seed({ signature: true, text: "\n\nOn … wrote:\n> hi" }), "Sam")).toBe(
      "\n\n-- \nSam\n\nOn … wrote:\n> hi",
    );
    // Reopening a draft never adds another one.
    expect(initialBody(seed({ text: "Draft text" }), "Sam")).toBe("Draft text");
  });

  it("swaps the signature when the sender changes, only if it wasn't edited", () => {
    const body = "Hello\n\n-- \nSam";
    expect(swapSignature(body, "Sam", "Help desk")).toBe("Hello\n\n-- \nHelp desk");
    expect(swapSignature(body, "Sam", "")).toBe("Hello");
    expect(swapSignature("\n\nOn … wrote:", undefined, "Sam")).toBe("\n\n-- \nSam\n\nOn … wrote:");
    expect(swapSignature("\n\n-- \nSam\n\n> quote", "Sam", "Desk")).toBe("\n\n-- \nDesk\n\n> quote");
    expect(swapSignature("Hello", "", "")).toBe("Hello");
    // Edited by hand: left alone.
    expect(swapSignature("Hello\n\n-- \nSam L.", "Sam", "Help desk")).toBe("Hello\n\n-- \nSam L.");
  });
});
