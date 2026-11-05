// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  cardFields,
  ContactInput,
  contactView,
  decodeQuotedPrintable,
  hasIdentity,
  MAX_IMPORT_CARDS,
  newCard,
  MAX_QP_VALUE,
  parseVcards,
  toVcards,
} from "./contacts";

const input = (over: Record<string, unknown> = {}) =>
  ContactInput.parse({
    given: "Sam",
    surname: "Rivera",
    emails: [{ address: "Sam@X.example", label: "work" }],
    phones: [{ number: "+1 250 555 0100", label: "mobile" }],
    organization: "Coastal Trail Runners",
    notes: "Runs on Sundays",
    birthday: { year: null, month: 4, day: 12 },
    labels: ["Friends"],
    ...over,
  });

describe("contact cards", () => {
  it("builds a JSContact card and reads it back", () => {
    const card = { id: "c1", ...newCard(input(), "b1") } as Parameters<typeof contactView>[0];
    expect(card).toMatchObject({ "@type": "Card", kind: "individual", addressBookIds: { b1: true } });
    expect(contactView(card)).toEqual({
      id: "c1",
      bookIds: ["b1"],
      name: "Sam Rivera",
      given: "Sam",
      surname: "Rivera",
      emails: [{ address: "sam@x.example", label: "work" }],
      phones: [{ number: "+1 250 555 0100", label: "mobile" }],
      organization: "Coastal Trail Runners",
      notes: "Runs on Sundays",
      birthday: { year: null, month: 4, day: 12 },
      labels: ["Friends"],
    });
  });

  it("cleans input: control characters, label characters, invalid phones and addresses", () => {
    expect(input({ notes: "a\u0000b‮c" }).notes).toBe("a b‮c");
    expect(input({ labels: ["  Book club!  "] }).labels).toEqual(["Book club!"]);
    expect(ContactInput.safeParse({ phones: [{ number: "<script>" }] }).success).toBe(false);
    expect(ContactInput.safeParse({ emails: [{ address: "nope" }] }).success).toBe(false);
    expect(
      ContactInput.safeParse({ emails: Array.from({ length: 11 }, () => ({ address: "a@x.example" })) }).success,
    ).toBe(false);
    expect(hasIdentity(ContactInput.parse({}))).toBe(false);
    expect(hasIdentity(ContactInput.parse({ emails: [{ address: "a@x.example" }] }))).toBe(true);
  });

  it("shows a name for cards without one, and ignores data it doesn't manage", () => {
    expect(contactView({ id: "x", emails: { e: { address: "z@x.example" } } }).name).toBe("z@x.example");
    const view = contactView({
      id: "y",
      name: { full: "Y" },
      phones: { p: { number: "1", contexts: { private: true } } },
    });
    expect(view.phones).toEqual([{ number: "1", label: "home" }]);
    expect(cardFields(input({ birthday: null, organization: "" }))).toMatchObject({
      anniversaries: {},
      organizations: {},
    });
  });
});

describe("contact values from cards are cleaned (run-16)", () => {
  it("strips control characters from what a card holds, keeping line breaks in notes", () => {
    const view = contactView({
      id: "x",
      name: { full: "Evil\r\nBCC: x\u0000" },
      emails: { e: { address: "a@x.example\r\n", label: "home\u0007" } },
      notes: { n: { note: "one\r\ntwo\u0000three" } },
      keywords: { "a\nb": true, off: false },
      organizations: { o: { name: "Org\u001b[31m" } },
    });
    expect(view.name).toBe("Evil  BCC: x");
    expect(view.emails).toEqual([{ address: "a@x.example", label: "home" }]);
    expect(view.notes).toBe("one\ntwo three");
    expect(view.labels).toEqual(["a b"]);
    expect(view.organization).toBe("Org [31m");
  });

  it("treats labels like prototype keys as plain labels", () => {
    expect(cardFields(input({ emails: [{ address: "a@x.example", label: "constructor" }] })).emails).toEqual({
      e1: { address: "a@x.example", label: "constructor" },
    });
    expect(contactView({ id: "y", phones: { p: { number: "1", contexts: { constructor: true } } } }).phones).toEqual([
      { number: "1", label: "constructor" },
    ]);
    expect(
      contactView({ id: "z", phones: { p: { number: "1", contexts: { toString: true } } } }).phones[0]?.label,
    ).toBe("toString");
  });

  it("never writes a raw line break or control character into a vCard", () => {
    const view = contactView({ id: "c", name: { full: "A\rB" }, notes: { n: { note: "x\r\ny\u0007z" } } });
    const out = toVcards([{ ...view, organization: "O\rP", labels: ["l\u0000m"] }]);
    const body = out.slice(0, -2).split("\r\n");
    for (const l of body) expect(l).not.toMatch(/\p{Cc}/u);
    expect(out).toContain("NOTE:x\\ny z");
    expect(out).toContain("ORG:O\\nP");
    expect(out).toContain("CATEGORIES:l m");
  });
});

describe("vCard import and export", () => {
  const vcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Jordan Lee",
    "N:Lee;Jordan;;;",
    "EMAIL;TYPE=INTERNET,HOME:Jordan@Lee.example",
    "TEL;TYPE=CELL:+1 604 555 0199",
    "ORG:Elm Street\\, Neighbours;Board",
    "NOTE:Line one\\nLine two",
    "BDAY:1990-07-04",
    "CATEGORIES:family,friends",
    "PHOTO;VALUE=uri:https://tracker.example/p.jpg",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:4.0",
    "FN:",
    "END:VCARD",
    "BEGIN:VCARD",
    "EMAIL:not-an-address",
    "END:VCARD",
    "BEGIN:VCARD",
    "FN:Folded",
    " Name",
    "BDAY:--0315",
    "END:VCARD",
  ].join("\r\n");

  it("parses the fields we keep, skips empty or invalid cards and never fetches anything", () => {
    const { contacts, invalid, tooMany } = parseVcards(vcf);
    expect([invalid, tooMany]).toEqual([2, false]);
    expect(contacts[0]).toMatchObject({
      name: "Jordan Lee",
      given: "Jordan",
      surname: "Lee",
      emails: [{ address: "jordan@lee.example", label: "home" }],
      phones: [{ number: "+1 604 555 0199", label: "mobile" }],
      organization: "Elm Street, Neighbours",
      notes: "Line one\nLine two",
      birthday: { year: 1990, month: 7, day: 4 },
      labels: ["family", "friends"],
    });
    expect(JSON.stringify(contacts)).not.toContain("tracker.example");
    expect(contacts[1]).toMatchObject({ name: "FoldedName", birthday: { year: null, month: 3, day: 15 } });
  });

  it("says when a file holds more cards than one import takes, and stays fast on a hostile file", () => {
    expect(MAX_IMPORT_CARDS).toBe(5000);
    const exactly = parseVcards("BEGIN:VCARD\nFN:x\nEND:VCARD\n".repeat(MAX_IMPORT_CARDS));
    expect([exactly.contacts.length, exactly.tooMany]).toEqual([MAX_IMPORT_CARDS, false]);
    const many = parseVcards("BEGIN:VCARD\nFN:x\nEND:VCARD\n".repeat(MAX_IMPORT_CARDS + 1));
    expect(many.tooMany).toBe(true);
    const t = performance.now();
    parseVcards(`BEGIN:VCARD\n${"N:".repeat(300_000)}\nEND:VCARD`);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("joins quoted-printable soft line breaks in linear time and caps the value (SA-66-02)", () => {
    // ~5 MB of one-character soft-broken lines in a single NOTE, then a second card that must still be read.
    const lines = Array.from({ length: 1_600_000 }, () => "a=");
    const file = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN:Long note",
      "EMAIL:long@example.org",
      "NOTE;ENCODING=QUOTED-PRINTABLE:=",
      ...lines,
      "end",
      "END:VCARD",
      "BEGIN:VCARD",
      "FN:Next",
      "EMAIL:next@example.org",
      "END:VCARD",
    ].join("\n");
    expect(file.length).toBeGreaterThan(4_500_000);
    const t = performance.now();
    const { contacts } = parseVcards(file);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(contacts.map((c) => c.name)).toEqual(["Long note", "Next"]);
    expect((contacts[0]?.notes ?? "").length).toBeLessThanOrEqual(MAX_QP_VALUE);
  });

  it("reads vCard 2.1: quoted-printable values (soft line breaks, charsets) and bare TYPE parameters", () => {
    const v21 = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BC=",
      "ller",
      "EMAIL;INTERNET;HOME:juergen@mueller.example",
      "TEL;CELL;VOICE:+49 30 555 0100",
      "TEL;WORK:+49 30 555 0101",
      "NOTE;QUOTED-PRINTABLE;CHARSET=ISO-8859-1:Caf=E9 on Fridays=0D=0Asecond line",
      "ORG;ENCODING=QUOTED-PRINTABLE:B=C3=A4ckerei;Sales",
      "END:VCARD",
    ].join("\r\n");
    const { contacts, invalid } = parseVcards(v21);
    expect(invalid).toBe(0);
    expect(contacts[0]).toMatchObject({
      name: "Jürgen Müller",
      given: "Jürgen",
      surname: "Müller",
      emails: [{ address: "juergen@mueller.example", label: "home" }],
      phones: [
        { number: "+49 30 555 0100", label: "mobile" },
        { number: "+49 30 555 0101", label: "work" },
      ],
      organization: "Bäckerei",
      notes: "Café on Fridays\nsecond line",
    });
  });

  it("decodes quoted-printable leniently: malformed escapes and 8-bit text stay as written, unknown charsets are UTF-8", () => {
    expect(decodeQuotedPrintable("a=3Db=ZZ=4")).toBe("a=b=ZZ=4");
    expect(decodeQuotedPrintable("caf=C3=A9 ü")).toBe("café ü");
    expect(decodeQuotedPrintable("=C3=A9", "no-such-charset")).toBe("é");
    expect(decodeQuotedPrintable("=E9", "windows-1252")).toBe("é");
  });

  it("exports escaped vCards that import back the same", () => {
    const view = contactView({
      id: "c1",
      ...newCard(input({ notes: "a, b; c\nd", labels: ["x,y"] }), "b"),
    });
    const out = toVcards([view]);
    expect(out).toContain("NOTE:a\\, b\\; c\\nd");
    expect(out).toContain("BDAY:--0412");
    expect(out.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\n")).toBe(true);
    const back = parseVcards(out).contacts[0];
    expect(back).toMatchObject({
      notes: "a, b; c\nd",
      given: "Sam",
      surname: "Rivera",
      birthday: { month: 4, day: 12 },
    });
  });
});
