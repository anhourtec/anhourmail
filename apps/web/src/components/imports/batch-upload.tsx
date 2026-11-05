// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Download, Upload } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";

import { IMPORT_BATCH_ROW_TEXT, IMPORT_BATCH_TEMPLATE, type ImportBatchRowCode } from "@anhourmail/shared/import";

import { listClass } from "../console/list-classes";
import { StepUpForm } from "../security/step-up-form";
import { primaryButtonClass, secondaryButtonClass } from "../ui-classes";

type Result = {
  batchId: string | null;
  rows: number;
  started: { row: number; importId: string; address: string }[];
  invalid: { row: number; code: ImportBatchRowCode }[];
};

/**
 * The admins' CSV upload (ADR-0030 §8): a template to fill in, the file (sent as it is; the server parses it and never
 * keeps it), a confirmation that it's the admin when the server asks, then which rows started and which didn't (by
 * line and reason, never the values).
 */
export function BatchUpload({ accountId, maxKb }: { accountId: string; maxKb: number }) {
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const base = `/accounts/${encodeURIComponent(accountId)}/import`;
  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_BATCH_TEMPLATE)}`;

  async function upload() {
    const f = file.current?.files?.[0];
    if (!f) {
      setError("Choose the CSV file first.");
      return;
    }
    if (f.size > maxKb * 1024) {
      setError(`The file can be up to ${String(maxKb)} KB.`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/imports/batch`, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: await f.arrayBuffer(),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: Result;
        error?: { code?: string; message?: string };
      } | null;
      if (!res.ok) {
        if (json?.error?.code === "step_up_required") setStepUp(true);
        else setError(json?.error?.message ?? "Something went wrong. Try again.");
        return;
      }
      if (json?.data) setResult(json.data);
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  if (stepUp) {
    return (
      <div className="max-w-xl">
        <StepUpForm
          why="Each row signs in to a mailbox here on its person's behalf, so a batch needs your console password."
          confirmLabel="Confirm and start"
          onConfirmed={async () => {
            setStepUp(false);
            await upload();
          }}
          onCancel={() => {
            setStepUp(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ol className="am-body flex max-w-[80ch] list-decimal flex-col gap-2 pl-5">
        <li>
          Download the template and fill in one row per mailbox: its address here, the old provider&apos;s IMAP server
          and port, the user name there and an app password made for this.
        </li>
        <li>
          Upload it. Each valid row starts its own import; rows with a problem are listed by line so you can fix them
          and upload just those again.
        </li>
        <li>Each mailbox&apos;s person gets an email saying an import into their mailbox started.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <a href={templateHref} download="import-template.csv" className={secondaryButtonClass}>
          <Download className="size-4" aria-hidden />
          Download template
        </a>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void upload();
        }}
        className="flex max-w-xl flex-col gap-3 rounded-xl border p-4"
      >
        <label htmlFor={`${id}-file`} className="am-h4">
          CSV file <span className="am-small font-normal">(UTF-8, up to {String(maxKb)} KB)</span>
        </label>
        <input
          id={`${id}-file`}
          ref={file}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            setName(e.target.files?.[0]?.name ?? null);
            setResult(null);
            setError(null);
          }}
          className="text-[14px] file:mr-3 file:h-9 file:rounded-lg file:border file:bg-background file:px-3 file:text-[14px] file:text-foreground"
        />
        <p className="am-micro">
          The file is read once to start the imports and isn&apos;t kept. Passwords in it are encrypted straight away.
        </p>
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        <div>
          <button type="submit" disabled={pending || name === null} className={primaryButtonClass}>
            <Upload className="size-4" aria-hidden />
            {pending ? "Starting…" : "Upload and start"}
          </button>
        </div>
      </form>

      {result && (
        <section aria-labelledby={`${id}-result`} role="status" className="flex flex-col gap-3">
          <h2 id={`${id}-result`} className="am-h3">
            {result.started.length === 0
              ? "No imports started"
              : `${String(result.started.length)} of ${String(result.rows)} ${result.rows === 1 ? "row" : "rows"} started`}
          </h2>
          {result.batchId && (
            <p className="am-body">
              <Link
                href={`${base}/batch/${encodeURIComponent(result.batchId)}`}
                className="text-primary underline-offset-2 hover:underline"
              >
                Follow this batch
              </Link>{" "}
              to see each mailbox&apos;s progress and download a report.
            </p>
          )}
          {result.invalid.length > 0 && (
            <div className={listClass.wrap}>
              <table className={listClass.table} aria-label="Rows that didn't start">
                <thead>
                  <tr>
                    <th className={listClass.th}>Line</th>
                    <th className={listClass.th}>Why it didn&apos;t start</th>
                  </tr>
                </thead>
                <tbody>
                  {result.invalid.map((r) => (
                    <tr key={r.row} className={listClass.row}>
                      <td className={`${listClass.td} font-mono`}>{String(r.row)}</td>
                      <td className={listClass.td}>{IMPORT_BATCH_ROW_TEXT[r.code]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
