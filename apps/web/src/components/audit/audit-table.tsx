// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AuditRow } from "@/server/audit-rows";

const RESULT: Record<AuditRow["result"], { text: string; tone: string }> = {
  success: { text: "Success", tone: "success" },
  denied: { text: "Denied", tone: "danger" },
  failed: { text: "Failed", tone: "warning" },
};

const th = "am-mono px-4 py-2.5 font-normal";

function Actor({ row }: { row: AuditRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5">
        {row.actor.kind === "staff" ? (
          <span className="am-status am-status--warning">{row.actor.label}</span>
        ) : row.actor.kind === "system" ? (
          <span className="am-status am-status--neutral">{row.actor.label}</span>
        ) : (
          <span className="am-small break-all text-foreground">{row.actor.label}</span>
        )}
      </span>
      {row.actor.detail && <span className="am-micro break-all">{row.actor.detail}</span>}
    </div>
  );
}

/** Read-only audit table; a row opens a drawer with the whole entry (meta is redacted when it is written). */
export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const [open, setOpen] = useState<AuditRow | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  if (rows.length === 0) return <p className="am-small">Nothing matches these filters.</p>;
  return (
    <>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left">
          <thead className="border-b bg-muted/50">
            <tr>
              <th scope="col" className={`${th} hidden sm:table-cell`}>
                When
              </th>
              <th scope="col" className={`${th} hidden md:table-cell`}>
                Who
              </th>
              <th scope="col" className={th}>
                What
              </th>
              <th scope="col" className={`${th} hidden lg:table-cell`}>
                Target
              </th>
              <th scope="col" className={`${th} hidden sm:table-cell`}>
                Result
              </th>
              <th scope="col" className={`${th} hidden xl:table-cell`}>
                IP
              </th>
              <th scope="col" className={th}>
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="am-small am-num hidden whitespace-nowrap px-4 py-3 sm:table-cell">{r.at}</td>
                <td className="hidden px-4 py-3 md:table-cell">
                  <Actor row={r} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="am-micro am-num sm:hidden">{r.at}</span>
                    <span className="am-body">{r.actionLabel}</span>
                    <span className="am-micro">{r.areaLabel}</span>
                    <span className="am-micro break-all md:hidden">{r.actor.label}</span>
                    {r.result !== "success" && (
                      <span className={`am-status am-status--${RESULT[r.result].tone} w-fit sm:hidden`}>
                        {RESULT[r.result].text}
                      </span>
                    )}
                  </div>
                </td>
                <td className="am-code hidden break-all px-4 py-3 lg:table-cell">{r.target.label ?? "—"}</td>
                <td className="hidden px-4 py-3 sm:table-cell">
                  <span className={`am-status am-status--${RESULT[r.result].tone}`}>{RESULT[r.result].text}</span>
                </td>
                <td className="am-code hidden px-4 py-3 xl:table-cell">{r.ip ?? "—"}</td>
                <td className="px-2 py-2 text-right">
                  <button
                    type="button"
                    aria-label={`Details: ${r.actionLabel}, ${r.at}`}
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setOpen(r);
                    }}
                    className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <ChevronRight className="size-4" aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <AuditDrawer
          row={open}
          onClose={() => {
            setOpen(null);
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="am-micro">{label}</dt>
      <dd className="am-small min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** A modal side panel (no browser dialogs): Escape or the backdrop closes it, focus starts on Close. */
function AuditDrawer({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close details"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-foreground/20 backdrop-blur-[1px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-drawer-title"
        className="relative flex h-full w-full max-w-md flex-col gap-5 overflow-y-auto border-l bg-background p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="audit-drawer-title" className="am-h3">
              {row.actionLabel}
            </h2>
            <code className="am-code break-all text-muted-foreground">{row.action}</code>
          </div>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-accent"
          >
            <X className="size-4" aria-hidden />
            <span className="sr-only">Close</span>
          </button>
        </div>
        <dl className="grid gap-4">
          <Field label="When">
            <span className="am-num">{row.atFull}</span>
          </Field>
          <Field label="Who">
            <Actor row={row} />
          </Field>
          {row.reason && <Field label="Reason given">{row.reason}</Field>}
          <Field label="Result">
            <span className="flex flex-wrap items-center gap-2">
              <span className={`am-status am-status--${RESULT[row.result].tone}`}>{RESULT[row.result].text}</span>
              {row.errorCode && <code className="am-code">{row.errorCode}</code>}
            </span>
          </Field>
          <Field label="Target">
            <span className="flex flex-col gap-0.5">
              <span className="am-code break-all">{row.target.label ?? "—"}</span>
              <span className="am-micro">
                {row.target.type}
                {row.target.id ? ` · ${row.target.id}` : ""}
              </span>
            </span>
          </Field>
          <Field label="IP (network only)">
            <code className="am-code">{row.ip ?? "—"}</code>
          </Field>
          {row.requestId && (
            <Field label="Request id">
              <code className="am-code break-all">{row.requestId}</code>
            </Field>
          )}
          <Field label="Details">
            {row.meta ? (
              <pre className="am-code max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3">
                {row.meta}
              </pre>
            ) : (
              "None"
            )}
          </Field>
          <Field label="Entry">
            <span className="am-micro am-num break-all">
              #{row.seq} · {row.hash.slice(0, 16)}…
            </span>
          </Field>
        </dl>
        <p className="am-micro">
          Audit entries can't be edited or deleted. Secrets and mail content are never recorded.
        </p>
      </div>
    </div>
  );
}
