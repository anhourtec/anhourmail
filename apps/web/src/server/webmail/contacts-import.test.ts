// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { detectCsvColumns, IMPORT } from "@anhourmail/shared/import";

import { ContactInput, newCard } from "./contacts";
import {
  CONTACTS_FILE_TOO_LARGE,
  CONTACTS_FILE_TOO_MANY,
  CSV_ERROR_TEXT,
  CSV_FIELD_LABELS,
  decodeColumns,
  encodeColumns,
  readContactsCsv,
} from "./contacts-csv";
import { additionsPatch, columnsFit, csvContacts, type ExistingCard, planContactsImport } from "./contacts-import";

const enc = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string) => {
  const out = new Uint8Array(2 + s.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) & 0xff;
    out[3 + i * 2] = s.charCodeAt(i) >> 8;
  }
  return out;
};
const table = (bytes: Uint8Array) => {
  const r = readContactsCsv(bytes);
  if (!r.ok) throw new Error(r.error);
  return r.table;
};
const contact = (over: Record<string, unknown> = {}) => ContactInput.parse(over);
const card = (id: string, c: ContactInput, extra: Record<string, unknown> = {}): ExistingCard => ({
  id,
  ...newCard(c, "b1"),
  ...extra,
});

describe("reading a contacts CSV", () => {
  it("reads comma, semicolon and tab files, UTF-8 with or without a BOM and UTF-16 with a BOM", () => {
    const rows = "First Name,Last Name,E-mail Address\r\nSam,Rivera,sam@x.test\r\n";
    expect(table(enc(rows)).rows).toEqual([["Sam", "Rivera", "sam@x.test"]]);
    expect(table(enc(`${String.fromCharCode(0xfeff)}${rows}`)).header[0]).toBe("First Name");
    expect(table(enc(rows.replace(/,/g, ";"))).delimiter).toBe(";");
    expect(table(enc(rows.replace(/,/g, "\t"))).delimiter).toBe("\t");
    expect(table(utf16le("Name;Email\r\nZoë;zoe@x.test\r\n")).rows).toEqual([["Zoë", "zoe@x.test"]]);
  });

  it("refuses other encodings, more rows than one import takes and files over the size limit, with what to do", () => {
    // A Windows code page byte (é as 0xE9) isn't UTF-8.
    expect(readContactsCsv(new Uint8Array([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9]))).toEqual({
      ok: false,
      error: "encoding",
    });
    expect(CSV_ERROR_TEXT.encoding).toMatch(/Save it as UTF-8/);
    const many = `Name\r\n${"x\r\n".repeat(IMPORT.contactsMaxCards + 1)}`;
    expect(readContactsCsv(enc(many))).toEqual({ ok: false, error: "too_many_rows" });
    expect(readContactsCsv(enc(`Name\r\n${"x\r\n".repeat(IMPORT.contactsMaxCards)}`)).ok).toBe(true);
    expect(readContactsCsv(new Uint8Array(IMPORT.contactsMaxBytes + 1))).toEqual({ ok: false, error: "too_large" });
    expect(CONTACTS_FILE_TOO_LARGE).toBe("Contact files can be up to 5 MB.");
    expect(CONTACTS_FILE_TOO_MANY).toMatch(/up to 5,000 contacts/);
    expect(CSV_ERROR_TEXT.too_many_rows).toBe(CONTACTS_FILE_TOO_MANY);
  });

  it("carries the mapping in the request: field names or empty, nothing else", () => {
    const cols = ["given", null, "emails"] as const;
    expect(encodeColumns(cols)).toBe("given,,emails");
    expect(decodeColumns("given,,emails")).toEqual(cols);
    expect(decodeColumns(",emails")).toEqual([null, "emails"]);
    for (const bad of [null, "", "given,password", "__proto__", "x".repeat(4001)])
      expect(decodeColumns(bad)).toBeNull();
    expect(Object.keys(CSV_FIELD_LABELS)).toHaveLength(9);
  });
});

describe("CSV rows to contacts", () => {
  const file = table(
    enc(
      [
        "First Name,Last Name,Display Name,E-mail Address,E-mail 2 Address,Home Phone,Mobile Phone,Company,Birthday,Notes,Group Membership,Middle Name",
        'Sam,Rivera,,Sam@X.test,"sam.r@x.test ::: other@x.test",+1 604 555 0100,+1 604 555 0101,Trail Club,1990-07-04,"Line one\nLine two",* starred ::: Friends ::: Family,J',
        ",,Jo Park,,,,,,--03-15,,,",
        ",,,,,,,,,,,Only a middle name",
        "Bad,Address,,not-an-address,,,,,,,,",
      ].join("\r\n"),
    ),
  );

  it("maps columns by the detected fields: several address and phone columns, labels from headers, groups split", () => {
    const columns = detectCsvColumns(file.header);
    expect(columns.at(-1)).toBeNull();
    expect(columnsFit(file, columns)).toBe(true);
    const { contacts, invalid } = csvContacts(file, columns);
    expect(invalid).toBe(2);
    expect(contacts[0]).toMatchObject({
      given: "Sam",
      surname: "Rivera",
      emails: [{ address: "sam@x.test" }, { address: "sam.r@x.test" }, { address: "other@x.test" }],
      phones: [
        { number: "+1 604 555 0100", label: "home" },
        { number: "+1 604 555 0101", label: "mobile" },
      ],
      organization: "Trail Club",
      birthday: { year: 1990, month: 7, day: 4 },
      notes: "Line one\nLine two",
      labels: ["Friends", "Family"],
    });
    expect(contacts[1]).toMatchObject({ name: "Jo Park", birthday: { year: null, month: 3, day: 15 } });
  });

  it("follows a changed mapping: ignored columns stay out, a single field takes the first non-empty column", () => {
    const columns = detectCsvColumns(file.header).map((c, i) => (i === 3 ? null : c));
    // "Middle Name" as the company: Sam's company is already from the Company column, which comes first.
    columns[11] = "organization";
    const { contacts } = csvContacts(file, columns);
    expect(contacts[0]?.emails.map((e) => e.address)).toEqual(["sam.r@x.test", "other@x.test"]);
    expect(contacts[0]?.organization).toBe("Trail Club");
    // A company alone isn't a contact (no name, address or phone).
    expect(contacts.some((c) => c.organization === "Only a middle name")).toBe(false);
  });

  it("doesn't fit a mapping of another length or one that imports nothing", () => {
    expect(columnsFit(file, [null])).toBe(false);
    expect(
      columnsFit(
        file,
        file.header.map(() => null),
      ),
    ).toBe(false);
  });

  it("leaves out a birthday it can't read rather than the contact", () => {
    const t = table(enc("Name,Birthday\r\nAl,07/04/1990\r\n"));
    expect(csvContacts(t, ["fullName", "birthday"]).contacts[0]).toMatchObject({ name: "Al", birthday: null });
  });
});

describe("merging an import by email", () => {
  it("creates new contacts and fills only empty fields of a matching card, case-insensitively", () => {
    const existing = [
      card("k1", contact({ given: "Sam", emails: [{ address: "sam@x.test" }], organization: "Old Co" })),
    ];
    const plan = planContactsImport(
      existing,
      [
        contact({
          given: "Samuel",
          emails: [{ address: "SAM@x.test" }, { address: "sam2@x.test" }],
          organization: "New Co",
          notes: "met at the trail",
          phones: [{ number: "+1 604 555 0100" }],
          labels: ["hiking"],
        }),
        contact({ name: "New Person", emails: [{ address: "new@x.test" }] }),
      ],
      10,
    );
    expect(plan.counts).toEqual({ merged: 1, duplicates: 0, overCap: 0 });
    expect(plan.creates.map((c) => c.input.name)).toEqual(["New Person"]);
    expect(plan.updates).toHaveLength(1);
    const patch = plan.updates[0]?.patch ?? {};
    // Company and name are kept; new addresses, phones, notes and labels are added under their own keys.
    expect(Object.keys(patch).sort()).toEqual(["emails/ie1", "keywords/hiking", "notes/in1", "phones/ip1"]);
    expect(patch["emails/ie1"]).toEqual({ address: "sam2@x.test" });
    expect(JSON.stringify(patch)).not.toContain("New Co");
    expect(JSON.stringify(patch)).not.toContain("Samuel");
  });

  it("counts a contact adding nothing as a duplicate, and merges later contacts of the file into earlier ones", () => {
    const existing = [card("k1", contact({ given: "Sam", emails: [{ address: "sam@x.test" }] }))];
    const plan = planContactsImport(
      existing,
      [
        contact({ given: "Sam", emails: [{ address: "sam@x.test" }] }),
        contact({ given: "Ana", emails: [{ address: "ana@x.test" }] }),
        contact({ given: "Ana B", emails: [{ address: "ANA@x.test" }], phones: [{ number: "555 0100" }] }),
        contact({ given: "Ana", emails: [{ address: "ana@x.test" }] }),
      ],
      10,
    );
    expect(plan.counts).toEqual({ merged: 1, duplicates: 2, overCap: 0 });
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]).toMatchObject({ input: { given: "Ana", phones: [{ number: "555 0100" }] }, mergedIn: 1 });
  });

  it("checks address-less duplicates with one lookup per phone, and sees phones a merge added (SA-66-03)", () => {
    const existing = Array.from({ length: 5000 }, (_, i) =>
      card(`e${String(i)}`, contact({ name: `Person ${String(i)}`, phones: [{ number: `+1 604 555 ${String(i)}` }] })),
    );
    const incoming = Array.from({ length: 5000 }, (_, i) =>
      contact({ name: `Person ${String(i)}`, phones: [{ number: `+1604555${String(i)}` }] }),
    );
    const t = performance.now();
    const plan = planContactsImport(existing, incoming, 5000);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(plan.counts.duplicates).toBe(5000);
    // A phone merged onto a card by address is matched by a later address-less copy.
    const merged = planContactsImport(
      [card("a", contact({ name: "Ana Diaz", emails: [{ address: "ana@example.org" }] }))],
      [
        contact({ emails: [{ address: "ana@example.org" }], phones: [{ number: "+44 20 7946 0000" }] }),
        contact({ name: "Ana Diaz", phones: [{ number: "+442079460000" }] }),
      ],
      10,
    );
    expect(merged.counts).toEqual({ merged: 1, duplicates: 1, overCap: 0 });
  });

  it("skips a contact without an address when the same full name has the same phone number", () => {
    const existing = [
      card("k1", contact({ given: "Lee", surname: "Wong", phones: [{ number: "+1 (604) 555-0100" }] })),
    ];
    const plan = planContactsImport(
      existing,
      [
        contact({ name: "lee  wong", phones: [{ number: "+16045550100" }] }),
        contact({ name: "Lee Wong", phones: [{ number: "+1 604 555 0199" }] }),
        contact({ name: "Lee Wong" }),
        contact({ name: "Kim", phones: [{ number: "1" }] }),
        contact({ name: "Kim", phones: [{ number: "1" }] }),
      ],
      10,
    );
    expect(plan.counts.duplicates).toBe(2);
    expect(plan.creates.map((c) => c.input.name)).toEqual(["Lee Wong", "Lee Wong", "Kim"]);
  });

  it("stops new cards at the mailbox's room; merges into existing cards still happen", () => {
    const existing = [card("k1", contact({ given: "Sam", emails: [{ address: "sam@x.test" }] }))];
    const incoming = [
      contact({ name: "A", emails: [{ address: "a@x.test" }] }),
      contact({ name: "B", emails: [{ address: "b@x.test" }] }),
      contact({ name: "B again", emails: [{ address: "b@x.test" }], notes: "n" }),
      contact({ emails: [{ address: "sam@x.test" }], notes: "fills" }),
    ];
    const plan = planContactsImport(existing, incoming, 1);
    expect(plan.creates.map((c) => c.input.name)).toEqual(["A"]);
    expect(plan.counts).toEqual({ merged: 1, duplicates: 0, overCap: 2 });
    expect(plan.updates[0]?.patch).toEqual({ "notes/in1": { note: "fills" } });
    expect(planContactsImport([], incoming, 0).creates).toEqual([]);
  });

  it("never copies an address that's on another card, and caps addresses and labels at ten", () => {
    const existing = [
      card("k1", contact({ given: "One", emails: [{ address: "one@x.test" }] })),
      card("k2", contact({ given: "Two", emails: [{ address: "two@x.test" }] })),
    ];
    const plan = planContactsImport(
      existing,
      [
        contact({ emails: [{ address: "one@x.test" }, { address: "two@x.test" }] }),
        contact({ given: "Three", emails: [{ address: "three@x.test" }, { address: "two@x.test" }] }),
      ],
      10,
    );
    // The first adds nothing (two@ belongs to Two); the second matches Two by two@ and adds three@ there.
    expect(plan.counts).toEqual({ merged: 1, duplicates: 1, overCap: 0 });
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([{ id: "k2", patch: { "emails/ie1": { address: "three@x.test" } }, mergedIn: 1 }]);
    const full = card(
      "k3",
      contact({
        given: "Full",
        emails: Array.from({ length: 10 }, (_, i) => ({ address: `f${String(i)}@x.test` })),
        labels: Array.from({ length: 10 }, (_, i) => `l${String(i)}`),
      }),
    );
    const capped = planContactsImport(
      [full],
      [contact({ emails: [{ address: "f0@x.test" }, { address: "extra@x.test" }], labels: ["more"] })],
      10,
    );
    expect(capped.counts.duplicates).toBe(1);
  });

  it("ignores groups and other non-person cards", () => {
    const group = { ...card("g1", contact({ name: "Team", emails: [{ address: "team@x.test" }] })), kind: "group" };
    const plan = planContactsImport([group], [contact({ name: "Team", emails: [{ address: "team@x.test" }] })], 10);
    expect(plan.creates).toHaveLength(1);
  });
});

describe("the patch for an existing card", () => {
  it("adds entries under unused keys inside maps that exist, and whole maps where the card had none", () => {
    const existing: ExistingCard = {
      id: "k1",
      name: { full: "" },
      emails: { ie1: { address: "kept@x.test" }, x: { address: "also@x.test" } },
      keywords: { old: true },
    };
    const patch = additionsPatch(existing, {
      emails: [{ address: "new@x.test", label: "work" }],
      phones: [{ number: "555", label: "mobile" }],
      labels: ["a/b~c"],
      name: "",
      given: "Kim",
      surname: "Lee",
      birthday: { year: null, month: 2, day: 3 },
    });
    expect(patch).toEqual({
      "emails/ie2": { address: "new@x.test", contexts: { work: true } },
      phones: { ip1: { number: "555", features: { mobile: true } } },
      anniversaries: { ib1: { kind: "birth", date: { "@type": "PartialDate", month: 2, day: 3 } } },
      "keywords/a~1b~0c": true,
      "name/full": "Kim Lee",
      "name/components": [
        { kind: "given", value: "Kim" },
        { kind: "surname", value: "Lee" },
      ],
      "name/isOrdered": true,
    });
    expect(additionsPatch({ id: "k2" }, { emails: [], phones: [], labels: [], given: "Al" })).toEqual({
      name: { full: "Al", components: [{ kind: "given", value: "Al" }], isOrdered: true },
    });
  });
});
