// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { defaultExpanded, fromHere, isMine, recipientLabel, restoreTarget, senderLabel } from "./conversation";

const mine = new Set(["me@dev.test", "alias@dev.test"]);
const msg = (id: string, keywords: Record<string, boolean> = { $seen: true }) => ({ id, keywords });

describe("defaultExpanded", () => {
  it("opens the newest message and every unread one", () => {
    expect([...defaultExpanded([msg("a"), msg("b", {}), msg("c"), msg("d")])].sort()).toEqual(["b", "d"]);
  });

  it("skips an unsent draft at the end in favour of the newest real message", () => {
    expect([...defaultExpanded([msg("a"), msg("b"), msg("draft", { $draft: true })])]).toEqual(["b"]);
  });

  it("opens a lone draft and handles an empty conversation", () => {
    expect([...defaultExpanded([msg("draft", { $draft: true })])]).toEqual(["draft"]);
    expect(defaultExpanded([]).size).toBe(0);
  });
});

describe("recipient and sender labels", () => {
  const sam = { name: "Sam Lee", email: "sam@example.org" };
  const me = { name: null, email: "Me@dev.test" };

  it("says 'to me' when you are a recipient, with how many others", () => {
    expect(recipientLabel([me], [], mine)).toBe("to me");
    expect(recipientLabel([sam], [me], mine)).toBe("to me and 1 other");
    expect(recipientLabel([sam, { name: null, email: "x@example.org" }], [me], mine)).toBe("to me and 2 others");
  });

  it("names the first recipient otherwise", () => {
    expect(recipientLabel([sam], [], mine)).toBe("to Sam Lee");
    expect(recipientLabel([{ name: null, email: "kim@example.org" }, sam], [], mine)).toBe("to kim and 1 other");
    expect(recipientLabel([], [], mine)).toBe("to undisclosed recipients");
  });

  it("shows your own messages as 'me'", () => {
    expect(senderLabel(me, mine)).toBe("me");
    expect(senderLabel(sam, mine)).toBe("Sam Lee");
    expect(isMine(null, mine)).toBe(false);
  });
});

describe("restoreTarget", () => {
  const roles = { inbox: "inbox-id", sent: "sent-id" };

  it("puts your own messages back in Sent and the rest in the Inbox", () => {
    expect(restoreTarget([{ name: null, email: "alias@dev.test" }], mine, roles)).toBe("sent-id");
    expect(restoreTarget([{ name: null, email: "sam@example.org" }], mine, roles)).toBe("inbox-id");
    expect(restoreTarget(null, mine, roles)).toBe("inbox-id");
  });

  it("falls back to the Inbox when there is no Sent folder", () => {
    expect(restoreTarget([{ name: null, email: "me@dev.test" }], mine, { inbox: "inbox-id" })).toBe("inbox-id");
  });
});

describe("fromHere", () => {
  it("lists this message and every later one", () => {
    expect(fromHere([{ id: "a" }, { id: "b" }, { id: "c" }], "b")).toEqual(["b", "c"]);
    expect(fromHere([{ id: "a" }], "zzz")).toEqual([]);
  });
});
