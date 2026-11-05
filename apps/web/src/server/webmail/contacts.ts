// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import { IMPORT } from "@anhourmail/shared/import";

/**
 * Contacts in the webmail (docs/internal/05-webmail.md "Contacts"). They live in Stalwart's own address books
 * (JMAP Contacts, RFC 9610 — JSContact cards), never in Postgres, so they also sync over CardDAV. The browser
 * never writes JSContact itself: it sends the small `ContactInput` below and the BFF builds the card, and vCard
 * import is parsed here with caps.
 */

/** The address book "Other contacts" (people saved automatically when you email them). */
export const OTHER_BOOK_NAME = "Other contacts";
/**
 * Whether people you email are saved automatically is stored on the Other contacts book itself (its description),
 * so the setting lives with the mailbox in Stalwart and nothing about it is kept in our database.
 */
export const AUTO_SAVE_ON = "People you email are saved here automatically.";
export const AUTO_SAVE_OFF = "Automatic saving is off.";

/** Caps: contacts listed, imported per file (vCard or CSV, ADR-0030 §10), file size, labels per contact, values per field. */
export const MAX_CONTACTS = 5000;
export const MAX_IMPORT_CARDS = IMPORT.contactsMaxCards;
export const MAX_IMPORT_BYTES = IMPORT.contactsMaxBytes;
export const MAX_VALUES = 10;
export const MAX_LABELS = 10;

export type ContactView = {
  id: string;
  /** Address books it is in. */
  bookIds: string[];
  /** Display name (full name, else given + surname, else the first address). */
  name: string;
  given: string;
  surname: string;
  emails: { address: string; label: string }[];
  phones: { number: string; label: string }[];
  organization: string;
  notes: string;
  birthday: { year: number | null; month: number; day: number } | null;
  /** Labels (JSContact keywords; vCard CATEGORIES). */
  labels: string[];
};

export type BookView = { id: string; name: string; isDefault: boolean; isOther: boolean };

const label = z
  .string()
  .max(40)
  .transform((s) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, ""),
  );
const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/[\p{Cc}]/gu, " ").trim());

export const ContactInput = z.object({
  given: text(100).default(""),
  surname: text(100).default(""),
  /** Full name as typed (optional; built from given + surname otherwise). */
  name: text(200).default(""),
  emails: z
    .array(
      z.object({
        address: z
          .email()
          .max(254)
          .transform((v) => v.toLowerCase()),
        label: label.default(""),
      }),
    )
    .max(MAX_VALUES)
    .default([]),
  phones: z
    .array(
      z.object({
        number: z
          .string()
          .max(40)
          .regex(/^[0-9+().\-\s#*ext]*$/i),
        label: label.default(""),
      }),
    )
    .max(MAX_VALUES)
    .default([]),
  organization: text(200).default(""),
  // Notes keep their line breaks; other control characters go.
  notes: z
    .string()
    .max(4000)
    .transform((v) =>
      v
        .replace(/\r\n?/g, "\n")
        .replace(/[^\P{Cc}\n\t]/gu, " ")
        .trim(),
    )
    .default(""),
  birthday: z
    .object({
      year: z.number().int().min(1800).max(2200).nullable(),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
    })
    .nullable()
    .default(null),
  labels: z
    .array(text(40).pipe(z.string().min(1)))
    .max(MAX_LABELS)
    .default([]),
});
export type ContactInput = z.infer<typeof ContactInput>;

/** Something to show for a contact with no name at all. */
export function hasIdentity(c: ContactInput): boolean {
  return c.name !== "" || c.given !== "" || c.surname !== "" || c.emails.length > 0 || c.phones.length > 0;
}

// Maps, not object literals: a label like "constructor" must never resolve to an inherited property.
const CONTEXT_LABEL = new Map([
  ["work", "work"],
  ["private", "home"],
]);
const LABEL_CONTEXT = new Map([
  ["work", "work"],
  ["home", "private"],
  ["personal", "private"],
]);

/** One line of text from a card: control characters (line breaks too) become spaces, then capped. */
const line = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/\p{Cc}/gu, " ")
        .trim()
        .slice(0, max)
    : "";
/** Multi-line text (notes): line breaks kept and normalised, other control characters become spaces. */
const block = (v: string, max: number): string =>
  v
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n]/gu, " ")
    .trim()
    .slice(0, max);

/** Our fields as JSContact properties (for create, and as a patch replacing exactly these on update). */
export function cardFields(c: ContactInput): Record<string, unknown> {
  const full = c.name !== "" ? c.name : [c.given, c.surname].filter(Boolean).join(" ");
  const components = [
    ...(c.given ? [{ kind: "given", value: c.given }] : []),
    ...(c.surname ? [{ kind: "surname", value: c.surname }] : []),
  ];
  const map = <T>(list: T[], key: string, f: (v: T) => Record<string, unknown>) =>
    Object.fromEntries(list.map((v, i) => [`${key}${String(i + 1)}`, f(v)]));
  const contexts = (l: string) => {
    const ctx = LABEL_CONTEXT.get(l);
    return ctx ? { contexts: { [ctx]: true } } : l ? { label: l } : {};
  };
  return {
    name: { ...(full ? { full } : {}), ...(components.length > 0 ? { components, isOrdered: true } : {}) },
    emails: map(c.emails, "e", (e) => ({ address: e.address, ...contexts(e.label) })),
    phones: map(c.phones, "p", (p) => ({
      number: p.number,
      ...(p.label === "mobile" ? { features: { mobile: true } } : contexts(p.label)),
    })),
    organizations: c.organization ? { o1: { name: c.organization } } : {},
    notes: c.notes ? { n1: { note: c.notes } } : {},
    anniversaries: c.birthday
      ? {
          b1: {
            kind: "birth",
            date: {
              "@type": "PartialDate",
              ...(c.birthday.year !== null ? { year: c.birthday.year } : {}),
              month: c.birthday.month,
              day: c.birthday.day,
            },
          },
        }
      : {},
    keywords: Object.fromEntries([...new Set(c.labels)].map((l) => [l, true])),
  };
}

/** A new card in `bookId`. */
export function newCard(c: ContactInput, bookId: string): Record<string, unknown> {
  return { "@type": "Card", version: "1.0", kind: "individual", addressBookIds: { [bookId]: true }, ...cardFields(c) };
}

type Card = {
  id: string;
  kind?: string;
  addressBookIds?: Record<string, boolean>;
  name?: { full?: string; components?: { kind: string; value: string }[] };
  emails?: Record<string, { address?: string; label?: string; contexts?: Record<string, boolean> }>;
  phones?: Record<
    string,
    { number?: string; label?: string; contexts?: Record<string, boolean>; features?: Record<string, boolean> }
  >;
  organizations?: Record<string, { name?: string }>;
  notes?: Record<string, { note?: string }>;
  anniversaries?: Record<string, { kind?: string; date?: { year?: number; month?: number; day?: number } }>;
  keywords?: Record<string, boolean>;
};

const labelOf = (v: { label?: string; contexts?: Record<string, boolean> }) =>
  line(v.label ?? Object.keys(v.contexts ?? {}).map((k) => CONTEXT_LABEL.get(k) ?? k)[0] ?? "", 40);

/** A JSContact card as the reader's view (unknown properties are ignored, never echoed). */
export function contactView(card: Card): ContactView {
  const comp = (k: string) => line(card.name?.components?.find((c) => c.kind === k)?.value, 100);
  const given = comp("given");
  const surname = comp("surname");
  const emails = Object.values(card.emails ?? {})
    .filter((e) => typeof e.address === "string")
    .map((e) => ({ address: line(e.address, 254), label: labelOf(e) }));
  const phones = Object.values(card.phones ?? {})
    .filter((p) => typeof p.number === "string")
    .map((p) => ({ number: line(p.number, 40), label: p.features?.mobile ? "mobile" : labelOf(p) }));
  const full = line(card.name?.full, 200) || [given, surname].filter(Boolean).join(" ");
  const birth = Object.values(card.anniversaries ?? {}).find((a) => a.kind === "birth")?.date;
  return {
    id: card.id,
    bookIds: Object.keys(card.addressBookIds ?? {}).filter((k) => card.addressBookIds?.[k]),
    name: [full, emails[0]?.address, phones[0]?.number].find((v) => v !== undefined && v !== "") ?? "",
    given,
    surname,
    emails,
    phones,
    organization: line(Object.values(card.organizations ?? {})[0]?.name, 200),
    notes: block(
      Object.values(card.notes ?? {})
        .map((n) => (typeof n.note === "string" ? n.note : ""))
        .join("\n\n"),
      4000,
    ),
    birthday: birth?.month && birth.day ? { year: birth.year ?? null, month: birth.month, day: birth.day } : null,
    labels: Object.keys(card.keywords ?? {})
      .filter((k) => card.keywords?.[k] === true)
      .map((k) => line(k, 40))
      .filter(Boolean),
  };
}

export const CARD_PROPERTIES = [
  "kind",
  "addressBookIds",
  "name",
  "emails",
  "phones",
  "organizations",
  "notes",
  "anniversaries",
  "keywords",
] as const;

// ---- vCard (RFC 6350) ---------------------------------------------------------------------------------------

const unescapeVc = (v: string) => v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
/** A vCard value: line breaks become `\n`, other control characters spaces, and `\ , ;` are escaped. */
const escapeVc = (v: string) =>
  v
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n]/gu, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/([,;])/g, "\\$1");

/**
 * Decodes a vCard 2.1 quoted-printable value (`=XX` bytes, soft line breaks already joined) as `charset` (UTF-8 when
 * none is given or the label is unknown). Malformed `=` sequences are kept as written.
 */
export function decodeQuotedPrintable(value: string, charset = "utf-8"): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c < 0x80) {
      bytes.push(c);
    } else {
      // Not quoted-printable at all (8-bit text in the value): kept as its UTF-8 bytes.
      bytes.push(...new TextEncoder().encode(value.charAt(i)));
    }
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(new Uint8Array(bytes));
}

/**
 * One content line's parameters: TYPE values (from `TYPE=a,b` and vCard 2.1's bare `;HOME;CELL`), whether the value is
 * quoted-printable (`ENCODING=QUOTED-PRINTABLE` or bare `QUOTED-PRINTABLE`) and its CHARSET.
 */
function vcParams(parts: readonly string[]): { type: string[]; qp: boolean; charset: string | undefined } {
  const type: string[] = [];
  let qp = false;
  let charset: string | undefined;
  for (const raw of parts) {
    const p = raw.toLowerCase();
    const eq = p.indexOf("=");
    if (eq === -1) {
      if (p === "quoted-printable") qp = true;
      else if (p !== "") type.push(p);
      continue;
    }
    const key = p.slice(0, eq);
    const value = p.slice(eq + 1).replace(/"/g, "");
    if (key === "type") type.push(...value.split(",").filter(Boolean));
    else if (key === "encoding" && value === "quoted-printable") qp = true;
    else if (key === "charset") charset = value;
  }
  return { type, qp, charset };
}

/** Longest quoted-printable value kept (encoded characters); more is never needed for a card field (all cut later). */
export const MAX_QP_VALUE = 8 * 1024;

/**
 * Contacts from a .vcf file (vCard 2.1 / 3.0 / 4.0; 2.1 quoted-printable values are decoded): FN, N, EMAIL, TEL, ORG,
 * NOTE, BDAY, CATEGORIES. Everything else is ignored, so an import never fetches anything. Bounded: `MAX_IMPORT_BYTES`
 * of input; past `MAX_IMPORT_CARDS` cards `tooMany` is set and the rest aren't read. Invalid or empty cards are
 * counted (`invalid`), never thrown. Every result goes through `ContactInput` like a contact typed in the app.
 */
export function parseVcards(input: string): { contacts: ContactInput[]; invalid: number; tooMany: boolean } {
  const physical = input
    .slice(0, MAX_IMPORT_BYTES)
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const contacts: ContactInput[] = [];
  let invalid = 0;
  let cards = 0;
  let cur: Record<string, unknown> | null = null;
  for (let li = 0; li < physical.length; li++) {
    let line = physical[li] ?? "";
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const head = line.slice(0, colon);
    const [nameRaw = "", ...paramParts] = head.split(";");
    const name = (nameRaw.split(".").pop() ?? "").toUpperCase();
    const { type, qp, charset } = vcParams(paramParts);
    // vCard 2.1 quoted-printable: a value ending in `=` goes on in the next line (a soft line break).
    // Parts are collected and joined once (linear, run-66 SA-66-02), and stop growing past `MAX_QP_VALUE` characters:
    // the lines of an over-long value are still consumed, so the next property is read where it starts.
    if (qp && line.endsWith("=")) {
      const parts = [line.slice(0, -1)];
      let size = parts[0]?.length ?? 0;
      let next = line;
      while (next.endsWith("=") && li + 1 < physical.length) {
        next = physical[++li] ?? "";
        const part = next.endsWith("=") ? next.slice(0, -1) : next;
        if (size < MAX_QP_VALUE) {
          parts.push(part);
          size += part.length;
        }
      }
      line = parts.join("").slice(0, colon + 1 + MAX_QP_VALUE);
    }
    const value = qp ? decodeQuotedPrintable(line.slice(colon + 1), charset) : line.slice(colon + 1);
    if (name === "BEGIN" && value.trim().toUpperCase() === "VCARD") {
      cur = { emails: [], phones: [], labels: [] };
      continue;
    }
    if (!cur) continue;
    if (name === "END" && value.trim().toUpperCase() === "VCARD") {
      cards += 1;
      if (cards > MAX_IMPORT_CARDS) return { contacts, invalid, tooMany: true };
      const parsed = ContactInput.safeParse(cur);
      if (parsed.success && hasIdentity(parsed.data)) contacts.push(parsed.data);
      else invalid += 1;
      cur = null;
      continue;
    }
    const v = unescapeVc(value).slice(0, 4000);
    const emails = cur.emails as { address: string; label: string }[];
    const phones = cur.phones as { number: string; label: string }[];
    switch (name) {
      case "FN":
        cur.name = v.slice(0, 200);
        break;
      case "N": {
        const [surname = "", given = ""] = value.split(/(?<!\\);/).map(unescapeVc);
        cur.surname = surname.slice(0, 100);
        cur.given = given.slice(0, 100);
        break;
      }
      case "EMAIL":
        if (emails.length < MAX_VALUES) {
          emails.push({
            address: v.trim().toLowerCase(),
            label: type.includes("work") ? "work" : type.includes("home") ? "home" : "",
          });
        }
        break;
      case "TEL":
        if (phones.length < MAX_VALUES) {
          phones.push({
            number: v.replace(/^tel:/i, "").trim().slice(0, 40),
            label: type.includes("cell")
              ? "mobile"
              : type.includes("work")
                ? "work"
                : type.includes("home")
                  ? "home"
                  : "",
          });
        }
        break;
      case "ORG":
        cur.organization = (value.split(/(?<!\\);/)[0] ? unescapeVc(value.split(/(?<!\\);/)[0] ?? "") : "").slice(
          0,
          200,
        );
        break;
      case "NOTE":
        cur.notes = v;
        break;
      case "BDAY": {
        const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(v.trim());
        if (m) cur.birthday = { year: m[1] === "--" ? null : Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
        break;
      }
      case "CATEGORIES":
        cur.labels = value
          .split(/(?<!\\),/)
          .map((x) => unescapeVc(x).trim())
          .filter(Boolean)
          .slice(0, MAX_LABELS);
        break;
      default:
        break;
    }
  }
  return { contacts, invalid, tooMany: false };
}

/** Contacts as a vCard 4.0 file (text/vcard), every value escaped. */
export function toVcards(contacts: ContactView[]): string {
  const out: string[] = [];
  for (const c of contacts) {
    out.push("BEGIN:VCARD", "VERSION:4.0", `FN:${escapeVc(c.name)}`);
    if (c.given || c.surname) out.push(`N:${escapeVc(c.surname)};${escapeVc(c.given)};;;`);
    for (const e of c.emails)
      out.push(`EMAIL${e.label ? `;TYPE=${e.label === "home" ? "home" : "work"}` : ""}:${escapeVc(e.address)}`);
    for (const p of c.phones) {
      const t = p.label === "mobile" ? "cell" : p.label === "home" || p.label === "work" ? p.label : "";
      out.push(`TEL${t ? `;TYPE=${t}` : ""}:${escapeVc(p.number)}`);
    }
    if (c.organization) out.push(`ORG:${escapeVc(c.organization)}`);
    if (c.notes) out.push(`NOTE:${escapeVc(c.notes)}`);
    if (c.birthday) {
      const mm = String(c.birthday.month).padStart(2, "0");
      const dd = String(c.birthday.day).padStart(2, "0");
      out.push(`BDAY:${c.birthday.year !== null ? String(c.birthday.year) : "--"}${mm}${dd}`);
    }
    if (c.labels.length > 0) out.push(`CATEGORIES:${c.labels.map(escapeVc).join(",")}`);
    out.push("END:VCARD");
  }
  return `${out.join("\r\n")}\r\n`;
}
