// SPDX-License-Identifier: AGPL-3.0-only
import type {
  ImportBlockedReason,
  ImportFolderRole,
  ImportPhase,
  ImportSourceKind,
  ImportSourcePort,
  ImportStatus,
  IMPORT_TERMINAL_STATUSES,
} from "@anhourmail/shared/import";

/**
 * A mail import (ADR-0030 §12): copying one mailbox's mail from another IMAP server into one of ours. The control plane
 * keeps intent, progress counters and two sealed secrets while it runs — never mail content (rule 24): no subjects,
 * Message-IDs, senders, and folder names only sealed and only while it runs. Making it terminal wipes the secrets,
 * the source username and the folder names in the same write (`MailImportRepository.end`).
 */
export type MailImportOptions = {
  /** Leave the source's Junk and Trash out (default on). */
  excludeJunkTrash: boolean;
  /** Put custom folders under `Imported/` (default off). */
  intoSubfolder: boolean;
  /** Cut-over sync: keep copying new mail until stopped or the window ends (default off). */
  sync: boolean;
};

export const DEFAULT_IMPORT_OPTIONS: MailImportOptions = { excludeJunkTrash: true, intoSubfolder: false, sync: false };

/** Options from stored JSON (or a request), with defaults for anything missing or of the wrong type. */
export function importOptions(input: unknown): MailImportOptions {
  const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const flag = (k: keyof MailImportOptions) => {
    const v = o[k];
    return typeof v === "boolean" ? v : DEFAULT_IMPORT_OPTIONS[k];
  };
  return { excludeJunkTrash: flag("excludeJunkTrash"), intoSubfolder: flag("intoSubfolder"), sync: flag("sync") };
}

/**
 * What finished history keeps of the source host (ADR-0030 update 2026-11-05): the registrable domain only, so a
 * self-hosted server's full name isn't kept once the import ends. Without a public-suffix list this keeps the last
 * two labels, or three when the second-to-last looks like a second-level suffix (`co.uk`, `com.au`). IP literals
 * become `IP address`.
 */
export function finishedSourceHost(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return "IP address";
  const labels = host.split(".").filter((l) => l !== "");
  const second = labels.at(-2) ?? "";
  const tld = labels.at(-1) ?? "";
  const keep = tld.length === 2 && labels.length > 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go)$/.test(second) ? 3 : 2;
  return labels.slice(-keep).join(".") || "unknown";
}

export type MailImportCounters = {
  foldersTotal: number;
  messagesTotal: number;
  bytesTotal: number;
  messagesDone: number;
  bytesDone: number;
  duplicates: number;
  tooLarge: number;
  failed: number;
};

export const ZERO_IMPORT_COUNTERS: MailImportCounters = {
  foldersTotal: 0,
  messagesTotal: 0,
  bytesTotal: 0,
  messagesDone: 0,
  bytesDone: 0,
  duplicates: 0,
  tooLarge: 0,
  failed: 0,
};

export type TerminalImportStatus = (typeof IMPORT_TERMINAL_STATUSES)[number];
export type LiveImportStatus = Exclude<ImportStatus, TerminalImportStatus>;

export type MailImport = MailImportCounters & {
  id: string;
  accountId: string;
  mailboxId: string;
  batchId: string | null;
  /** The console user who started it (null once their login is deleted). */
  requestedBy: string | null;
  /** `own`: into the person's own mailbox; `admin`: with `mailbox.import.any` (the person is told). */
  requestedAs: "own" | "admin";
  sourceKind: ImportSourceKind;
  sourceHost: string;
  sourcePort: ImportSourcePort;
  /** Null after the wipe. */
  sourceUsername: string | null;
  /** Sealed (`IMPORT_SECRET_PURPOSES.source`); null after the wipe. */
  sourceSecret: string | null;
  /** Sealed (`IMPORT_SECRET_PURPOSES.destination`); null after the wipe. */
  destinationSecret: string | null;
  /** The mail server's credential (kept after the wipe: the revoke job matches id and creation time). */
  destinationCredentialId: string | null;
  destinationCredentialCreatedAt: Date | null;
  destinationCredentialExpiresAt: Date | null;
  options: MailImportOptions;
  status: ImportStatus;
  phase: ImportPhase | null;
  blockedReason: ImportBlockedReason | null;
  /** Our error code when it failed or a step failed (never server text). */
  errorCode: string | null;
  pauseRequested: boolean;
  leaseToken: string | null;
  leaseUntil: Date | null;
  runAfter: Date;
  /** Consecutive transient failures (reset by a successful slice). */
  attempts: number;
  syncUntil: Date | null;
  lastPassAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  credentialsWipedAt: Date | null;
  notifiedAt: Date | null;
};

/** What a service writes when it starts an import (counters, lease and timestamps begin empty). */
export type NewMailImport = Pick<
  MailImport,
  | "id"
  | "accountId"
  | "mailboxId"
  | "batchId"
  | "requestedBy"
  | "requestedAs"
  | "sourceKind"
  | "sourceHost"
  | "sourcePort"
  | "sourceUsername"
  | "sourceSecret"
  | "destinationSecret"
  | "destinationCredentialId"
  | "destinationCredentialCreatedAt"
  | "destinationCredentialExpiresAt"
  | "options"
  | "syncUntil"
  | "createdAt"
  | "runAfter"
>;

/**
 * What services and the runner may change on a live import. Making it terminal is `end` (it wipes); a terminal import
 * never changes again (no secret can be written back to it).
 */
export type MailImportPatch = Partial<
  MailImportCounters &
    Pick<
      MailImport,
      | "phase"
      | "blockedReason"
      | "errorCode"
      | "pauseRequested"
      | "runAfter"
      | "attempts"
      | "sourceUsername"
      | "sourceSecret"
      | "destinationSecret"
      | "destinationCredentialId"
      | "destinationCredentialCreatedAt"
      | "destinationCredentialExpiresAt"
      | "syncUntil"
      | "lastPassAt"
      | "startedAt"
    > & { status: LiveImportStatus }
>;

export type MailImportFolderStatus = "pending" | "copying" | "done" | "skipped";

/** One source folder's progress. `sourcePath` is sealed (`IMPORT_SECRET_PURPOSES.folder`) and null once it ends. */
export type MailImportFolder = {
  id: string;
  importId: string;
  role: ImportFolderRole | null;
  sourcePath: string | null;
  uidValidity: bigint | null;
  lastUid: bigint;
  messagesTotal: number;
  messagesDone: number;
  duplicates: number;
  tooLarge: number;
  failed: number;
  bytesDone: number;
  status: MailImportFolderStatus;
  updatedAt: Date;
};

/** An admin's CSV batch: one import per valid row (ADR-0030 §8). The CSV itself is never stored. */
export type MailImportBatch = {
  id: string;
  accountId: string;
  createdBy: string | null;
  rows: number;
  createdAt: Date;
};
