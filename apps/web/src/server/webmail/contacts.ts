// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

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

/** Caps: contacts listed, imported per file, file size, labels per contact, values per field. */
export const MAX_CONTACTS = 5000;
export const MAX_IMPORT_CARDS = 1000;
export const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_VALUES = 10;
const MAX_LABELS = 10;

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
 * Contacts from a .vcf file (vCard 3.0 / 4.0): FN, N, EMAIL, TEL, ORG, NOTE, BDAY, CATEGORIES. Everything else is
 * ignored. Bounded: `MAX_IMPORT_BYTES` of input, `MAX_IMPORT_CARDS` cards; invalid entries are skipped, never thrown.
 * Every result goes through `ContactInput` like a contact typed in the app.
 */
export function parseVcards(input: string): { contacts: ContactInput[]; skipped: number } {
  const lines = input
    .slice(0, MAX_IMPORT_BYTES)
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const contacts: ContactInput[] = [];
  let skipped = 0;
  let cur: Record<string, unknown> | null = null;
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [nameRaw = "", ...paramParts] = head.split(";");
    const name = (nameRaw.split(".").pop() ?? "").toUpperCase();
    const params = paramParts.join(";").toLowerCase();
    const type = /type=([a-z,"]+)/.exec(params)?.[1]?.replace(/"/g, "").split(",") ?? [];
    if (name === "BEGIN" && value.trim().toUpperCase() === "VCARD") {
      cur = { emails: [], phones: [], labels: [] };
      continue;
    }
    if (!cur) continue;
    if (name === "END" && value.trim().toUpperCase() === "VCARD") {
      if (contacts.length >= MAX_IMPORT_CARDS) {
        skipped += 1;
      } else {
        const parsed = ContactInput.safeParse(cur);
        if (parsed.success && hasIdentity(parsed.data)) contacts.push(parsed.data);
        else skipped += 1;
      }
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
  return { contacts, skipped };
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
