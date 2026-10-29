// SPDX-License-Identifier: AGPL-3.0-only
import type { DataExportKind } from "@anhourmail/shared/data-lifecycle";

import type { AccountDeletion, DataExport, ExportFile, PersonRecord } from "./entity";

/**
 * Data exports and account deletion (ADR-0025): the `data_export` and `account_deletion` tables, plus the few reads and
 * deletes they need that no other port has. Conditional writes return whether they changed anything.
 */
export type DataLifecycleRepository = {
  insertExport(e: DataExport): Promise<void>;
  getExport(id: string): Promise<DataExport | null>;
  /** The person's exports of this kind (and account), newest first, at most `limit`. */
  listExports(
    requestedBy: string,
    kind: DataExportKind,
    accountId: string | null,
    limit: number,
  ): Promise<DataExport[]>;
  /**
   * Takes the oldest export waiting to be built — `queued`, or `building` but started before `staleBefore` (a crashed
   * build) — and marks it `building` with `startedAt = now` and one more attempt. Two workers never get the same one.
   */
  claimExport(now: Date, staleBefore: Date): Promise<DataExport | null>;
  /** `building` → `ready` with the sealed archive. Conditional on still building since `startedAt` (this claim). */
  storeArchive(id: string, startedAt: Date, sealed: Uint8Array, readyAt: Date, expiresAt: Date): Promise<boolean>;
  /** A build failed: back to `queued`, or `failed` when `giveUp`. Conditional on this claim (`startedAt`). */
  failExport(id: string, startedAt: Date, error: string, giveUp: boolean): Promise<boolean>;
  markDownloaded(id: string, at: Date): Promise<void>;
  /** The sealed archive of a `ready` export, else null. */
  archive(id: string): Promise<Uint8Array | null>;
  /** Whether any `ready` export is past `expiresAt` (a cheap check before `expireExports`). */
  anyExpired(now: Date): Promise<boolean>;
  /** `ready` exports past `expiresAt` → `expired`, their archives deleted; returns them (at most `limit`). */
  expireExports(now: Date, limit: number): Promise<DataExport[]>;

  getDeletion(accountId: string): Promise<AccountDeletion | null>;
  /** Throws `ConflictError` when the account already has one. */
  scheduleDeletion(d: AccountDeletion): Promise<void>;
  /** Removes a deletion that hasn't started. */
  cancelDeletion(accountId: string): Promise<boolean>;
  /** Marks it started (conditional: not started yet). */
  startDeletion(accountId: string, at: Date): Promise<boolean>;
  /** Deletions whose grace period ended at `now` (started ones included, until the account is gone), oldest first. */
  dueDeletions(now: Date, limit: number): Promise<AccountDeletion[]>;
  /** Every account waiting to be deleted, soonest first, with its name (staff view). */
  pendingDeletions(): Promise<(AccountDeletion & { accountName: string })[]>;
  /** The person's accounts that are waiting to be deleted (for the actor's `deletingAccountIds`). */
  deletingAccountsOf(userId: string): Promise<string[]>;
  /**
   * Deletes the account row; everything it owns in the control plane goes with it (memberships, invites, exports, its
   * deletion record). Its audit log stays (append-only, rule 47). Call only once nothing is left on the mail server.
   */
  deleteAccount(accountId: string): Promise<boolean>;

  /** A console login, or null. */
  person(userId: string): Promise<PersonRecord | null>;
  /** When the account was created, or null for an unknown one. */
  accountCreatedAt(accountId: string): Promise<Date | null>;
  /**
   * Locks the login row until the unit of work ends (`FOR UPDATE`): anything adding a membership for this person (an
   * invite accepted, a sign-up's own account) waits, then fails once the login is gone, so no account is left without
   * its person.
   */
  lockLogin(userId: string): Promise<void>;
  /** Deletes a console login and everything that hangs off it (sessions, factors, profile, photo, exports). */
  deleteLogin(userId: string): Promise<boolean>;
};

/**
 * Packs export files into an archive and seals it (adapter: ZIP + the key ring, AES-256-GCM bound to the export id), and
 * opens one again for its download. Plaintext archives never reach the database.
 */
export type ExportArchiver = {
  pack(exportId: string, files: readonly ExportFile[], at: Date): Promise<Uint8Array>;
  /** The ZIP bytes; throws when the archive doesn't belong to this export or was tampered with. */
  open(exportId: string, sealed: Uint8Array): Promise<Uint8Array>;
};
