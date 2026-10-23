// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";

import {
  ago as agoText,
  messageDate,
  dateGroup,
  fileKind,
  fullDate,
  listDate,
  parseSearch,
  quoteBody,
  relativeTime,
  replyRecipients,
  replySubject,
  setDateStyle,
} from "./format";
import { listFilter } from "./mail-client";

const now = new Date("2026-10-22T12:00:00Z");
const ago = (sec: number) => new Date(now.getTime() - sec * 1000).toISOString();
const a = (email: string, name: string | null = null) => ({ email, name });

describe("webmail formatting", () => {
  it("shows relative times for three days, then dates", () => {
    expect(relativeTime(ago(10), now)).toBe("just now");
    expect(relativeTime(ago(24 * 60), now)).toBe("24 minutes ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3 hours ago");
    expect(relativeTime(ago(26 * 3600), now)).toBe("1 day ago");
    expect(relativeTime(ago(10 * 86_400), now)).toMatch(/12 Oct\.? 2026|Oct\.? 12, 2026/);
  });

  it("parses search operators and free text", () => {
    expect(parseSearch("  ")).toBeNull();
    expect(parseSearch('from:sam subject:"cabin weekend" has:attachment is:unread is:starred firewood')).toEqual({
      from: "sam",
      subject: "cabin weekend",
      hasAttachment: true,
      unread: true,
      flagged: true,
      text: "firewood",
    });
    expect(parseSearch("to:jordan@x.test")).toEqual({ to: "jordan@x.test" });
    expect(parseSearch("note:this")).toEqual({ text: "note:this" });
  });

  it("builds list filters for folders, Priority, search, narrowing and pinned sections", () => {
    expect(listFilter({ kind: "folder", id: "in" }, {}, ["tr", "jk"])).toEqual({ inMailbox: "in" });
    expect(listFilter({ kind: "priority" }, {}, ["tr"])).toEqual({
      operator: "AND",
      conditions: [{ inMailboxOtherThan: ["tr"] }, { hasKeyword: "$flagged" }],
    });
    expect(listFilter({ kind: "folder", id: "in" }, { search: { text: "x" } }, ["tr"])).toEqual({
      operator: "AND",
      conditions: [{ inMailboxOtherThan: ["tr"] }, { text: "x" }],
    });
    expect(listFilter({ kind: "folder", id: "tr" }, { search: { from: "s" } }, ["tr"])).toEqual({
      operator: "AND",
      conditions: [{ inMailbox: "tr" }, { from: "s" }],
    });
    expect(
      listFilter({ kind: "folder", id: "in" }, { unread: true, flagged: true, attachments: true }, [], {
        pinned: false,
      }),
    ).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "in" },
        { hasAttachment: true },
        { notKeyword: "$seen" },
        { hasKeyword: "$flagged" },
        { notKeyword: "$pinned" },
      ],
    });
    expect(listFilter({ kind: "folder", id: "in" }, {}, [], { pinned: true }).conditions).toContainEqual({
      hasKeyword: "$pinned",
    });
  });

  it("builds reply subjects and recipients without stacking prefixes or including yourself", () => {
    expect(replySubject("Re: RE: Hello", "reply")).toBe("Re: Hello");
    expect(replySubject("Fwd: Hello", "forward")).toBe("Fwd: Hello");
    expect(replySubject(null, "new")).toBe("");
    const msg = {
      from: [a("sam@x.test", "Sam")],
      to: [a("me@x.test"), a("jo@x.test")],
      cc: [a("pri@x.test"), a("ME@x.test")],
      replyTo: [],
    };
    expect(replyRecipients(msg, "reply", ["me@x.test"])).toEqual({ to: [a("sam@x.test", "Sam")], cc: [] });
    expect(replyRecipients(msg, "replyAll", ["me@x.test"])).toEqual({
      to: [a("sam@x.test", "Sam"), a("jo@x.test")],
      cc: [a("pri@x.test")],
    });
    expect(replyRecipients({ ...msg, replyTo: [a("list@x.test")] }, "reply", ["me@x.test"]).to).toEqual([
      a("list@x.test"),
    ]);
    // Replying to your own sent message goes to its recipients.
    expect(replyRecipients({ ...msg, from: [a("me@x.test")] }, "reply", ["me@x.test"]).to).toEqual([a("jo@x.test")]);
    expect(replyRecipients(msg, "forward", ["me@x.test"])).toEqual({ to: [], cc: [] });
  });

  it("quotes replies and forwards", () => {
    const msg = {
      from: [a("sam@x.test", "Sam")],
      to: [a("me@x.test")],
      cc: [],
      subject: "Hi",
      receivedAt: "2026-10-20T10:00:00Z",
      quote: "line one\n> older",
    };
    const r = quoteBody(msg, "reply");
    expect(r).toContain("Sam <sam@x.test> wrote:");
    expect(r).toContain("> line one\n>> older");
    const f = quoteBody(msg, "forward");
    expect(f).toContain("---------- Forwarded message ----------");
    expect(f).toContain("Subject: Hi");
    expect(quoteBody(msg, "new")).toBe("");
  });

  it("classifies attachments for their icon", () => {
    expect(fileKind("image/png", "a.png")).toBe("image");
    expect(fileKind("application/octet-stream", "a.PDF")).toBe("pdf");
    expect(fileKind("text/csv", "a.csv")).toBe("sheet");
    expect(fileKind("application/zip", "a.zip")).toBe("archive");
    expect(fileKind("text/plain", "a.txt")).toBe("text");
    expect(fileKind("application/x-thing", "a.bin")).toBe("file");
  });
});

describe("date style and date headers", () => {
  afterEach(() => {
    setDateStyle({ locale: "en-CA" });
  });

  it("groups messages by day, week and month in the chosen time zone", () => {
    setDateStyle({ locale: "en-CA", timeZone: "UTC" });
    // Thursday 22 October 2026, noon UTC.
    const now = new Date("2026-10-22T12:00:00Z");
    expect(dateGroup("2026-10-22T01:00:00Z", now)).toBe("Today");
    expect(dateGroup("2026-10-21T23:00:00Z", now)).toBe("Yesterday");
    expect(dateGroup("2026-10-19T09:00:00Z", now)).toBe("Earlier this week");
    expect(dateGroup("2026-10-14T09:00:00Z", now)).toBe("Last week");
    expect(dateGroup("2026-10-02T09:00:00Z", now)).toBe("Earlier this month");
    expect(dateGroup("2026-09-02T09:00:00Z", now)).toBe("September 2026");
    // In Vancouver it's still the 21st at 01:00 UTC on the 22nd.
    setDateStyle({ locale: "en-CA", timeZone: "America/Vancouver" });
    expect(dateGroup("2026-10-22T01:00:00Z", now)).toBe("Yesterday");
  });

  it("writes dates in the region's style, zone and hour cycle", () => {
    setDateStyle({ locale: "en-GB", timeZone: "UTC", hourCycle: "h23" });
    expect(fullDate("2026-10-22T21:30:00Z")).toMatch(/22 Oct 2026.*21:30/);
    setDateStyle({ locale: "en-US", timeZone: "UTC", hourCycle: "h12" });
    expect(fullDate("2026-10-22T21:30:00Z")).toMatch(/Oct 22, 2026.*9:30\sPM/);
    expect(listDate("2026-10-22T21:30:00Z", new Date("2026-10-22T22:00:00Z"))).toMatch(/9:30\sPM/);
  });
});

describe("conversation dates", () => {
  it("writes the date with how long ago it was", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(agoText("2026-10-23T11:59:30Z", now)).toBe("just now");
    expect(agoText("2026-10-18T12:00:00Z", now)).toBe("5 days ago");
    expect(agoText("2026-06-23T12:00:00Z", now)).toBe("4 months ago");
    expect(messageDate("2026-10-18T12:00:00Z", now)).toMatch(/\(5 days ago\)$/);
    expect(messageDate("2025-10-18T12:00:00Z", now)).toMatch(/2025/);
  });
});
