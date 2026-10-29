// SPDX-License-Identifier: AGPL-3.0-only
import { ConflictError } from "@anhourmail/core";
import type { AccountDeletion, DataExport, DataLifecycleRepository } from "@anhourmail/core/data";

import type { MemoryState } from ".";

/** A stored export (Postgres: `data_export`, the archive in the same row). */
export type MemoryExportRow = DataExport & { archive: Uint8Array | null };

const clone = <T>(v: T): T => structuredClone(v);
/** The record without `key` (like a row going with its foreign key). */
const without = <T>(r: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));
const view = ({ archive: _archive, ...e }: MemoryExportRow): DataExport => clone(e);

/**
 * In-memory data exports and account deletion (ADR-0025); same contract as Postgres (src/contract). Deleting an account
 * or a login removes what Postgres would cascade.
 */
export function memoryDataLifecycle(s: MemoryState): DataLifecycleRepository {
  const deleteAccountRows = (accountId: string) => {
    const mailboxIds = new Set(s.mailboxes.filter((m) => m.accountId === accountId).map((m) => m.id));
    s.accounts = s.accounts.filter((a) => a.id !== accountId);
    s.memberships = s.memberships.filter((m) => m.accountId !== accountId);
    s.invites = s.invites.filter((i) => i.accountId !== accountId);
    s.inviteSends = s.inviteSends.filter((i) => i.accountId !== accountId);
    s.domains = s.domains.filter((d) => d.accountId !== accountId);
    s.mailboxes = s.mailboxes.filter((m) => m.accountId !== accountId);
    s.aliases = s.aliases.filter((a) => a.accountId !== accountId);
    s.aliasCreations = s.aliasCreations.filter((a) => a.accountId !== accountId);
    s.appPasswords = s.appPasswords.filter((a) => a.accountId !== accountId);
    s.mailboxHolds = s.mailboxHolds.filter((h) => !mailboxIds.has(h.mailboxId));
    s.dataExports = s.dataExports.filter((e) => e.accountId !== accountId);
    s.accountDeletions = s.accountDeletions.filter((d) => d.accountId !== accountId);
    s.actAsSessions = s.actAsSessions.filter((a) => a.accountId !== accountId);
    s.accountSuspensions = without(s.accountSuspensions, accountId);
  };

  return {
    insertExport: async (e) => {
      s.dataExports.push({ ...clone(e), archive: null });
    },
    getExport: async (id) => {
      const e = s.dataExports.find((x) => x.id === id);
      return e ? view(e) : null;
    },
    listExports: async (requestedBy, kind, accountId, limit) =>
      s.dataExports
        .filter((e) => e.requestedBy === requestedBy && e.kind === kind && e.accountId === accountId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map(view),
    claimExport: async (now, staleBefore) => {
      const e = s.dataExports
        .filter(
          (x) =>
            x.status === "queued" || (x.status === "building" && x.startedAt !== null && x.startedAt < staleBefore),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      if (!e) return null;
      e.status = "building";
      e.startedAt = new Date(now);
      e.attempts += 1;
      e.error = null;
      return view(e);
    },
    storeArchive: async (id, startedAt, sealed, readyAt, expiresAt) => {
      const e = s.dataExports.find((x) => x.id === id);
      if (e?.status !== "building" || e.startedAt?.getTime() !== startedAt.getTime()) return false;
      Object.assign(e, {
        status: "ready",
        archive: new Uint8Array(sealed),
        sizeBytes: sealed.byteLength,
        readyAt: new Date(readyAt),
        expiresAt: new Date(expiresAt),
        error: null,
      });
      return true;
    },
    failExport: async (id, startedAt, error, giveUp) => {
      const e = s.dataExports.find((x) => x.id === id);
      if (e?.status !== "building" || e.startedAt?.getTime() !== startedAt.getTime()) return false;
      e.status = giveUp ? "failed" : "queued";
      e.error = error.slice(0, 100);
      return true;
    },
    markDownloaded: async (id, at) => {
      const e = s.dataExports.find((x) => x.id === id);
      if (e) e.downloadedAt = new Date(at);
    },
    archive: async (id) => {
      const e = s.dataExports.find((x) => x.id === id);
      return e?.status === "ready" && e.archive ? new Uint8Array(e.archive) : null;
    },
    anyExpired: async (now) =>
      s.dataExports.some((e) => e.status === "ready" && e.expiresAt !== null && e.expiresAt <= now),
    expireExports: async (now, limit) => {
      const due = s.dataExports
        .filter((e) => e.status === "ready" && e.expiresAt !== null && e.expiresAt <= now)
        .slice(0, limit);
      for (const e of due) {
        e.status = "expired";
        e.archive = null;
      }
      return due.map(view);
    },

    getDeletion: async (accountId) => clone(s.accountDeletions.find((d) => d.accountId === accountId) ?? null),
    scheduleDeletion: async (d: AccountDeletion) => {
      if (!s.accounts.some((a) => a.id === d.accountId)) throw new Error(`no account ${d.accountId}`);
      if (s.accountDeletions.some((x) => x.accountId === d.accountId)) {
        throw new ConflictError("This account is already scheduled for deletion.");
      }
      s.accountDeletions.push(clone(d));
    },
    cancelDeletion: async (accountId) => {
      const before = s.accountDeletions.length;
      s.accountDeletions = s.accountDeletions.filter((d) => !(d.accountId === accountId && d.startedAt === null));
      return s.accountDeletions.length < before;
    },
    startDeletion: async (accountId, at) => {
      const d = s.accountDeletions.find((x) => x.accountId === accountId);
      if (d?.startedAt !== null || d.deleteAfter > at) return false;
      d.startedAt = new Date(at);
      return true;
    },
    dueDeletions: async (now, limit) =>
      clone(
        s.accountDeletions
          .filter((d) => d.deleteAfter <= now)
          .sort((a, b) => a.deleteAfter.getTime() - b.deleteAfter.getTime())
          .slice(0, limit),
      ),
    pendingDeletions: async () =>
      s.accountDeletions
        .flatMap((d) => {
          const a = s.accounts.find((x) => x.id === d.accountId);
          return a ? [{ ...clone(d), accountName: a.name }] : [];
        })
        .sort((a, b) => a.deleteAfter.getTime() - b.deleteAfter.getTime()),
    deletingAccountsOf: async (userId) =>
      s.accountDeletions
        .filter((d) => s.memberships.some((m) => m.accountId === d.accountId && m.userId === userId))
        .map((d) => d.accountId),
    deleteAccount: async (accountId) => {
      if (!s.accounts.some((a) => a.id === accountId)) return false;
      deleteAccountRows(accountId);
      return true;
    },

    person: async (userId) => {
      const email = s.userEmails[userId];
      if (email === undefined) return null;
      const name = s.userNames[userId] ?? email;
      return {
        id: userId,
        email,
        name,
        firstName: name.split(" ")[0] ?? name,
        lastName: null,
        emailVerified: !s.unverifiedEmails.includes(userId),
        createdAt: new Date(0),
      };
    },
    accountCreatedAt: async (accountId) => {
      const a = s.accounts.find((x) => x.id === accountId);
      return a ? new Date(a.createdAt ?? 0) : null;
    },
    // Units of work run one at a time here, so the lock has nothing to wait for.
    lockLogin: async () => undefined,
    deleteLogin: async (userId) => {
      if (s.userEmails[userId] === undefined) return false;
      s.userEmails = without(s.userEmails, userId);
      s.userNames = without(s.userNames, userId);
      s.profiles = without(s.profiles, userId);
      s.userStates = without(s.userStates, userId);
      s.personSuspensions = without(s.personSuspensions, userId);
      s.memberships = s.memberships.filter((m) => m.userId !== userId);
      s.platformRoles = s.platformRoles.filter((r) => r.userId !== userId);
      s.sessions = s.sessions.filter((x) => x.userId !== userId);
      s.passkeys = s.passkeys.filter((x) => x.userId !== userId);
      s.twoFactor = s.twoFactor.filter((x) => x.userId !== userId);
      s.trustedDevices = s.trustedDevices.filter((x) => x.userId !== userId);
      s.stepUps = s.stepUps.filter((x) => x.userId !== userId);
      s.logins = s.logins.filter((x) => x.userId !== userId);
      s.suspended = s.suspended.filter((x) => x !== userId);
      s.unverifiedEmails = s.unverifiedEmails.filter((x) => x !== userId);
      s.mustChangePassword = s.mustChangePassword.filter((x) => x !== userId);
      s.avatars = s.avatars.filter((a) => !(a.owner.kind === "person" && a.owner.id === userId));
      s.dataExports = s.dataExports.filter((e) => e.requestedBy !== userId);
      for (const m of s.mailboxes) if (m.userId === userId) m.userId = null; // ON DELETE SET NULL
      return true;
    },
  };
}
