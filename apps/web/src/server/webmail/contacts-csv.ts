// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contacts CSV import, the part the browser and the BFF share (ADR-0030 §10): reading the file with the import's limits,
 * what each parse error tells the person, the field names shown in the mapping step, and the column mapping as it
 * travels in the request (`?columns=`). The browser uses this for the preview only; the BFF parses the whole file again
 * with the submitted mapping and never trusts the preview. No dependency beyond `@anhourmail/shared`.
 */
import { type CsvError, type CsvResult, parseCsv } from "@anhourmail/shared/csv";
import { IMPORT, IMPORT_CSV_FIELDS, type ImportCsvField } from "@anhourmail/shared/import";

/** Rows shown in the mapping preview. */
export const CSV_PREVIEW_ROWS = 5;

const MB = Math.round(IMPORT.contactsMaxBytes / (1024 * 1024));
const CARDS = IMPORT.contactsMaxCards.toLocaleString("en-CA");

/** The largest contacts file, as the app says it. */
export const CONTACTS_FILE_TOO_LARGE = `Contact files can be up to ${String(MB)} MB.`;
/** A file with more cards (or rows) than one import takes. */
export const CONTACTS_FILE_TOO_MANY = `A file can hold up to ${CARDS} contacts. Split it into smaller files and import each one.`;

/** What a CSV parse error tells the person (the same words in the preview and from the BFF). */
export const CSV_ERROR_TEXT: Readonly<Record<CsvError, string>> = {
  encoding: "This file isn't saved as UTF-8. Save it as UTF-8 (often called CSV UTF-8) and import it again.",
  empty: "This file is empty.",
  too_large: CONTACTS_FILE_TOO_LARGE,
  too_many_rows: CONTACTS_FILE_TOO_MANY,
  too_many_columns: "This file has too many columns. Remove the ones you don't need and import it again.",
  cell_too_long: "A value in this file is too long. Shorten it and import the file again.",
  unterminated_quote: "This file isn't valid CSV: a quoted value never ends.",
};

/** The card field names in the mapping step, in the order the select lists them. */
export const CSV_FIELD_LABELS: Readonly<Record<ImportCsvField, string>> = {
  fullName: "Full name",
  given: "First name",
  surname: "Last name",
  emails: "Email",
  phones: "Phone",
  organization: "Company",
  notes: "Notes",
  birthday: "Birthday",
  labels: "Labels",
};

/** A contacts CSV file's bytes, read with the import's limits (size, rows = cards). */
export function readContactsCsv(bytes: Uint8Array): CsvResult {
  return parseCsv(bytes, { maxBytes: IMPORT.contactsMaxBytes, maxRows: IMPORT.contactsMaxCards });
}

const isField = (v: string): v is ImportCsvField => (IMPORT_CSV_FIELDS as readonly string[]).includes(v);

/** The mapping as the request carries it: one entry per column, the field name or empty for "Don't import". */
export function encodeColumns(columns: readonly (ImportCsvField | null)[]): string {
  return columns.map((c) => c ?? "").join(",");
}

/** The mapping from a request, or null when an entry isn't a field name (or there are none). */
export function decodeColumns(value: string | null): (ImportCsvField | null)[] | null {
  if (value === null || value === "" || value.length > 4000) return null;
  const out: (ImportCsvField | null)[] = [];
  for (const part of value.split(",")) {
    if (part === "") out.push(null);
    else if (isField(part)) out.push(part);
    else return null;
  }
  return out;
}
