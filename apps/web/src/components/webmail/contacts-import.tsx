// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { FileUp } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { CsvTable } from "@anhourmail/shared/csv";
import { detectCsvColumns, IMPORT, IMPORT_CSV_FIELDS, type ImportCsvField } from "@anhourmail/shared/import";

import {
  CONTACTS_FILE_TOO_LARGE,
  CSV_ERROR_TEXT,
  CSV_FIELD_LABELS,
  CSV_PREVIEW_ROWS,
  readContactsCsv,
} from "@/server/webmail/contacts-csv";
import type { ContactsImportCounts } from "@/server/webmail/contacts-import";

import { primaryButtonClass, secondaryButtonClass } from "@/components/ui-classes";

import { Modal } from "./dialogs";
import { type MailClient, RefusedError } from "./mail-client";

const CARDS = IMPORT.contactsMaxCards.toLocaleString("en-CA");
const MB = Math.round(IMPORT.contactsMaxBytes / (1024 * 1024));

type Step =
  | { kind: "pick"; error: string | null }
  | { kind: "map"; file: File; table: CsvTable; columns: (ImportCsvField | null)[]; error: string | null }
  | { kind: "done"; counts: ContactsImportCounts };

const isCsv = (f: File) => /\.csv$/i.test(f.name) || f.type === "text/csv";
const n = (v: number) => v.toLocaleString("en-CA");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

/** Example values of a column from the file's first rows (what the person recognises the column by). */
function examples(table: CsvTable, i: number): string {
  const seen = table.rows
    .slice(0, CSV_PREVIEW_ROWS)
    .map((r) => (r[i] ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return seen.slice(0, 2).join(" · ") || "Empty in the first rows";
}

/** The result lines, only the counts that aren't zero after the first. */
function resultLines(c: ContactsImportCounts): string[] {
  return [
    `${plural(c.created, "new contact", "new contacts")} added`,
    c.merged > 0 ? `${plural(c.merged, "contact", "contacts")} merged into ones you have (empty fields filled)` : "",
    c.duplicates > 0 ? `${plural(c.duplicates, "contact was", "contacts were")} already in your contacts` : "",
    c.invalid > 0
      ? `${plural(c.invalid, "entry", "entries")} skipped: no name, address or phone, or a value that isn't valid`
      : "",
    c.overCap > 0
      ? `${plural(c.overCap, "contact", "contacts")} not added: a mailbox can keep up to 5,000 contacts`
      : "",
  ].filter(Boolean);
}

/**
 * Contacts → Import (ADR-0030 §10): pick a .vcf or .csv file; a vCard is imported at once, a CSV first shows its
 * columns with the detected field (or "Don't import") and examples from its first rows so the person can change the
 * mapping. The server parses the whole file again with that mapping (this preview is never trusted) and merges by email;
 * the counts come back here.
 */
export function ContactsImportDialog({
  client,
  account,
  onClose,
  onImported,
}: {
  client: MailClient;
  account: string;
  onClose: () => void;
  /** After anything was written: the contact list reloads. */
  onImported: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>({ kind: "pick", error: null });
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hint = useId();

  const finish = async (counts: ContactsImportCounts) => {
    setStep({ kind: "done", counts });
    if (counts.created > 0 || counts.merged > 0) await onImported();
  };

  const send = async (
    file: File,
    as: { format: "vcard" } | { format: "csv"; columns: (ImportCsvField | null)[] },
    onError: (message: string) => void,
  ) => {
    setBusy(true);
    try {
      await finish(await client.importContacts(account, file, as));
    } catch (err) {
      onError(err instanceof RefusedError ? err.message : "That file couldn't be imported. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File) => {
    if (file.size > IMPORT.contactsMaxBytes) {
      setStep({ kind: "pick", error: CONTACTS_FILE_TOO_LARGE });
      return;
    }
    if (!isCsv(file)) {
      await send(file, { format: "vcard" }, (error) => {
        setStep({ kind: "pick", error });
      });
      return;
    }
    const read = readContactsCsv(new Uint8Array(await file.arrayBuffer()));
    if (!read.ok) {
      setStep({ kind: "pick", error: CSV_ERROR_TEXT[read.error] });
      return;
    }
    if (read.table.rows.length === 0) {
      setStep({ kind: "pick", error: "This file has column names but no contacts." });
      return;
    }
    setStep({ kind: "map", file, table: read.table, columns: detectCsvColumns(read.table.header), error: null });
  };

  if (step.kind === "done") {
    return (
      <Modal key="done" title="Contacts imported" onClose={onClose} wide>
        <ul aria-label="Import result" className="flex flex-col gap-1.5 text-[14px]">
          {resultLines(step.counts).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className={primaryButtonClass}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  if (step.kind === "map") {
    const { table, columns } = step;
    const imported = columns.filter((c) => c !== null).length;
    return (
      <Modal key="map" title="Choose what each column holds" onClose={onClose} size="lg">
        <p className="am-small mb-3">
          {plural(table.rows.length, "contact", "contacts")} in <span className="font-mono">{step.file.name}</span>. We
          picked a field for the columns we recognised; change any of them, or choose Don&apos;t import. Contacts with
          an address you already have only fill in what&apos;s empty there.
        </p>
        <div className="max-h-[55vh] overflow-y-auto rounded-xl border">
          <table className="w-full table-fixed text-[13.5px]">
            <thead className="sticky top-0 bg-popover">
              <tr className="border-b text-left text-[12.5px] text-muted-foreground">
                <th scope="col" className="w-[38%] px-3 py-2 font-normal">
                  Column and examples
                </th>
                <th scope="col" className="px-3 py-2 font-normal">
                  Import as
                </th>
              </tr>
            </thead>
            <tbody>
              {table.header.map((h, i) => {
                const label = h || `Column ${String(i + 1)}`;
                return (
                  <tr key={`${h}-${String(i)}`} className="border-b last:border-b-0">
                    <td className="min-w-0 px-3 py-2 align-top">
                      <span className="block truncate font-medium">{label}</span>
                      <span className="block truncate text-[12.5px] text-muted-foreground">{examples(table, i)}</span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <select
                        aria-label={`Import ${label} as`}
                        value={columns[i] ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          const next = columns.map((c, j) =>
                            j === i ? (IMPORT_CSV_FIELDS.find((f) => f === v) ?? null) : c,
                          );
                          setStep({ ...step, columns: next, error: null });
                        }}
                        className="h-9 w-full rounded-lg border bg-background px-2 text-[14px]"
                      >
                        <option value="">Don&apos;t import</option>
                        {IMPORT_CSV_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {CSV_FIELD_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {step.error && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {step.error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setStep({ kind: "pick", error: null });
            }}
            className={secondaryButtonClass}
          >
            Choose another file
          </button>
          <button
            type="button"
            disabled={busy || imported === 0}
            onClick={() => {
              void send(step.file, { format: "csv", columns }, (error) => {
                setStep({ ...step, error });
              });
            }}
            className={primaryButtonClass}
          >
            {busy ? "Importing…" : imported === 0 ? "Choose a column to import" : "Import contacts"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal key="pick" title="Import contacts" onClose={onClose} wide>
      <p id={hint} className="am-small">
        Choose a vCard (.vcf) or CSV (.csv) file exported from another contacts app, up to {MB} MB and {CARDS} contacts.
        Contacts whose address you already have are merged: we only fill in what&apos;s empty, and never change or
        remove anything.
      </p>
      <input
        ref={input}
        type="file"
        accept=".vcf,.csv,text/vcard,text/x-vcard,text/csv"
        className="sr-only"
        aria-label="Contacts file"
        aria-describedby={hint}
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void pick(f);
        }}
      />
      {step.error && (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {step.error}
        </p>
      )}
      <div className="mt-5 flex justify-end">
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className={primaryButtonClass}>
          <FileUp className="size-4" aria-hidden />
          {busy ? "Importing…" : "Choose a file"}
        </button>
      </div>
    </Modal>
  );
}
