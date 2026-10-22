// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { calendarEvents, markdownBlocks, textBlocks, unflow } from "./body";

describe("plain text", () => {
  it("joins format=flowed soft breaks and removes space-stuffing (RFC 3676)", () => {
    expect(unflow("one two \r\nthree\r\n\r\n four")).toBe("one two three\n\nfour");
    expect(unflow("> quoted \n> more\n>> deeper")).toBe("> quoted more\n>> deeper");
    expect(unflow("ab \ncd", true)).toBe("abcd");
    // The signature delimiter is never joined.
    expect(unflow("hi\n-- \nSam")).toBe("hi\n-- \nSam");
  });

  it("separates the message, a quoted reply with its attribution, and the signature", () => {
    const blocks = textBlocks(
      [
        "Sounds good.",
        "",
        "On Mon, Oct 19, 2026 at 9:14 AM Jordan <j@x.test> wrote:",
        "> Are we still on?",
        ">",
        ">> older",
        "",
        "-- ",
        "Sam",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "text", text: "Sounds good." },
      { kind: "quote", text: "On Mon, Oct 19, 2026 at 9:14 AM Jordan <j@x.test> wrote:\nAre we still on?\n\n> older" },
      { kind: "signature", text: "Sam" },
    ]);
  });

  it("treats bare > lines as a quote and keeps text after it", () => {
    expect(textBlocks("> a\n> b\nreply below\n").map((b) => b.kind)).toEqual(["quote", "text"]);
    expect(textBlocks("no quotes here\n\nat all")).toEqual([{ kind: "text", text: "no quotes here\n\nat all" }]);
    expect(textBlocks("")).toEqual([]);
  });

  it("stays fast on hostile input", () => {
    const t = performance.now();
    textBlocks(`${"wrote: ".repeat(100_000)}\n${"> x\n".repeat(50_000)}`);
    unflow(`${"a ".repeat(200_000)}\n`.repeat(3), true);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("markdown", () => {
  it("builds a safe AST: headings, lists, quotes, code, emphasis and links", () => {
    const md = markdownBlocks(
      "# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n```\nx < y\n```\n\n---\n\n[ok](https://x.example/a) [mail](mailto:a@x.test)",
    );
    expect(md[0]).toEqual({ t: "h", level: 1, c: [{ t: "text", v: "Title" }] });
    expect(md[1]).toMatchObject({ t: "p" });
    expect(JSON.stringify(md[1])).toContain('"t":"strong"');
    expect(md[2]).toMatchObject({ t: "list", ordered: false });
    expect(md[3]).toMatchObject({ t: "list", ordered: true, start: 1 });
    expect(md[4]).toMatchObject({ t: "quote" });
    expect(md[5]).toEqual({ t: "code", v: "x < y" });
    expect(md[6]).toEqual({ t: "hr" });
    expect(JSON.stringify(md[7])).toContain('"href":"https://x.example/a"');
    expect(JSON.stringify(md[7])).toContain('"href":"mailto:a@x.test"');
  });

  it("never produces markup, unsafe links or remote images", () => {
    const md = markdownBlocks(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) ![pic](https://t.example/p.gif) <b onclick="x">b</b>',
    );
    const json = JSON.stringify(md);
    expect(json).not.toContain('"href":"javascript');
    expect(json).not.toMatch(/"t":"(?:html|image)"/);
    expect(json).toContain("[image: pic]");
    // Raw HTML survives only as text (React escapes it).
    expect(json).toContain("<script>alert(1)</script>");
  });

  it("bounds depth and size", () => {
    expect(() => markdownBlocks(`${"> ".repeat(500)}deep`)).not.toThrow();
    expect(() => markdownBlocks(`${"*".repeat(10_000)}x`)).not.toThrow();
    expect(markdownBlocks("x".repeat(1_000_000))).toHaveLength(1);
  });
});

describe("calendar invitations", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "SUMMARY:Block party",
    "DTSTART:20261031T180000Z",
    "DTEND:20261031T210000Z",
    "LOCATION:Hall\\, 12 Elm",
    "ORGANIZER;CN=Priya Shah:mailto:p@x.test",
    "DESCRIPTION:Bring a dish.\\nMusic fr",
    " om 7.",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:Cleanup",
    "DTSTART;VALUE=DATE:20261101",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "SUMMARY:Local time",
    "DTSTART;TZID=America/Vancouver:20261102T090000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads events, times, location, organizer and description (unfolded, unescaped)", () => {
    const [a, b, c] = calendarEvents(ics);
    expect(a).toEqual({
      summary: "Block party",
      start: "2026-10-31T18:00:00Z",
      end: "2026-10-31T21:00:00Z",
      allDay: false,
      timeZone: null,
      location: "Hall, 12 Elm",
      organizer: { name: "Priya Shah", email: "p@x.test" },
      description: "Bring a dish.\nMusic from 7.",
      method: "REQUEST",
    });
    expect(b).toMatchObject({ summary: "Cleanup", start: "2026-11-01", allDay: true });
    expect(c).toMatchObject({ start: "2026-11-02T09:00", timeZone: "America/Vancouver" });
  });

  it("caps events and survives junk", () => {
    const many = `BEGIN:VCALENDAR\n${"BEGIN:VEVENT\nSUMMARY:x\nEND:VEVENT\n".repeat(20)}END:VCALENDAR`;
    expect(calendarEvents(many)).toHaveLength(5);
    expect(calendarEvents("not a calendar")).toEqual([]);
    expect(calendarEvents("BEGIN:VEVENT\nDTSTART:garbage\nEND:VEVENT")[0]?.start).toBeNull();
  });
});
