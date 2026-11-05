// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The summary email when an import ends (ADR-0030 §16, `job:import-notify`): to the person who started it and, for an
 * admin-started import, the mailbox's person. Counts per folder role only ("Inbox 1,204 copied, 3 duplicates
 * skipped"), custom folders as one line, too-large and failed counts and how long it took — never folder names,
 * subjects or addresses from the mail (rule 24). Each import is claimed (`notified_at`) before its emails go out, so two
 * runs never send one twice; a send that fails is logged and not retried (the console shows the result either way).
 * Cancelled imports are claimed without an email: the person (or the mailbox change that cancelled it) already knows.
 */
import { IMPORT_FOLDER_ROLES, type ImportFolderRole } from "@anhourmail/shared/import";

import type { Deps } from "../ports";

export type ImportRoleCounts = {
  role: ImportFolderRole | "custom";
  copied: number;
  duplicates: number;
  tooLarge: number;
  failed: number;
};

/** One email to send: who gets it and what it says (metadata only). */
export type ImportSummary = {
  to: string;
  accountId: string;
  importId: string;
  address: string;
  /** The recipient started it; false: an admin (`startedBy`) started it into the recipient's mailbox. */
  startedByRecipient: boolean;
  startedBy: string | null;
  status: "completed" | "failed";
  errorCode: string | null;
  roles: ImportRoleCounts[];
  totals: { copied: number; duplicates: number; tooLarge: number; failed: number };
  startedAt: Date | null;
  finishedAt: Date | null;
};

/** How many ended imports one run handles (the rest wait for the next minute). */
export const IMPORT_NOTIFY_BATCH = 20;

const ORDER: (ImportFolderRole | "custom")[] = [...IMPORT_FOLDER_ROLES, "custom"];

/**
 * Claims up to `limit` ended imports nobody has been told about and returns the emails to send for them. A cancelled
 * one is claimed with nothing to send.
 */
export async function claimImportSummaries(
  deps: Deps,
  limit = IMPORT_NOTIFY_BATCH,
): Promise<{ claimed: number; summaries: ImportSummary[] }> {
  const pending = await deps.uow.run((r) => r.imports.unnotified(limit));
  const summaries: ImportSummary[] = [];
  let claimed = 0;
  for (const i of pending) {
    const out = await deps.uow.run(async (r) => {
      if (!(await r.imports.markNotified(i.id, deps.clock.now()))) return null;
      if (i.status !== "completed" && i.status !== "failed") return [];
      const mailbox = await r.mailboxes.get(i.accountId, i.mailboxId);
      if (!mailbox) return [];
      const members = await r.access.members(i.accountId);
      const email = (userId: string | null) =>
        userId === null ? undefined : members.find((m) => m.userId === userId)?.email;
      const counts = new Map<ImportFolderRole | "custom", ImportRoleCounts>();
      for (const f of await r.imports.folders(i.id)) {
        const role = f.role ?? "custom";
        const c = counts.get(role) ?? { role, copied: 0, duplicates: 0, tooLarge: 0, failed: 0 };
        c.copied += f.messagesDone;
        c.duplicates += f.duplicates;
        c.tooLarge += f.tooLarge;
        c.failed += f.failed;
        counts.set(role, c);
      }
      const roles = ORDER.flatMap((r2) => {
        const c = counts.get(r2);
        return c && c.copied + c.duplicates + c.tooLarge + c.failed > 0 ? [c] : [];
      });
      const base = {
        accountId: i.accountId,
        importId: i.id,
        address: mailbox.address,
        status: i.status,
        errorCode: i.errorCode,
        roles,
        totals: {
          copied: i.messagesDone,
          duplicates: i.duplicates,
          tooLarge: i.tooLarge,
          failed: i.failed,
        },
        startedAt: i.startedAt,
        finishedAt: i.finishedAt,
      };
      const starter = email(i.requestedBy);
      const person = mailbox.userId !== i.requestedBy ? email(mailbox.userId) : undefined;
      const list: ImportSummary[] = [];
      if (starter) list.push({ ...base, to: starter, startedByRecipient: true, startedBy: null });
      if (i.requestedAs === "admin" && person && person !== starter) {
        list.push({ ...base, to: person, startedByRecipient: false, startedBy: starter ?? null });
      }
      return list;
    });
    if (out === null) continue;
    claimed += 1;
    summaries.push(...out);
  }
  return { claimed, summaries };
}
