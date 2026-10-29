// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Data export and account deletion facts (ADR-0025). One source for the console, the worker, the emails and the public
 * docs (`<Value of="accountDeletionGraceDays" />`, `<Value of="dataExportKeepDays" />`).
 */

/**
 * Days between an Owner asking to delete an account and its permanent removal. Its mailboxes are suspended at once (mail
 * kept); the Owner can cancel until then, and nothing is removed before it ends.
 */
export const ACCOUNT_DELETION_GRACE_DAYS = 14;

/** Data export archives (control-plane data only; mail is exported from the webmail and never stored by us). */
export const DATA_EXPORT = {
  /** Days a finished archive can be downloaded; then it is deleted. */
  keepDays: 7,
  /** Most recent audit entries put in one archive (older ones stay readable in the console). */
  maxAuditEntries: 100_000,
  /** Builds tried before an export is marked failed. */
  maxAttempts: 3,
  /** A build left running this long (crashed worker) is taken over by the next run. */
  staleBuildMinutes: 15,
} as const;

/** Mail export from the webmail: an `.mbox` file inside the archive is split into parts at this size. */
export const MAIL_EXPORT_PART_BYTES = 1024 ** 3;

export type DataExportKind = "account" | "personal";

/**
 * `queued` → `building` (the worker) → `ready` (downloadable until `expiresAt`) → `expired` (archive deleted).
 * `failed` after `DATA_EXPORT.maxAttempts`.
 */
export type DataExportStatus = "queued" | "building" | "ready" | "failed" | "expired";

export const DATA_EXPORT_STATUSES: readonly DataExportStatus[] = ["queued", "building", "ready", "failed", "expired"];
