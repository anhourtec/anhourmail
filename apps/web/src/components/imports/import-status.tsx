// SPDX-License-Identifier: AGPL-3.0-only
import type { ImportDetail, ImportFolderView, ImportView } from "@anhourmail/core/imports";
import { IMPORT_BLOCKED_TEXT, isTerminalImportStatus } from "@anhourmail/shared/import";

import { StatusText, type Tone } from "../console/status-text";

/*
 * Mail import status for the console (ADR-0030 §17): one label and tone per state, the progress figure, and the wire
 * shape the pages and the polling share (dates as ISO strings, as the API answers them). A plain module (no
 * "use client") so server pages and client components both use it.
 */

/** A value as JSON carries it: dates become ISO strings. */
type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

export type ImportWire = Wire<ImportView>;
export type ImportDetailWire = Wire<Omit<ImportDetail, "folders">> & { folders: ImportFolderView[] };

/** The same object, as the API would send it (server pages hand it to client components in this shape). */
export const toWire = <T,>(value: T): T extends ImportDetail ? ImportDetailWire : ImportWire =>
  JSON.parse(JSON.stringify(value)) as T extends ImportDetail ? ImportDetailWire : ImportWire;

type StatusInput = Pick<ImportWire, "status" | "phase" | "pauseRequested" | "blockedReason" | "errorCode">;

/** "Copying", "Paused", "Needs you: the mailbox is full", … with a tone for the icon. */
export function importStatus(i: StatusInput): { label: string; tone: Tone } {
  if (i.pauseRequested && !isTerminalImportStatus(i.status)) return { label: "Pausing…", tone: "neutral" };
  switch (i.status) {
    case "queued":
      return { label: "Waiting to start", tone: "info" };
    case "running":
      return { label: i.phase === "verifying" ? "Checking the old mailbox" : "Copying", tone: "info" };
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "blocked":
      return {
        label: i.blockedReason ? `Needs you: ${IMPORT_BLOCKED_TEXT[i.blockedReason].title.toLowerCase()}` : "Needs you",
        tone: "warning",
      };
    case "syncing":
      return { label: "Copying new mail", tone: "info" };
    case "completed":
      return i.errorCode === null
        ? { label: "Finished", tone: "success" }
        : { label: "Finished early", tone: "warning" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "failed":
      return { label: "Ended", tone: "danger" };
  }
}

export function ImportStatus({ value }: { value: StatusInput }) {
  const s = importStatus(value);
  return <StatusText tone={s.tone}>{s.label}</StatusText>;
}

const fmt = new Intl.NumberFormat("en-CA");
export const count = (n: number): string => fmt.format(n);

/** Messages handled so far (copied, skipped or refused) out of the total, 0–100; null while the total is being counted. */
export function importPercent(
  i: Pick<ImportWire, "messagesTotal" | "messagesDone" | "duplicates" | "tooLarge" | "failed" | "status">,
): number | null {
  // Syncing means the first full pass is done (the total also counts messages never copied, e.g. deleted ones).
  if (i.status === "completed" || i.status === "syncing") return 100;
  // Unknown while it is still counting; an empty bar once it waits or ended before counting anything.
  if (i.messagesTotal <= 0) return i.status === "queued" || i.status === "running" ? null : 0;
  const handled = i.messagesDone + i.duplicates + i.tooLarge + i.failed;
  return Math.max(0, Math.min(100, Math.round((handled / i.messagesTotal) * 100)));
}

/** A thin progress bar with its figure for screen readers. */
export function ImportProgress({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(value === null ? {} : { "aria-valuenow": value })}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={`h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none ${value === null ? "w-1/4 animate-pulse motion-reduce:animate-none" : ""}`}
        style={value === null ? undefined : { width: `${String(value)}%` }}
      />
    </div>
  );
}

const day = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
/** "Nov 5, 2026, 12:00 p.m. UTC"-style, for the lists (UTC like the rest of the console). */
export const when = (iso: string | null): string => (iso === null ? "—" : `${day.format(new Date(iso))} UTC`);
