// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { param } from "./search-params";

describe("page search params", () => {
  it("reads one non-empty string and ignores arrays, empties and missing keys", () => {
    expect(param({ mailbox: "abc" }, "mailbox")).toBe("abc");
    expect(param({ mailbox: ["a", "b"] }, "mailbox")).toBeNull();
    expect(param({ mailbox: "" }, "mailbox")).toBeNull();
    expect(param({}, "mailbox")).toBeNull();
    expect(param({ q: "x".repeat(300) }, "q")).toHaveLength(100);
  });
});
