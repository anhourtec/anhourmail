// SPDX-License-Identifier: AGPL-3.0-only
import type { DataExportKind, DataExportStatus } from "@anhourmail/shared/data-lifecycle";

/**
 * A data export (ADR-0025): an archive of control-plane data the worker builds for the person who asked. `account`:
 * one account's settings, people, domains, mailboxes, aliases and audit log (Owners). `personal`: the person's own
 * profile, memberships, mailbox settings, sign-in security and activity. Mail itself is never in it (it is exported from
 * the webmail and never stored by us). The archive is sealed with the key ring and kept until `expiresAt`.
 */
export type DataExport = {
  id: string;
  kind: DataExportKind;
  /** The account exported (`account`); null for a personal export. */
  accountId: string | null;
  /** The console user who asked: the only person who can download it. */
  requestedBy: string;
  status: DataExportStatus;
  createdAt: Date;
  /** When the current (or last) build started. */
  startedAt: Date | null;
  readyAt: Date | null;
  /** Set when ready: the archive is deleted after this. */
  expiresAt: Date | null;
  /** Last download. */
  downloadedAt: Date | null;
  /** Size of the sealed archive (bytes) once ready. */
  sizeBytes: number | null;
  /** Builds started (a crashed or failed build is tried again up to `DATA_EXPORT.maxAttempts`). */
  attempts: number;
  /** Why the last build failed (an error name, never data). */
  error: string | null;
};

/**
 * An account waiting to be deleted (ADR-0025). Its mailboxes are suspended (held with kind `deletion`) from
 * `requestedAt`; at `deleteAfter` the scheduler starts removing it (`startedAt`), after which it can't be cancelled.
 */
export type AccountDeletion = {
  accountId: string;
  requestedBy: string;
  requestedAt: Date;
  deleteAfter: Date;
  startedAt: Date | null;
};

/** A console login as an export and the deletion emails need it. */
export type PersonRecord = {
  id: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string | null;
  emailVerified: boolean;
  createdAt: Date;
};

/** One file in an export archive (paths use `/`). */
export type ExportFile = { name: string; data: string };
