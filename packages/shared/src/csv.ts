// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CSV for imports and reports (ADR-0030 §8 and §10): a small RFC 4180 reader and writer with no dependency, used in the
 * browser (the contacts mapping preview) and on the server (which re-parses the whole file itself).
 *
 * Reading: quoted fields with `""` escapes and embedded newlines; CRLF, LF or CR line ends; `,`, `;` or tab as the
 * delimiter, detected from the header line; UTF-8 with or without a BOM, or UTF-16 with a BOM; anything else (an
 * invalid UTF-8 byte, e.g. a Windows code page) is refused so the person can save it as UTF-8. Values are kept as
 * text, exactly: nothing is evaluated, a leading `=` `+` `-` `@` is just a character (a phone number starts with `+`).
 *
 * Writing (`toCsv`): every cell that starts like a spreadsheet formula (`=` `+` `-` `@`, tab or CR) gets a leading `'`
 * so opening a report never runs anything (OWASP "CSV injection"); cells with a delimiter, quote or line break are
 * quoted.
 */

export const CSV_DELIMITERS = [",", ";", "\t"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export type CsvLimits = {
  /** Largest input in bytes (checked before decoding). */
  maxBytes: number;
  /** Data rows after the header (blank lines don't count). */
  maxRows: number;
  /** Columns per row. */
  maxColumns: number;
  /** Characters per cell. */
  maxCellLength: number;
};

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 200,
  maxCellLength: 10_000,
};

export type CsvError =
  /** Not UTF-8 or UTF-16 with a BOM. */
  | "encoding"
  /** No header line. */
  | "empty"
  | "too_large"
  | "too_many_rows"
  | "too_many_columns"
  | "cell_too_long"
  /** A quoted field never closed. */
  | "unterminated_quote";

export type CsvTable = { delimiter: CsvDelimiter; header: string[]; rows: string[][] };

export type CsvResult = { ok: true; table: CsvTable } | { ok: false; error: CsvError };

/** Bytes → text by BOM: UTF-8 (BOM optional, must be valid), UTF-16 LE/BE (BOM required). Null when it's neither. */
export function decodeCsvBytes(bytes: Uint8Array): string | null {
  const b0 = bytes[0];
  const b1 = bytes[1];
  try {
    if (b0 === 0xff && b1 === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    if (b0 === 0xfe && b1 === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    // `ignoreBOM: false` (the default) drops a UTF-8 BOM.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The delimiter of the header line: whichever of `,` `;` tab occurs most outside quotes (ties: comma, then `;`). */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(CSV_DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && (c === "," || c === ";" || c === "\t")) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: CsvDelimiter = ",";
  for (const d of CSV_DELIMITERS) if ((counts.get(d) ?? 0) > (counts.get(best) ?? 0)) best = d;
  return best;
}

/** Splits text into rows of cells (RFC 4180, lenient about a stray quote inside an unquoted cell). */
function rowsOf(
  text: string,
  delimiter: CsvDelimiter,
  limits: CsvLimits,
): { ok: true; rows: string[][] } | { ok: false; error: CsvError } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  // Whether the current cell began with a quote (so a quote inside it ends the quoted part).
  let wasQuoted = false;
  const endCell = (): CsvError | null => {
    if (cell.length > limits.maxCellLength) return "cell_too_long";
    row.push(cell);
    cell = "";
    wasQuoted = false;
    return row.length > limits.maxColumns ? "too_many_columns" : null;
  };
  const endRow = (): CsvError | null => {
    const err = endCell();
    if (err) return err;
    // Blank lines (one empty cell) are skipped; the header plus `maxRows` data rows at most.
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
      if (rows.length > limits.maxRows + 1) return "too_many_rows";
    }
    row = [];
    return null;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      if (cell.length > limits.maxCellLength) return { ok: false, error: "cell_too_long" };
      continue;
    }
    if (c === '"' && cell === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (c === delimiter) {
      const err = endCell();
      if (err) return { ok: false, error: err };
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      const err = endRow();
      if (err) return { ok: false, error: err };
    } else {
      cell += c;
      if (cell.length > limits.maxCellLength) return { ok: false, error: "cell_too_long" };
    }
  }
  if (quoted) return { ok: false, error: "unterminated_quote" };
  if (cell !== "" || row.length > 0) {
    const err = endRow();
    if (err) return { ok: false, error: err };
  }
  return { ok: true, rows };
}

/** Parses CSV text (already decoded). The first non-blank line is the header. */
export function parseCsvText(text: string, limits: Partial<CsvLimits> = {}): CsvResult {
  const l = { ...DEFAULT_CSV_LIMITS, ...limits };
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const delimiter = detectDelimiter(body);
  const parsed = rowsOf(body, delimiter, l);
  if (!parsed.ok) return parsed;
  const [header, ...rows] = parsed.rows;
  if (!header) return { ok: false, error: "empty" };
  return { ok: true, table: { delimiter, header: header.map((h) => h.trim()), rows } };
}

/** Parses an uploaded CSV file's bytes: size, encoding, then `parseCsvText`. */
export function parseCsv(bytes: Uint8Array, limits: Partial<CsvLimits> = {}): CsvResult {
  const l = { ...DEFAULT_CSV_LIMITS, ...limits };
  if (bytes.byteLength > l.maxBytes) return { ok: false, error: "too_large" };
  const text = decodeCsvBytes(bytes);
  if (text === null) return { ok: false, error: "encoding" };
  return parseCsvText(text, l);
}

/** True for a cell a spreadsheet would treat as a formula (or that hides one behind a tab or CR). */
export const looksLikeFormula = (value: string): boolean => /^[=+\-@\t\r]/.test(value);

/** One cell for a CSV we write: formula-like values get a leading `'`; quoted when it has to be. */
export function csvCell(value: string): string {
  const safe = looksLikeFormula(value) ? `'${value}` : value;
  return /[",;\t\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows to CSV text (comma, CRLF line ends, as RFC 4180 says). */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
