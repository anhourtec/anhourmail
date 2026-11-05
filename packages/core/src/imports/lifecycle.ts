// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditAlso } from "../mutation";
import type { Repositories } from "../ports";
import type { MailImport } from "./entity";

/**
 * The default slice and lease lengths (the importer's `IMPORT_SLICE_MINUTES` / `IMPORT_LEASE_SECONDS`), which bound
 * what a runner can have appended since it last gave the import back: the window of the training-sample clean-up queued
 * when an import is ended under someone else's lease (`endImport`) or claimed after a runner died (the runner).
 */
export const DEFAULT_SLICE_MS = 15 * 60_000;
export const DEFAULT_LEASE_MS = 2 * 60_000;
/** Training-sample clean-ups wait this long after their window (the server writes samples a moment later). */
export const TRAINING_CLEANUP_DELAY_MS = 60_000;

/** Queues a training-sample clean-up for a runner that held `leaseUntil` and may have appended until then. */
export async function queueLeaseCleanup(
  repos: Repositories,
  importId: string,
  leaseUntil: Date,
  at: Date,
  opts: { leaseMs: number; sliceMs: number } = { leaseMs: DEFAULT_LEASE_MS, sliceMs: DEFAULT_SLICE_MS },
): Promise<void> {
  const until = Math.max(leaseUntil.getTime(), at.getTime());
  await repos.provisioning.enqueue({
    kind: "mail_import.training_cleanup",
    subjectId: `${importId}:${String(leaseUntil.getTime() - opts.leaseMs - opts.sliceMs)}:${String(until)}`,
    runAfter: new Date(until + TRAINING_CLEANUP_DELAY_MS),
  });
}

/**
 * Ends a live import (any actor; the caller has checked who may): terminal status, secrets, username and folder names
 * wiped, the destination credential's revoke queued — all in the caller's unit of work. When a runner other than the
 * caller (`ownLease`) held it, a training-sample clean-up is queued for what that runner may have appended: ending
 * clears the lease, and a terminal import is never claimed again, so nothing else would. Returns the ended row, or null
 * when it had already ended.
 */
export async function endImport(
  repos: Repositories,
  importId: string,
  end: { status: "completed" | "cancelled" | "failed"; at: Date; errorCode?: string | null; ownLease?: string },
): Promise<MailImport | null> {
  const before = await repos.imports.getById(importId);
  const { ownLease, ...terminal } = end;
  const ended = await repos.imports.end(importId, terminal);
  if (ended) {
    await repos.provisioning.enqueue({ kind: "mail_import.credential_revoke", subjectId: importId, runAfter: end.at });
    if (before?.leaseUntil && before.leaseToken !== null && before.leaseToken !== ownLease) {
      await queueLeaseCleanup(repos, importId, before.leaseUntil, end.at);
    }
  }
  return ended;
}

/** Why a mailbox change ended its import (audit meta `reason`, ADR-0030 §14). */
export type ImportCancelReason = "mailbox_handover" | "mailbox_released" | "mailbox_suspended" | "mailbox_deleted";

/**
 * Cancels the mailbox's live import inside the caller's unit of work (ADR-0030 §13): "Make this a user", suspending
 * and deleting a mailbox end it at once — `cancelled` with the reason as its error code, secrets wiped, the
 * credential's revoke queued — so nobody keeps writing into a mailbox that changed hands or went away. Returns the
 * `data.import_cancelled` audit entry for the caller's `also` (empty when there was none).
 */
export async function cancelMailboxImport(
  repos: Repositories,
  mailboxId: string,
  reason: ImportCancelReason,
  at: Date,
): Promise<AuditAlso[]> {
  const live = await repos.imports.activeForMailbox(mailboxId);
  if (!live) return [];
  const ended = await endImport(repos, live.id, { status: "cancelled", at, errorCode: reason });
  if (!ended) return [];
  return [
    {
      action: "data.import_cancelled",
      accountId: live.accountId,
      target: { type: "mail_import", id: live.id },
      meta: { importId: live.id, mailboxId, reason, messagesDone: ended.messagesDone },
    },
  ];
}
