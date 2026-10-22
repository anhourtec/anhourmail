// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  cardFields,
  ContactInput,
  contactView,
  hasIdentity,
  MAX_IMPORT_CARDS,
  newCard,
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
    const { contacts, skipped } = parseVcards(vcf);
    expect(skipped).toBe(2);
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

  it("caps cards and stays fast on a hostile file", () => {
    const many = "BEGIN:VCARD\nFN:x\nEND:VCARD\n".repeat(MAX_IMPORT_CARDS + 50);
    const r = parseVcards(many);
    expect(r.contacts).toHaveLength(MAX_IMPORT_CARDS);
    expect(r.skipped).toBe(50);
    const t = performance.now();
    parseVcards(`BEGIN:VCARD\n${"N:".repeat(300_000)}\nEND:VCARD`);
    expect(performance.now() - t).toBeLessThan(500);
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
