// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contacts import (ADR-0030 §10): CSV rows to contacts with the person's column mapping, and the merge by email that
 * decides, for each contact in a file, whether it becomes a new card, fills empty fields of a card already there (or of
 * an earlier one in the same file), or is a duplicate. Pure: the BFF (`WebmailService.importContacts`) reads the
 * mailbox's cards, plans with this and writes the plan with `ContactCard/set`.
 *
 * Merge rules: a contact's addresses are matched case-insensitively against existing cards' `emails` and against earlier
 * contacts in the file. A match only **fills what is empty** on that card — more addresses and phone numbers (up to ten
 * each), company, notes, birthday, labels (up to ten), and a name when it has none — and never changes or removes
 * anything. A contact without an address is a duplicate when a card with the same full name and one of the same phone
 * numbers exists. New cards stop at the mailbox's room; the rest are counted as `overCap`.
 */
import type { CsvTable } from "@anhourmail/shared/csv";
import { IMPORT_CSV_MULTI_FIELDS, type ImportCsvField } from "@anhourmail/shared/import";

import { cardFields, ContactInput, contactView, hasIdentity, MAX_LABELS, MAX_VALUES } from "./contacts";

export type ContactsImportCounts = {
  /** New cards written to My contacts. */
  created: number;
  /** Contacts that filled empty fields of a card (existing, or earlier in the file). */
  merged: number;
  /** Contacts that added nothing: every value was already there. */
  duplicates: number;
  /** Cards or rows that aren't a valid contact (no name, address or phone, or a value that isn't valid). */
  invalid: number;
  /** New contacts left out because the mailbox reached its contacts limit. */
  overCap: number;
};

// ---- CSV ------------------------------------------------------------------------------------------------------

/** Splits a cell holding several values (`a@x ::: b@y`, `a; b`, `a, b`). */
const several = (cell: string, commas: boolean): string[] =>
  cell
    .split(commas ? /\s*(?::::|;|,)\s*/ : /\s*(?::::|;)\s*/)
    .map((v) => v.trim())
    .filter(Boolean);

/** A label for an address or number from its column header ("Home Phone" → home, "Mobile" → mobile). */
function headerLabel(header: string, phone: boolean): string {
  const h = header.toLowerCase();
  if (phone && /mobile|cell/.test(h)) return "mobile";
  if (/home|personal|private/.test(h)) return "home";
  if (/work|business|office/.test(h)) return "work";
  return "";
}

/** A birthday cell: `1990-07-04`, `19900704`, `--07-04` or `--0704`; anything else is left out (not an error). */
function birthdayOf(cell: string): { year: number | null; month: number; day: number } | null {
  const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})$/.exec(cell.trim());
  if (!m) return null;
  return { year: m[1] === "--" ? null : Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Contacts from a parsed CSV with one field (or null: not imported) per column. A single-valued field mapped to more
 * than one column takes the first non-empty cell. Each row goes through `ContactInput` like a contact typed in the app;
 * a row that fails it, or has no name, address or phone, is `invalid`.
 */
export function csvContacts(
  table: CsvTable,
  columns: readonly (ImportCsvField | null)[],
): { contacts: ContactInput[]; invalid: number } {
  const contacts: ContactInput[] = [];
  let invalid = 0;
  for (const row of table.rows) {
    const cur = {
      name: "",
      given: "",
      surname: "",
      emails: [] as { address: string; label: string }[],
      phones: [] as { number: string; label: string }[],
      organization: "",
      notes: "",
      birthday: null as { year: number | null; month: number; day: number } | null,
      labels: [] as string[],
    };
    columns.forEach((field, i) => {
      const cell = (row[i] ?? "").trim();
      if (field === null || cell === "") return;
      const header = table.header[i] ?? "";
      switch (field) {
        case "fullName":
          if (cur.name === "") cur.name = cell.slice(0, 200);
          break;
        case "given":
          if (cur.given === "") cur.given = cell.slice(0, 100);
          break;
        case "surname":
          if (cur.surname === "") cur.surname = cell.slice(0, 100);
          break;
        case "organization":
          if (cur.organization === "") cur.organization = cell.slice(0, 200);
          break;
        case "notes":
          if (cur.notes === "") cur.notes = cell.slice(0, 4000);
          break;
        case "birthday":
          cur.birthday ??= birthdayOf(cell);
          break;
        case "emails":
          for (const address of several(cell, true)) {
            if (cur.emails.length < MAX_VALUES) {
              cur.emails.push({ address: address.toLowerCase(), label: headerLabel(header, false) });
            }
          }
          break;
        case "phones":
          for (const number of several(cell, false)) {
            if (cur.phones.length < MAX_VALUES) {
              cur.phones.push({ number: number.slice(0, 40), label: headerLabel(header, true) });
            }
          }
          break;
        case "labels":
          // A leading `*` marks an exporting app's own system group ("* starred"): not a label of the person's.
          for (const l of several(cell, true)) {
            if (!l.startsWith("*") && cur.labels.length < MAX_LABELS) cur.labels.push(l.slice(0, 40));
          }
          break;
      }
    });
    const parsed = ContactInput.safeParse(cur);
    if (parsed.success && hasIdentity(parsed.data)) contacts.push(parsed.data);
    else invalid += 1;
  }
  return { contacts, invalid };
}

/** Whether a mapping fits the file: one entry per column, at least one column imported. */
export function columnsFit(table: CsvTable, columns: readonly (ImportCsvField | null)[]): boolean {
  return columns.length === table.header.length && columns.some((c) => c !== null);
}

/** Multi-valued fields may take several columns; for the others the first one wins (`csvContacts`). */
export const isMultiField = (f: ImportCsvField): boolean => IMPORT_CSV_MULTI_FIELDS.includes(f);

// ---- merge ----------------------------------------------------------------------------------------------------

/** A card the mailbox already has, as read from the mail server (only the properties `CARD_PROPERTIES` names). */
export type ExistingCard = Record<string, unknown> & { id: string };

type Values = {
  name: string;
  given: string;
  surname: string;
  emails: { address: string; label: string }[];
  phones: { number: string; label: string }[];
  organization: string;
  notes: string;
  birthday: ContactInput["birthday"];
  labels: string[];
};

/** What a contact (or an existing card) holds now, and what this import added to it. */
type Target = {
  values: Values;
  added: Partial<Values> & { emails: Values["emails"]; phones: Values["phones"]; labels: string[] };
  /** The existing card, or null for a card this import creates. */
  card: ExistingCard | null;
  /** Contacts of the file merged into it. */
  mergedIn: number;
};

export type ContactsImportPlan = {
  /** New cards, in file order. */
  creates: { input: ContactInput; mergedIn: number }[];
  /** Patches for existing cards (only additions; JSON-pointer paths where the property already exists). */
  updates: { id: string; patch: Record<string, unknown>; mergedIn: number }[];
  counts: Omit<ContactsImportCounts, "created" | "invalid">;
};

const digits = (n: string) => n.replace(/\D/g, "");
const fullName = (v: Pick<Values, "name" | "given" | "surname">) =>
  (v.name !== "" ? v.name : [v.given, v.surname].filter(Boolean).join(" ")).trim().toLowerCase().replace(/\s+/g, " ");

function valuesOfCard(card: ExistingCard): Values {
  const v = contactView(card);
  const named = card.name as { full?: unknown } | undefined;
  return {
    // The card's own full name only (the view falls back to an address when there is none).
    name:
      typeof named?.full === "string"
        ? named.full
            .replace(/\p{Cc}/gu, " ")
            .trim()
            .slice(0, 200)
        : "",
    given: v.given,
    surname: v.surname,
    emails: v.emails,
    phones: v.phones,
    organization: v.organization,
    notes: v.notes,
    birthday: v.birthday,
    labels: v.labels,
  };
}

/** Fills what's empty on `t` from `c`; true when anything was added. Addresses on other cards are never copied. */
function fill(t: Target, c: ContactInput, taken: ReadonlyMap<string, Target>): boolean {
  let changed = false;
  const v = t.values;
  for (const e of c.emails) {
    const owner = taken.get(e.address);
    if (owner !== undefined || v.emails.length >= MAX_VALUES) continue;
    v.emails.push(e);
    t.added.emails.push(e);
    changed = true;
  }
  const have = new Set(v.phones.map((p) => digits(p.number)));
  for (const p of c.phones) {
    const key = digits(p.number);
    if (key === "" || have.has(key) || v.phones.length >= MAX_VALUES) continue;
    have.add(key);
    v.phones.push(p);
    t.added.phones.push(p);
    changed = true;
  }
  if (v.name === "" && v.given === "" && v.surname === "" && (c.name || c.given || c.surname)) {
    v.name = c.name;
    v.given = c.given;
    v.surname = c.surname;
    t.added.name = c.name;
    t.added.given = c.given;
    t.added.surname = c.surname;
    changed = true;
  }
  if (v.organization === "" && c.organization !== "") {
    v.organization = t.added.organization = c.organization;
    changed = true;
  }
  if (v.notes === "" && c.notes !== "") {
    v.notes = t.added.notes = c.notes;
    changed = true;
  }
  if (v.birthday === null && c.birthday !== null) {
    v.birthday = t.added.birthday = c.birthday;
    changed = true;
  }
  const labels = new Set(v.labels.map((l) => l.toLowerCase()));
  for (const l of c.labels) {
    if (labels.has(l.toLowerCase()) || v.labels.length >= MAX_LABELS) continue;
    labels.add(l.toLowerCase());
    v.labels.push(l);
    t.added.labels.push(l);
    changed = true;
  }
  return changed;
}

/** A JSON pointer segment (RFC 6901): `~` and `/` escaped. */
const pointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * The additions to an existing card as a `ContactCard/set` patch: each new entry under its own key (a path into a map
 * that already exists, else the whole map, which was absent), so nothing already on the card is replaced.
 */
export function additionsPatch(card: ExistingCard, added: Target["added"]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const built = cardFields(
    ContactInput.parse({
      name: added.name ?? "",
      given: added.given ?? "",
      surname: added.surname ?? "",
      emails: added.emails,
      phones: added.phones,
      organization: added.organization ?? "",
      notes: added.notes ?? "",
      birthday: added.birthday ?? null,
      labels: added.labels,
    }),
  );
  const addEntries = (prop: string, prefix: string, entries: Record<string, unknown>) => {
    const list = Object.values(entries);
    if (list.length === 0) return;
    const existing = card[prop];
    if (existing === null || typeof existing !== "object") {
      patch[prop] = Object.fromEntries(list.map((e, i) => [`${prefix}${String(i + 1)}`, e]));
      return;
    }
    // Keys the card's other entries don't use (`ie1`, `ie2`, …).
    const used = new Set(Object.keys(existing));
    let n = 1;
    for (const e of list) {
      while (used.has(`${prefix}${String(n)}`)) n++;
      used.add(`${prefix}${String(n)}`);
      patch[`${prop}/${prefix}${String(n)}`] = e;
    }
  };
  addEntries("emails", "ie", built.emails as Record<string, unknown>);
  addEntries("phones", "ip", built.phones as Record<string, unknown>);
  addEntries("organizations", "io", built.organizations as Record<string, unknown>);
  addEntries("notes", "in", built.notes as Record<string, unknown>);
  addEntries("anniversaries", "ib", built.anniversaries as Record<string, unknown>);
  if (added.labels.length > 0) {
    const kw = card.keywords;
    if (kw === null || typeof kw !== "object") patch.keywords = Object.fromEntries(added.labels.map((l) => [l, true]));
    else for (const l of added.labels) patch[`keywords/${pointer(l)}`] = true;
  }
  if (added.name !== undefined || added.given !== undefined || added.surname !== undefined) {
    const name = built.name as { full?: string; components?: unknown; isOrdered?: boolean };
    const current = card.name;
    if (current === null || typeof current !== "object") patch.name = name;
    else {
      if (name.full !== undefined) patch["name/full"] = name.full;
      if (name.components !== undefined && !("components" in current)) {
        patch["name/components"] = name.components;
        patch["name/isOrdered"] = true;
      }
    }
  }
  return patch;
}

/**
 * Plans an import: `incoming` in file order against the mailbox's `existing` cards (individuals only), with room for
 * `room` new cards. The merge rules are in this module's comment.
 */
export function planContactsImport(
  existing: readonly ExistingCard[],
  incoming: readonly ContactInput[],
  room: number,
): ContactsImportPlan {
  const byEmail = new Map<string, Target>();
  const all: Target[] = [];
  // Full name + phone digits of every card so far, for the no-address duplicate check: built as cards are indexed and
  // extended when a merge adds to one, so each incoming card is one lookup per phone (run-66 SA-66-03), not a scan.
  // Merges only ever add (a name only where there was none), so a key once true stays true.
  const namePhone = new Set<string>();
  const keyOf = (name: string, phone: string) => `${name}\u0000${phone}`;
  const addKeys = (t: Target) => {
    const name = fullName(t.values);
    if (name === "") return;
    for (const p of t.values.phones) {
      const d = digits(p.number);
      if (d !== "") namePhone.add(keyOf(name, d));
    }
  };
  const index = (t: Target) => {
    all.push(t);
    for (const e of t.values.emails) if (!byEmail.has(e.address.toLowerCase())) byEmail.set(e.address.toLowerCase(), t);
    addKeys(t);
  };
  for (const card of existing) {
    if (card.kind !== undefined && card.kind !== "individual") continue;
    index({ values: valuesOfCard(card), added: { emails: [], phones: [], labels: [] }, card, mergedIn: 0 });
  }
  const created: Target[] = [];
  let merged = 0;
  let duplicates = 0;
  let overCap = 0;
  for (const c of incoming) {
    const target = c.emails.map((e) => byEmail.get(e.address.toLowerCase())).find((t) => t !== undefined);
    if (target) {
      if (fill(target, c, byEmail)) {
        merged += 1;
        target.mergedIn += 1;
        for (const e of target.values.emails) if (!byEmail.has(e.address)) byEmail.set(e.address, target);
        addKeys(target);
      } else {
        duplicates += 1;
      }
      continue;
    }
    if (c.emails.length === 0) {
      const name = fullName(c);
      const same =
        name !== "" &&
        c.phones.some((p) => {
          const d = digits(p.number);
          return d !== "" && namePhone.has(keyOf(name, d));
        });
      if (same) {
        duplicates += 1;
        continue;
      }
    }
    if (created.length >= room) {
      overCap += 1;
      continue;
    }
    // Addresses already on another card stay there; this card keeps the rest.
    const values: Values = { ...c, emails: [], phones: [...c.phones], labels: [...c.labels] };
    for (const e of c.emails) if (!byEmail.has(e.address) && values.emails.length < MAX_VALUES) values.emails.push(e);
    const t: Target = { values, added: { emails: [], phones: [], labels: [] }, card: null, mergedIn: 0 };
    created.push(t);
    index(t);
  }
  return {
    creates: created.map((t) => ({ input: ContactInput.parse(t.values), mergedIn: t.mergedIn })),
    updates: all
      .filter((t): t is Target & { card: ExistingCard } => t.card !== null && t.mergedIn > 0)
      .map((t) => ({ id: t.card.id, patch: additionsPatch(t.card, t.added), mergedIn: t.mergedIn })),
    counts: { merged, duplicates, overCap },
  };
}
