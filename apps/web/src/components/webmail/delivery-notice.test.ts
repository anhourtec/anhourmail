// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { NAMED_ADDRESSES, notYetShown, type Undelivered, undeliveredNotice } from "./delivery-notice";

const NO_MAILBOX = "No mailbox with this address exists.";
const u = (email: string, reason = NO_MAILBOX, code: string | null = "5.1.2"): Undelivered => ({ email, code, reason });

describe("undeliveredNotice", () => {
  it("says nothing when everything was delivered", () => {
    expect(undeliveredNotice([])).toBeNull();
  });

  it("names one address with the reason and its short code", () => {
    expect(undeliveredNotice([u("nobody@dev.test")])).toEqual({
      message: "Not delivered to nobody@dev.test",
      detail: ["No mailbox with this address exists. (5.1.2)"],
    });
    expect(undeliveredNotice([u("x@dev.test", "The receiving server refused this message.", null)])?.detail).toEqual([
      "The receiving server refused this message.",
    ]);
  });

  it("groups several addresses by reason and counts what it doesn't name", () => {
    expect(
      undeliveredNotice([
        u("a@dev.test"),
        u("full@dev.test", "The recipient's mailbox is full.", "5.2.2"),
        u("b@dev.test"),
      ]),
    ).toEqual({
      message: "Not delivered to 3 addresses",
      detail: [
        "a@dev.test, b@dev.test: No mailbox with this address exists. (5.1.2)",
        "full@dev.test: The recipient's mailbox is full. (5.2.2)",
      ],
    });
    const many = Array.from({ length: NAMED_ADDRESSES + 3 }, (_, i) => u(`n${String(i)}@dev.test`));
    const notice = undeliveredNotice(many);
    expect(notice?.message).toBe(`Not delivered to ${String(NAMED_ADDRESSES + 3)} addresses`);
    expect(notice?.detail.at(-1)).toBe("And 3 more.");
    expect(notice?.detail[0]?.split(", ")).toHaveLength(NAMED_ADDRESSES);
  });
});

describe("notYetShown", () => {
  it("passes each address on once, whatever its case", () => {
    const shown = new Set<string>();
    expect(notYetShown(shown, [u("A@dev.test")])).toEqual([u("A@dev.test")]);
    expect(notYetShown(shown, [u("a@dev.test"), u("b@dev.test")])).toEqual([u("b@dev.test")]);
    expect(notYetShown(shown, [])).toEqual([]);
  });
});
