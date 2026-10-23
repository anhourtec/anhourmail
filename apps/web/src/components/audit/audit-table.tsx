// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ChevronRight, Shield } from "lucide-react";
import { useRef, useState } from "react";

import type { AuditRow } from "@/server/audit-rows";

import { ListEmpty, listClass } from "../console/data-list";
import { Flyout } from "../console/flyout";
import { StatusText, type Tone } from "../console/status-text";

const RESULT: Record<AuditRow["result"], { text: string; tone: Tone }> = {
  success: { text: "Success", tone: "success" },
  denied: { text: "Denied", tone: "danger" },
  failed: { text: "Failed", tone: "warning" },
};

const th = listClass.th;

function Actor({ row }: { row: AuditRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5">
        {row.actor.kind === "staff" ? (
          <span className="inline-flex items-center gap-1.5 text-[14px]">
            <Shield className="size-4 shrink-0 text-[rgb(var(--am-status-warning))]" aria-hidden />
            {row.actor.label}
          </span>
        ) : row.actor.kind === "system" ? (
          <span className="text-[14px] text-muted-foreground">{row.actor.label}</span>
        ) : (
          <span className="text-[14px] break-all">{row.actor.label}</span>
        )}
      </span>
      {row.actor.detail && <span className="am-micro break-all">{row.actor.detail}</span>}
    </div>
  );
}

/**
 * Read-only audit list (newest first, paged on the server, so not re-sortable here); a row's details button opens
 * the whole entry in a flyout panel (meta is redacted when it is written). `ipKind` only labels the address: whether
 * it is the full address (the platform log) or its network part (account logs) is decided by the audit service.
 */
export function AuditTable({ rows, ipKind = "network" }: { rows: AuditRow[]; ipKind?: "full" | "network" }) {
  const [open, setOpen] = useState<AuditRow | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  if (rows.length === 0) return <ListEmpty>Nothing matches these filters.</ListEmpty>;
  return (
    <>
      <div className={listClass.wrap}>
        <table className={listClass.table}>
          <thead>
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
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-open={open?.id === r.id} className={listClass.row}>
                <td className={`${listClass.td} am-num hidden whitespace-nowrap sm:table-cell`}>{r.at}</td>
                <td className={`${listClass.td} hidden md:table-cell`}>
                  <Actor row={r} />
                </td>
                <td className={listClass.td}>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="am-micro am-num sm:hidden">{r.at}</span>
                    <span className="font-medium text-[14px]">{r.actionLabel}</span>
                    <span className="am-micro">{r.areaLabel}</span>
                    <span className="am-micro break-all md:hidden">{r.actor.label}</span>
                    {r.result !== "success" && (
                      <span className="sm:hidden">
                        <StatusText tone={RESULT[r.result].tone}>{RESULT[r.result].text}</StatusText>
                      </span>
                    )}
                  </div>
                </td>
                <td className={`${listClass.td} hidden font-mono text-[13px] break-all lg:table-cell`}>
                  {r.target.label ?? "—"}
                </td>
                <td className={`${listClass.td} hidden sm:table-cell`}>
                  <StatusText tone={RESULT[r.result].tone}>{RESULT[r.result].text}</StatusText>
                </td>
                <td className={`${listClass.td} hidden font-mono text-[13px] xl:table-cell`}>{r.ip ?? "—"}</td>
                <td className={`${listClass.td} pr-1 text-right`}>
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
          ipKind={ipKind}
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
      <dt className="text-[14px] font-medium">{label}</dt>
      <dd className="min-w-0 text-[14px] break-words">{children}</dd>
    </div>
  );
}

/** The whole entry in a flyout panel (no browser dialogs): Escape, Close or the dimmed list closes it. */
function AuditDrawer({ row, ipKind, onClose }: { row: AuditRow; ipKind: "full" | "network"; onClose: () => void }) {
  return (
    <Flyout label={row.actionLabel} onClose={onClose} size="md">
      <div className="flex flex-col gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="am-h2">{row.actionLabel}</h2>
          <code className="am-code break-all text-muted-foreground">{row.action}</code>
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
              <StatusText tone={RESULT[row.result].tone}>{RESULT[row.result].text}</StatusText>
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
          <Field label={ipKind === "full" ? "IP address" : "IP (network only)"}>
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
          Audit entries can&apos;t be edited or deleted. Secrets and mail content are never recorded.
        </p>
      </div>
    </Flyout>
  );
}
