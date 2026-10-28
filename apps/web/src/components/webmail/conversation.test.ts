// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  defaultExpanded,
  fromHere,
  isMine,
  type MailChange,
  mergeExpanded,
  recipientLabel,
  restoreTarget,
  sameThread,
  senderLabel,
  touchesThread,
} from "./conversation";

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

describe("keeping an open conversation current", () => {
  const change = (patch: Partial<MailChange> = {}): MailChange => ({
    seq: 1,
    all: false,
    threadIds: new Set(),
    emailIds: new Set(),
    ...patch,
  });

  it("loads again for a new message in its thread, a change to a message it shows, or Refresh", () => {
    expect(touchesThread(change({ threadIds: new Set(["t1"]) }), "t1", ["a"])).toBe(true);
    expect(touchesThread(change({ emailIds: new Set(["a"]) }), "t1", ["a", "b"])).toBe(true);
    expect(touchesThread(change({ all: true }), "t1", ["a"])).toBe(true);
    expect(touchesThread(change({ threadIds: new Set(["t2"]), emailIds: new Set(["z"]) }), "t1", ["a"])).toBe(false);
  });

  it("notices when nothing it shows changed", () => {
    const a = { id: "a", keywords: { $seen: true }, mailboxIds: { in: true } };
    expect(sameThread([a], [{ ...a }])).toBe(true);
    expect(sameThread([a], [{ ...a, keywords: { $seen: true, $flagged: true } }])).toBe(false);
    expect(sameThread([a], [{ ...a, mailboxIds: { arch: true } }])).toBe(false);
    expect(sameThread([a], [a, { ...a, id: "b" }])).toBe(false);
  });

  it("keeps what the person expanded or collapsed and opens a newly arrived reply", () => {
    const before = [msg("a"), msg("b"), msg("c")];
    // The person expanded "a" and collapsed the newest, "c".
    const expanded = new Set(["a"]);
    const after = [...before, msg("d", {})];
    expect([...mergeExpanded(before, after, expanded)].sort()).toEqual(["a", "d"]);
    // Nothing new: exactly what was expanded (a removed message drops out).
    expect([...mergeExpanded(before, [msg("a"), msg("c")], new Set(["a", "b"]))]).toEqual(["a"]);
    // A new message that is already read still opens when it is the newest.
    expect([...mergeExpanded(before, [...before, msg("e")], new Set())]).toEqual(["e"]);
    // A new draft doesn't take over from the newest sent message.
    expect([...mergeExpanded(before, [...before, msg("dr", { $draft: true })], new Set(["c"]))]).toEqual(["c"]);
  });
});
