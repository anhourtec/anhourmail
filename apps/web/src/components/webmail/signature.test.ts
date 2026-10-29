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

describe("signatures in the composer (plain text)", () => {
  it("adds the signature after the conventional separator, above any quoted text", () => {
    expect(signatureBlock("Sam")).toBe("\n\n-- \nSam");
    expect(signatureBlock("  ")).toBe("");
    expect(signatureBlock(undefined)).toBe("");
    expect(initialBody(seed({ signature: "new" }), "Sam")).toBe("\n\n-- \nSam");
    expect(initialBody(seed({ signature: "reply", text: "\n\nOn … wrote:\n> hi" }), "Sam")).toBe(
      "\n\n-- \nSam\n\nOn … wrote:\n> hi",
    );
    // Reopening a draft never adds another one.
    expect(initialBody(seed({ text: "Draft text" }), "Sam")).toBe("Draft text");
  });

  it("switches only the signature, even after it was edited", () => {
    expect(swapSignature("Hello\n\n-- \nSam", "Help desk")).toBe("Hello\n\n-- \nHelp desk");
    expect(swapSignature("Hello\n\n-- \nSam L.\nPhone", "Desk")).toBe("Hello\n\n-- \nDesk");
    expect(swapSignature("\n\n-- \nSam", "Desk")).toBe("\n\n-- \nDesk");
    expect(swapSignature("-- \nSam", "Desk")).toBe("\n\n-- \nDesk");
    // Removing it.
    expect(swapSignature("Hello\n\n-- \nSam", undefined)).toBe("Hello");
    expect(swapSignature("Hello", "")).toBe("Hello");
    // None yet: it goes at the end of what you wrote.
    expect(swapSignature("Hello\n\n", "Sam")).toBe("Hello\n\n-- \nSam");
  });

  it("never touches the quoted message, which may have a signature of its own", () => {
    const quoted = "\n\n---------- Forwarded message ----------\nFrom: x@y.test\n\nBody\n-- \nTheir signature";
    const body = `Have a look${signatureBlock("Sam")}${quoted}`;
    expect(swapSignature(body, "Desk", quoted)).toBe(`Have a look\n\n-- \nDesk${quoted}`);
    expect(swapSignature(body, undefined, quoted)).toBe(`Have a look${quoted}`);
    // A reply without a signature yet: it goes above the quoted message.
    const reply = "\n\nOn … wrote:\n> hi";
    expect(swapSignature(`Thanks${reply}`, "Sam", reply)).toBe(`Thanks\n\n-- \nSam${reply}`);
    // The quoted part was edited: found by its first line instead.
    const edited = "Thanks\n\n-- \nSam\n\nOn … wrote:\n> hi (trimmed)";
    expect(swapSignature(edited, "Desk", reply)).toBe("Thanks\n\n-- \nDesk\n\nOn … wrote:\n> hi (trimmed)");
  });
});
