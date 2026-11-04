// SPDX-License-Identifier: AGPL-3.0-only
import type {
  MailImport,
  MailImportBatch,
  MailImportFolder,
  MailImportPatch,
  NewMailImport,
  TerminalImportStatus,
} from "./entity";

/**
 * Mail imports (ADR-0030 §12): the `mail_import`, `mail_import_folder` and `mail_import_batch` tables. Reads for
 * people are scoped to an account; the runner's reads aren't (it claims across accounts). Conditional writes return
 * whether they changed anything. Memory and Postgres share the contract tests (`src/contract`).
 */
export type MailImportRepository = {
  /**
   * Records a new import (`queued`). `import_running` when the mailbox already has one that isn't terminal (the unique
   * partial index; nothing is written).
   */
  insert(row: NewMailImport): Promise<"ok" | "import_running">;
  /** One of the account's imports, or null (another account's id is null too). */
  get(accountId: string, id: string): Promise<MailImport | null>;
  /** Any import by id (runner, jobs). */
  getById(id: string): Promise<MailImport | null>;
  /** The account's imports, newest first, only into `mailboxIds` when given; at most `limit`. */
  list(accountId: string, filter: { mailboxIds: readonly string[] | null; limit: number }): Promise<MailImport[]>;
  /** The mailbox's import that isn't terminal, or null. */
  activeForMailbox(mailboxId: string): Promise<MailImport | null>;
  /** Changes a live import; null (nothing changed) when it is unknown or already terminal. */
  update(id: string, patch: MailImportPatch): Promise<MailImport | null>;
  /**
   * Makes a live import terminal and wipes it in the same write: both sealed secrets and the source username set to
   * null, the source host cut to its registrable domain (`finishedSourceHost`), `credentials_wiped_at` and `finished_at` set to `at`, the lease cleared, and every folder's sealed path
   * nulled (finished history keeps roles and counts only). Returns the row after, or null when it was unknown or
   * already terminal (so the caller writes its audit row and queues the revoke exactly once).
   */
  end(
    id: string,
    end: { status: TerminalImportStatus; at: Date; errorCode?: string | null },
  ): Promise<MailImport | null>;
  /**
   * Terminal imports that still hold a secret or a folder path (a belt-and-braces check; `end` never leaves one):
   * wipes them and returns their ids, at most `limit`.
   */
  wipeLeftovers(at: Date, limit: number): Promise<string[]>;

  /**
   * The runner's claim: the oldest due import (`queued`, `running` or `syncing`, `run_after <= at`, no live lease),
   * skipping any other runner's row, while fewer than `perAccount` imports of its account and fewer than `global`
   * overall hold a live lease (checked under one lock, so two runners can't both take the last slot). Sets a fresh
   * lease (`token`, `at + leaseMs`); a `queued` import becomes `running` with `started_at`. Null when nothing is due.
   */
  claim(
    at: Date,
    opts: { token: string; leaseMs: number; perAccount: number; global: number },
  ): Promise<MailImport | null>;
  /** Extends the lease; false when the token is no longer the import's (lost lease, ended, cancelled). */
  renewLease(id: string, token: string, until: Date): Promise<boolean>;
  /** A runner's progress write, only while it holds the lease (and the import is live). */
  progress(id: string, token: string, patch: MailImportPatch): Promise<boolean>;
  /** Gives the lease back with the next state; false when the token is no longer the import's. */
  release(id: string, token: string, patch: MailImportPatch): Promise<boolean>;

  /** The import's folders, in the order they were recorded. */
  folders(importId: string): Promise<MailImportFolder[]>;
  /**
   * Inserts or replaces one folder's row (by id). With a token, only while that lease holds; without one (services),
   * only while the import is live. False when nothing was written.
   */
  saveFolder(folder: MailImportFolder, token: string | null): Promise<boolean>;

  insertBatch(batch: MailImportBatch): Promise<void>;
  getBatch(accountId: string, id: string): Promise<MailImportBatch | null>;
  /** The batch's imports (oldest first), scoped to the account. */
  listBatch(accountId: string, batchId: string): Promise<MailImport[]>;

  /** Live `paused` or `blocked` imports whose destination credential expires at or before `at` (oldest first). */
  pastCredential(at: Date, limit: number): Promise<MailImport[]>;
  /** `syncing` imports whose sync window ended at or before `at` (oldest first). */
  pastSyncWindow(at: Date, limit: number): Promise<MailImport[]>;

  /** Terminal imports nobody has been told about yet, oldest first. */
  unnotified(limit: number): Promise<MailImport[]>;
  markNotified(id: string, at: Date): Promise<boolean>;
};
