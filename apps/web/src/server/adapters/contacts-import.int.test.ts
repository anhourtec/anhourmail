// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contacts import from the webmail (ADR-0030 §10) against the dev Stalwart (`npm run test:int`): vCard 3.0 and 4.0,
 * CSV with a comma, a semicolon and UTF-16 with a BOM, through the BFF service into the mailbox's address book; merge by
 * email that only fills empty fields (the patch paths the pinned server applies, nothing on the card replaced); and the
 * 5,000-card limits (per file, and the mailbox's own). Throwaway mailboxes on the dev-only `dev.test` domain with random
 * passwords, hashed before they reach the mail server and never printed; removed afterwards.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { detectCsvColumns } from "@anhourmail/shared/import";
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";

import { ContactInput } from "../webmail/contacts";
import type { ContactsImportCounts } from "../webmail/contacts-import";
import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { type ContactsImportFile, WebmailRefusedError, WebmailService } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const run = randomBytes(4).toString("hex");
const boxes = {
  a: { name: `int-contacts-a-${run}`, password: randomBytes(18).toString("base64url"), id: "" },
  cap: { name: `int-contacts-cap-${run}`, password: randomBytes(18).toString("base64url"), id: "" },
};
const address = (k: keyof typeof boxes) => `${boxes[k].name}@dev.test`;

/**
 * JMAP Contacts as the mailbox itself (Basic auth with its own password): what the server really stored — its cards
 * (the first 500, one `/get`) and how many there are.
 */
async function stored(k: keyof typeof boxes): Promise<{ cards: Record<string, unknown>[]; total: number }> {
  const auth = `Basic ${Buffer.from(`${address(k)}:${boxes[k].password}`).toString("base64")}`;
  const session = (await (
    await fetch(`${STALWART_URL}/jmap/session`, { headers: { Authorization: auth } })
  ).json()) as {
    primaryAccounts: Record<string, string>;
  };
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:contacts"] ?? "";
  const res = await fetch(`${STALWART_URL}/jmap`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
      methodCalls: [
        ["ContactCard/get", { accountId, ids: null }, "g"],
        ["ContactCard/query", { accountId, limit: 1, calculateTotal: true }, "q"],
      ],
    }),
  });
  const body = (await res.json()) as {
    methodResponses: [string, { list?: Record<string, unknown>[]; total?: number }, string][];
  };
  return { cards: body.methodResponses[0]?.[1].list ?? [], total: body.methodResponses[1]?.[1].total ?? -1 };
}

function service() {
  return new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
    stalwartUrl: STALWART_URL,
    access: { state: async () => "ok" as const },
    quota: memorySlidingQuota(),
    sieve: { read: async () => null, write: async () => true },
    confirmedForward: async () => null,
    defer: () => undefined,
  });
}

const enc = (s: string) => new TextEncoder().encode(s);
/** UTF-16 LE with its BOM, as some spreadsheet apps save "Unicode text". */
const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const csvFile = (bytes: Uint8Array, header: string[]): ContactsImportFile => ({
  format: "csv",
  bytes,
  columns: detectCsvColumns(header),
});

async function signedIn(k: keyof typeof boxes) {
  const svc = service();
  const { sessionId } = await svc.signIn(address(k), boxes[k].password);
  const { accountId } = await svc.contacts(sessionId);
  const audited: { address: string; counts: ContactsImportCounts }[] = [];
  const importFile = (file: ContactsImportFile) =>
    svc.importContacts(sessionId, accountId, file, async (addr, counts) => {
      audited.push({ address: addr, counts });
    });
  return { svc, sessionId, accountId, importFile, audited };
}

beforeAll(async () => {
  for (const k of ["a", "cap"] as const) {
    boxes[k].id = await stalwartDevAdmin().upsertUser({
      name: boxes[k].name,
      domain: "dev.test",
      password: await hashPassword(boxes[k].password),
      quotaBytes: 50 * 1024 * 1024,
    });
  }
});

afterAll(async () => {
  for (const k of ["a", "cap"] as const) if (boxes[k].id) await stalwartDevAdmin().destroy("x:Account", boxes[k].id);
});

describe("contacts import into the dev mail server", () => {
  it("imports vCard 3.0 and 4.0 files (2.1 quoted-printable too) into My contacts", async () => {
    const { svc, sessionId, importFile, audited } = await signedIn("a");
    const v3 = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Maya Chen",
      "N:Chen;Maya;;;",
      "EMAIL;TYPE=INTERNET,WORK:Maya@Piano.example",
      "TEL;TYPE=CELL:+1 604 555 0100",
      "ORG:Chen Piano Studio",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:2.1",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BCller",
      "EMAIL;INTERNET;HOME:juergen@mueller.example",
      "END:VCARD",
    ].join("\r\n");
    expect(await importFile({ format: "vcard", bytes: enc(v3) })).toEqual({
      created: 2,
      merged: 0,
      duplicates: 0,
      invalid: 0,
      overCap: 0,
    });
    const v4 = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Jordan Lee",
      "EMAIL;TYPE=home:jordan@lee.example",
      "BDAY:--0315",
      "CATEGORIES:family,book club",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "EMAIL:not-an-address",
      "END:VCARD",
    ].join("\r\n");
    expect(await importFile({ format: "vcard", bytes: enc(v4) })).toMatchObject({ created: 1, invalid: 1 });
    const { contacts, books } = await svc.contacts(sessionId);
    const mine = books.find((b) => b.name === "My contacts")?.id;
    expect(contacts.map((c) => c.name).sort()).toEqual(["Jordan Lee", "Jürgen Müller", "Maya Chen"]);
    for (const c of contacts) expect(c.bookIds).toEqual([mine]);
    expect(contacts.find((c) => c.name === "Maya Chen")).toMatchObject({
      emails: [{ address: "maya@piano.example", label: "work" }],
      phones: [{ number: "+1 604 555 0100", label: "mobile" }],
      organization: "Chen Piano Studio",
    });
    expect(contacts.find((c) => c.name === "Jordan Lee")).toMatchObject({
      birthday: { year: null, month: 3, day: 15 },
      labels: expect.arrayContaining(["family", "book club"]) as unknown,
    });
    expect(audited.map((a) => a.address)).toEqual([address("a"), address("a")]);
    await svc.signOut(sessionId);
  });

  it("imports CSV with a comma, a semicolon and UTF-16 with a BOM", async () => {
    const { svc, sessionId, importFile } = await signedIn("a");
    const comma = ["First Name,Last Name,E-mail Address,Mobile Phone", "Ana,Diaz,ana@diaz.example,+1 604 555 0111"];
    expect(await importFile(csvFile(enc(comma.join("\r\n")), comma[0]?.split(",") ?? []))).toMatchObject({
      created: 1,
    });
    const semi = ["Name;Email;Company", "Bo Park;bo@park.example;Park & Co"];
    expect(await importFile(csvFile(enc(semi.join("\n")), semi[0]?.split(";") ?? []))).toMatchObject({ created: 1 });
    const wide = ["Display Name\tE-mail Address", "Zoë Ångström\tzoe@angstrom.example"];
    expect(await importFile(csvFile(utf16le(wide.join("\r\n")), wide[0]?.split("\t") ?? []))).toMatchObject({
      created: 1,
    });
    const names = (await svc.contacts(sessionId)).contacts.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Ana Diaz", "Bo Park", "Zoë Ångström"]));
    expect((await svc.contacts(sessionId)).contacts.find((c) => c.name === "Bo Park")?.organization).toBe("Park & Co");
    // A file in another encoding is refused with what to do, and nothing is written.
    await expect(
      importFile({ format: "csv", bytes: new Uint8Array([0x4e, 0x0a, 0x43, 0x61, 0x66, 0xe9]), columns: ["fullName"] }),
    ).rejects.toThrow(/Save it as UTF-8/);
    await svc.signOut(sessionId);
  });

  it("merges by email: fills only empty fields of the card already there, never replacing anything", async () => {
    const { svc, sessionId, accountId, importFile } = await signedIn("a");
    const { id } = await svc.createContact(
      sessionId,
      accountId,
      ContactInput.parse({
        given: "Sam",
        surname: "Rivera",
        emails: [{ address: "sam@rivera.example", label: "home" }],
        organization: "Trail Club",
      }),
    );
    const before = (await stored("a")).cards.find((c) => c.id === id);
    const header = ["First Name", "Last Name", "E-mail Address", "E-mail 2 Address", "Company", "Notes", "Categories"];
    const rows = [
      header.join(","),
      "Samuel,R,SAM@rivera.example,sam.work@rivera.example,Other Co,Met on the trail,hiking",
      "Samuel,R,sam@rivera.example,,,,",
    ];
    expect(await importFile(csvFile(enc(rows.join("\r\n")), header))).toEqual({
      created: 0,
      merged: 1,
      duplicates: 1,
      invalid: 0,
      overCap: 0,
    });
    const sam = (await svc.contacts(sessionId)).contacts.find((c) => c.id === id);
    expect(sam).toMatchObject({
      given: "Sam",
      surname: "Rivera",
      organization: "Trail Club",
      notes: "Met on the trail",
      labels: ["hiking"],
    });
    expect(sam?.emails.map((e) => e.address)).toEqual(["sam@rivera.example", "sam.work@rivera.example"]);
    // The card's own entries are still there under their own keys.
    const after = (await stored("a")).cards.find((c) => c.id === id);
    const keys = (v: unknown) => Object.keys(v ?? {});
    for (const k of keys(before?.emails)) expect(keys(after?.emails)).toContain(k);
    expect(after?.organizations).toEqual(before?.organizations);
    // Importing the same file again adds nothing.
    expect(await importFile(csvFile(enc(rows.join("\r\n")), header))).toMatchObject({
      created: 0,
      merged: 0,
      duplicates: 2,
    });
    await svc.signOut(sessionId);
  });

  it(
    "refuses a file over 5,000 contacts and stops new cards at the mailbox's 5,000",
    { timeout: 300_000 },
    async () => {
      const { svc, sessionId, importFile } = await signedIn("cap");
      const cards = (n: number, from = 0) =>
        Array.from(
          { length: n },
          (_, i) =>
            `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:P${String(from + i)}\r\nEMAIL:p${String(from + i)}@cap.example\r\nEND:VCARD\r\n`,
        ).join("");
      await expect(importFile({ format: "vcard", bytes: enc(cards(5001)) })).rejects.toBeInstanceOf(
        WebmailRefusedError,
      );
      expect((await stored("cap")).total).toBe(0);
      expect(await importFile({ format: "vcard", bytes: enc(cards(4998)) })).toMatchObject({ created: 4998 });
      // Two fit; one more is over the mailbox's limit; one already there fills nothing and is a duplicate.
      const next = `${cards(3, 5000)}BEGIN:VCARD\r\nFN:P0\r\nEMAIL:P0@cap.example\r\nEND:VCARD\r\n`;
      expect(await importFile({ format: "vcard", bytes: enc(next) })).toEqual({
        created: 2,
        merged: 0,
        duplicates: 1,
        invalid: 0,
        overCap: 1,
      });
      expect((await stored("cap")).total).toBe(5000);
      await svc.signOut(sessionId);
    },
  );
});
