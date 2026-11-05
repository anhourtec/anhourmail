// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { CircleStop, Pause, Play, RefreshCwOff } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import type { ImportFolderView } from "@anhourmail/core/imports";

import {
  IMPORT_BLOCKED_TEXT,
  IMPORT_ROLE_LABELS,
  importEndText,
  isTerminalImportStatus,
} from "@anhourmail/shared/import";

import { callApi } from "../api";
import { listClass } from "../console/list-classes";
import { ConfirmDialog } from "../console/flyout";
import { StepUpForm } from "../security/step-up-form";
import { inputClass, primaryButtonClass, secondaryButtonClass, dangerButtonClass } from "../ui-classes";
import { count, ImportProgress, importPercent, ImportStatus, type ImportDetailWire, when } from "./import-status";

/** How often an open import page asks for progress (ADR-0030 §17). */
const POLL_MS = 5000;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="am-micro">{label}</span>
      <span className="font-mono text-[15px]">{value}</span>
    </div>
  );
}

/**
 * The folder rows to show: named and role folders as they are; custom folders whose names are gone (the import ended)
 * summed into one "Other folders" row; empty folders that weren't left out are dropped (parents of nested folders).
 */
export function folderRows(folders: ImportFolderView[]): ImportFolderView[] {
  const out: ImportFolderView[] = [];
  let other: ImportFolderView | null = null;
  for (const f of folders) {
    if (f.messagesTotal === 0 && f.status !== "skipped") continue;
    if (f.role !== null || f.name !== null) {
      out.push(f);
      continue;
    }
    other ??= { ...f, id: "other", messagesTotal: 0, messagesDone: 0, duplicates: 0, tooLarge: 0, failed: 0 };
    other.messagesTotal += f.messagesTotal;
    other.messagesDone += f.messagesDone;
    other.duplicates += f.duplicates;
    other.tooLarge += f.tooLarge;
    other.failed += f.failed;
  }
  return other ? [...out, other] : out;
}

/**
 * One import, live (ADR-0030 §17): status and phase, progress, the per-folder list (custom folders by name only while
 * it runs), what to do when it waits for the person, and Pause / Resume / Cancel / Stop syncing. Polls every five
 * seconds while it is live and the page is visible.
 */
export function ImportDetail({ accountId, initial }: { accountId: string; initial: ImportDetailWire }) {
  const id = useId();
  const [data, setData] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const url = `/api/accounts/${encodeURIComponent(accountId)}/imports/${encodeURIComponent(initial.id)}`;
  const live = !isTerminalImportStatus(data.status);

  const reload = useCallback(async () => {
    const res = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const json = (await res.json().catch(() => null)) as { data?: ImportDetailWire } | null;
    if (json?.data) setData(json.data);
  }, [url]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [live, reload]);

  async function act(action: "pause" | "resume" | "cancel" | "stop-sync"): Promise<string | null> {
    setPending(action);
    setError(null);
    const res = await callApi(`${url}/${action}`, {
      method: "POST",
      ...(action === "resume" && newPassword !== "" ? { body: { password: newPassword } } : {}),
    });
    setPending(null);
    if (!res.ok) {
      if (res.code === "step_up_required") setStepUp(true);
      else setError(res.message);
      return res.code === "step_up_required" ? null : res.message;
    }
    if (action === "resume") setNewPassword("");
    await reload();
    return null;
  }

  const pct = importPercent(data);
  const folders = folderRows(data.folders);
  const blocked = data.status === "blocked" && data.blockedReason ? IMPORT_BLOCKED_TEXT[data.blockedReason] : null;
  const end = isTerminalImportStatus(data.status) ? importEndText(data.errorCode) : null;
  const canResume = data.status === "paused" || data.status === "blocked";
  const askPassword = data.status === "blocked" && data.blockedReason === "source_auth";

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${id}-status`} className="flex flex-col gap-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${id}-status`} className="am-h3">
            <ImportStatus value={data} />
          </h2>
          {pct !== null && <span className="font-mono text-[14px]">{String(pct)}%</span>}
        </div>
        <ImportProgress value={live || data.status === "completed" ? pct : (pct ?? 0)} label="Import progress" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Copied"
            value={`${count(data.messagesDone)}${data.messagesTotal > 0 ? ` of ${count(data.messagesTotal)}` : ""}`}
          />
          <Stat label="Already there (skipped)" value={count(data.duplicates)} />
          <Stat label="Too large" value={count(data.tooLarge)} />
          <Stat label="Not accepted" value={count(data.failed)} />
        </div>
        {blocked && (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-lg border border-[rgb(var(--am-status-warning))]/40 bg-[rgb(var(--am-status-warning))]/5 p-3"
          >
            <p className="text-[14px] font-medium">{blocked.title}</p>
            <p className="am-small text-foreground">{blocked.fix}</p>
          </div>
        )}
        {end && <p className="am-small text-foreground">{end}</p>}
        {data.options.sync && data.status === "syncing" && (
          <div role="status" className="flex flex-col gap-1 rounded-lg border border-primary/40 bg-primary/5 p-3">
            {data.domainActive ? (
              <p className="text-[14px]">
                Your domain&apos;s mail now arrives here. When nothing new is coming in at the old provider, stop
                syncing.
              </p>
            ) : (
              <p className="text-[14px]">
                New mail at the old provider keeps being copied here until you stop syncing
                {data.syncUntil ? `, or until ${when(data.syncUntil)}` : ""}.
              </p>
            )}
          </div>
        )}
        {live && (
          <div className="flex flex-wrap items-end gap-2">
            {askPassword && (
              <div className="flex w-full max-w-sm flex-col gap-1.5">
                <label htmlFor={`${id}-pw`} className="text-[14px] font-medium">
                  New app password from the old provider
                </label>
                <input
                  id={`${id}-pw`}
                  type="password"
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                  }}
                  autoComplete="off"
                  className={`${inputClass} font-mono`}
                />
              </div>
            )}
            {canResume && (
              <button
                type="button"
                onClick={() => void act("resume")}
                disabled={pending !== null || (askPassword && newPassword === "")}
                className={primaryButtonClass}
              >
                <Play className="size-4" aria-hidden />
                {pending === "resume" ? "Resuming…" : "Resume"}
              </button>
            )}
            {!canResume && !data.pauseRequested && (
              <button
                type="button"
                onClick={() => void act("pause")}
                disabled={pending !== null}
                className={secondaryButtonClass}
              >
                <Pause className="size-4" aria-hidden />
                {pending === "pause" ? "Pausing…" : "Pause"}
              </button>
            )}
            {data.options.sync && (data.status === "syncing" || data.status === "running") && (
              <button
                type="button"
                onClick={() => void act("stop-sync")}
                disabled={pending !== null}
                className={secondaryButtonClass}
              >
                <RefreshCwOff className="size-4" aria-hidden />
                {pending === "stop-sync" ? "Stopping…" : "Stop syncing"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setConfirmCancel(true);
              }}
              disabled={pending !== null}
              className={dangerButtonClass}
            >
              <CircleStop className="size-4" aria-hidden />
              Cancel import
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="am-small text-destructive">
            {error}
          </p>
        )}
        {stepUp && (
          <StepUpForm
            why="Resuming may make a new sign-in to your mailbox for the import, so it needs your console password."
            confirmLabel="Confirm and resume"
            onConfirmed={async () => {
              setStepUp(false);
              await act("resume");
            }}
            onCancel={() => {
              setStepUp(false);
            }}
          />
        )}
      </section>

      <section aria-labelledby={`${id}-about`} className="flex flex-col gap-3">
        <h2 id={`${id}-about`} className="am-h3">
          Details
        </h2>
        <dl className="grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">Into</dt>
          <dd className="font-mono">{data.address}</dd>
          <dt className="text-muted-foreground">From</dt>
          <dd>
            <span className="font-mono">{data.sourceHost}</span>, port{" "}
            <span className="font-mono">{data.sourcePort}</span>
          </dd>
          <dt className="text-muted-foreground">Started</dt>
          <dd>
            {when(data.createdAt)}
            {!data.startedByYou && data.requestedAs === "admin" ? " by an admin" : ""}
          </dd>
          {data.finishedAt && (
            <>
              <dt className="text-muted-foreground">Ended</dt>
              <dd>{when(data.finishedAt)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Options</dt>
          <dd>
            {[
              data.options.excludeJunkTrash ? "Junk and Deleted items left out" : "Junk and Deleted items copied",
              data.options.intoSubfolder ? "folders under Imported" : null,
              data.options.sync ? "keeps copying new mail" : null,
            ]
              .filter(Boolean)
              .join("; ")}
          </dd>
        </dl>
      </section>

      <section aria-labelledby={`${id}-folders`} className="flex flex-col gap-3">
        <h2 id={`${id}-folders`} className="am-h3">
          Folders
        </h2>
        {folders.length === 0 ? (
          <p className="am-small">
            {live ? "The folder list appears once the old mailbox has been checked." : "No folders were copied."}
          </p>
        ) : (
          <div className={listClass.wrap}>
            <table className={listClass.table} aria-label="Folders">
              <thead>
                <tr>
                  <th className={listClass.th}>Folder</th>
                  <th className={`${listClass.th} text-right`}>Copied</th>
                  <th className={`${listClass.th} text-right`}>Skipped</th>
                  <th className={`${listClass.th} hidden text-right sm:table-cell`}>Too large</th>
                  <th className={`${listClass.th} hidden text-right sm:table-cell`}>Not accepted</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.id} className={listClass.row}>
                    <td className={listClass.td}>
                      {f.role === null ? (
                        <span className={f.name ? "font-mono text-[13px]" : ""}>
                          {f.name ?? IMPORT_ROLE_LABELS.custom}
                        </span>
                      ) : (
                        IMPORT_ROLE_LABELS[f.role]
                      )}
                      {f.status === "skipped" && <span className="am-micro ml-2">left out</span>}
                    </td>
                    <td className={`${listClass.td} text-right font-mono whitespace-nowrap`}>
                      {count(f.messagesDone)}
                      {f.messagesTotal > 0 ? ` / ${count(f.messagesTotal)}` : ""}
                    </td>
                    <td className={`${listClass.td} text-right font-mono whitespace-nowrap`}>{count(f.duplicates)}</td>
                    <td className={`${listClass.td} hidden text-right font-mono sm:table-cell`}>{count(f.tooLarge)}</td>
                    <td className={`${listClass.td} hidden text-right font-mono sm:table-cell`}>{count(f.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="am-micro">
          Folder names are shown only while the import runs; afterwards we keep just the counts.
        </p>
      </section>

      {confirmCancel && (
        <ConfirmDialog
          title="Cancel this import?"
          confirmLabel="Cancel import"
          pendingLabel="Cancelling…"
          onConfirm={async () => {
            const err = await act("cancel");
            if (err === null) setConfirmCancel(false);
            return err;
          }}
          onCancel={() => {
            setConfirmCancel(false);
          }}
        >
          Mail already copied stays in the mailbox. The import stops now and its sign-in details are deleted; to carry
          on later you start a new one (nothing is copied twice).
        </ConfirmDialog>
      )}
    </div>
  );
}
