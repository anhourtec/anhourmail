// SPDX-License-Identifier: AGPL-3.0-only
import {
  finishedSourceHost,
  type MailImport,
  type MailImportBatch,
  type MailImportFolder,
  type MailImportPatch,
  type MailImportRepository,
  type NewMailImport,
  type TerminalImportStatus,
} from "@anhourmail/core/imports";
import { IMPORT_TERMINAL_STATUSES, isTerminalImportStatus } from "@anhourmail/shared/import";

/** What the import repository reads from the rest of the in-memory state. */
type State = {
  mailImports: MailImport[];
  mailImportFolders: (MailImportFolder & { createdAt: Date })[];
  mailImportBatches: MailImportBatch[];
  mailboxes: { id: string; accountId: string }[];
  accounts: { id: string }[];
};

const clone = <T>(v: T): T => structuredClone(v);
const TERMINAL = IMPORT_TERMINAL_STATUSES as readonly string[];

/**
 * In-memory mail imports (ADR-0030 §12); same contract as Postgres (src/contract). Rows go with their mailbox and
 * account like the foreign keys' cascades: an import whose mailbox or account is gone is no longer seen (and its
 * folders with it), so the deletion paths elsewhere in the memory adapter need no change.
 */
export function memoryMailImports(s: State): MailImportRepository {
  const exists = (i: MailImport) =>
    s.mailboxes.some((m) => m.id === i.mailboxId) && s.accounts.some((a) => a.id === i.accountId);
  const rows = () => s.mailImports.filter(exists);
  const isLive = (i: MailImport) => !isTerminalImportStatus(i.status);
  const find = (id: string) => rows().find((i) => i.id === id);
  const newestFirst = (list: MailImport[]) =>
    [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  const oldestFirst = (list: MailImport[]) =>
    [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const leased = (i: MailImport, at: Date) => i.leaseUntil !== null && i.leaseUntil.getTime() > at.getTime();
  const apply = (i: MailImport, patch: MailImportPatch) => {
    if (patch.status !== undefined && TERMINAL.includes(patch.status)) throw new Error("use end() to finish an import");
    Object.assign(i, clone(patch));
  };
  const wipe = (i: MailImport, at: Date) => {
    i.sourceHost = finishedSourceHost(i.sourceHost);
    i.sourceSecret = null;
    i.destinationSecret = null;
    i.sourceUsername = null;
    i.credentialsWipedAt ??= at;
    for (const f of s.mailImportFolders) if (f.importId === i.id) f.sourcePath = null;
  };

  return {
    insert: async (row: NewMailImport) => {
      if (rows().some((i) => i.mailboxId === row.mailboxId && isLive(i))) return "import_running";
      if (s.mailImports.some((i) => i.id === row.id)) return "import_running";
      if (!s.mailboxes.some((m) => m.id === row.mailboxId && m.accountId === row.accountId)) {
        throw new Error(`no mailbox ${row.mailboxId} in account ${row.accountId}`);
      }
      s.mailImports.push({
        ...clone(row),
        status: "queued",
        phase: null,
        blockedReason: null,
        errorCode: null,
        pauseRequested: false,
        foldersTotal: 0,
        messagesTotal: 0,
        bytesTotal: 0,
        messagesDone: 0,
        bytesDone: 0,
        duplicates: 0,
        tooLarge: 0,
        failed: 0,
        leaseToken: null,
        leaseUntil: null,
        attempts: 0,
        lastPassAt: null,
        startedAt: null,
        finishedAt: null,
        credentialsWipedAt: null,
        notifiedAt: null,
      });
      return "ok";
    },
    get: async (accountId, id) => clone(rows().find((i) => i.accountId === accountId && i.id === id) ?? null),
    getById: async (id) => clone(find(id) ?? null),
    list: async (accountId, filter) =>
      clone(
        newestFirst(
          rows().filter(
            (i) => i.accountId === accountId && (filter.mailboxIds === null || filter.mailboxIds.includes(i.mailboxId)),
          ),
        ).slice(0, filter.limit),
      ),
    activeForMailbox: async (mailboxId) => clone(rows().find((i) => i.mailboxId === mailboxId && isLive(i)) ?? null),
    update: async (id, patch) => {
      const i = find(id);
      if (!i || !isLive(i)) return null;
      apply(i, patch);
      return clone(i);
    },
    end: async (id, end: { status: TerminalImportStatus; at: Date; errorCode?: string | null }) => {
      const i = find(id);
      if (!i || !isLive(i) || !TERMINAL.includes(end.status)) return null;
      i.status = end.status;
      if (end.errorCode !== undefined) i.errorCode = end.errorCode;
      i.finishedAt = end.at;
      i.credentialsWipedAt = end.at;
      i.leaseToken = null;
      i.leaseUntil = null;
      i.pauseRequested = false;
      wipe(i, end.at);
      return clone(i);
    },
    wipeLeftovers: async (at, limit) => {
      const left = oldestFirst(
        rows().filter(
          (i) =>
            !isLive(i) &&
            (i.sourceSecret !== null ||
              i.destinationSecret !== null ||
              i.sourceUsername !== null ||
              s.mailImportFolders.some((f) => f.importId === i.id && f.sourcePath !== null)),
        ),
      ).slice(0, limit);
      for (const i of left) wipe(i, at);
      return left.map((i) => i.id);
    },
    claim: async (at, opts) => {
      const all = rows();
      if (all.filter((i) => isLive(i) && leased(i, at)).length >= opts.global) return null;
      const busy = (accountId: string) =>
        all.filter((i) => i.accountId === accountId && isLive(i) && leased(i, at)).length >= opts.perAccount;
      const due = all
        .filter(
          (i) =>
            (i.status === "queued" || i.status === "running" || i.status === "syncing") &&
            i.runAfter.getTime() <= at.getTime() &&
            !leased(i, at) &&
            !busy(i.accountId),
        )
        .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
      const i = due[0];
      if (!i) return null;
      i.leaseToken = opts.token;
      i.leaseUntil = new Date(at.getTime() + opts.leaseMs);
      if (i.status === "queued") i.status = "running";
      i.startedAt ??= at;
      return clone(i);
    },
    renewLease: async (id, token, until) => {
      const i = find(id);
      if (!i || !isLive(i) || i.leaseToken !== token) return false;
      i.leaseUntil = until;
      return true;
    },
    progress: async (id, token, patch) => {
      const i = find(id);
      if (!i || !isLive(i) || i.leaseToken !== token) return false;
      apply(i, patch);
      return true;
    },
    release: async (id, token, patch) => {
      const i = find(id);
      if (!i || !isLive(i) || i.leaseToken !== token) return false;
      apply(i, patch);
      i.leaseToken = null;
      i.leaseUntil = null;
      return true;
    },
    // Insertion order (Postgres: `created_at`, each folder recorded in its own write).
    folders: async (importId) =>
      find(importId)
        ? clone(s.mailImportFolders.filter((f) => f.importId === importId).map(({ createdAt: _created, ...f }) => f))
        : [],
    saveFolder: async (folder, token) => {
      const i = find(folder.importId);
      if (!i || !isLive(i) || (token !== null && i.leaseToken !== token)) return false;
      const at = s.mailImportFolders.findIndex((f) => f.id === folder.id);
      const current = s.mailImportFolders[at];
      if (current) {
        if (current.importId !== folder.importId) return false;
        s.mailImportFolders[at] = { ...clone(folder), createdAt: current.createdAt };
      } else {
        s.mailImportFolders.push({ ...clone(folder), createdAt: new Date(folder.updatedAt) });
      }
      return true;
    },
    insertBatch: async (batch) => {
      if (!s.accounts.some((a) => a.id === batch.accountId)) throw new Error(`no account ${batch.accountId}`);
      s.mailImportBatches.push(clone(batch));
    },
    getBatch: async (accountId, id) =>
      clone(
        s.mailImportBatches.find(
          (b) => b.accountId === accountId && b.id === id && s.accounts.some((a) => a.id === accountId),
        ) ?? null,
      ),
    listBatch: async (accountId, batchId) =>
      clone(oldestFirst(rows().filter((i) => i.accountId === accountId && i.batchId === batchId))),
    pastCredential: async (at, limit) =>
      clone(
        rows()
          .filter(
            (i) =>
              (i.status === "paused" || i.status === "blocked") &&
              i.destinationCredentialExpiresAt !== null &&
              i.destinationCredentialExpiresAt.getTime() <= at.getTime(),
          )
          .sort(
            (a, b) =>
              (a.destinationCredentialExpiresAt?.getTime() ?? 0) - (b.destinationCredentialExpiresAt?.getTime() ?? 0) ||
              a.id.localeCompare(b.id),
          )
          .slice(0, limit),
      ),
    pastSyncWindow: async (at, limit) =>
      clone(
        rows()
          .filter((i) => i.status === "syncing" && i.syncUntil !== null && i.syncUntil.getTime() <= at.getTime())
          .sort((a, b) => (a.syncUntil?.getTime() ?? 0) - (b.syncUntil?.getTime() ?? 0) || a.id.localeCompare(b.id))
          .slice(0, limit),
      ),
    unnotified: async (limit) =>
      clone(
        rows()
          .filter((i) => !isLive(i) && i.notifiedAt === null)
          .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))
          .slice(0, limit),
      ),
    markNotified: async (id, at) => {
      const i = find(id);
      if (!i || isLive(i) || i.notifiedAt !== null) return false;
      i.notifiedAt = at;
      return true;
    },
  };
}
