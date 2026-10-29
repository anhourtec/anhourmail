// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { ConflictError } from "@anhourmail/core";
import {
  ACT_AS_ALREADY_OPEN,
  type ActAsEndReason,
  type ActAsRepository,
  type ActAsSession,
  isCompanyAddress,
} from "@anhourmail/core/platform";
import type { PlatformRole } from "@anhourmail/shared/rbac";

/** A stored act-as session (Postgres: `act_as_session`); the staff email and account name are read at query time. */
export type MemoryActAsRow = Omit<ActAsSession, "staffEmail" | "accountName">;

/** What the act-as repository reads from the rest of the in-memory state. */
type State = {
  actAsSessions: MemoryActAsRow[];
  userEmails: Record<string, string>;
  accounts: { id: string; name: string }[];
  sessions: { id: string; userId: string; expiresAt: Date }[];
  platformRoles: { userId: string; role: PlatformRole }[];
  memberships: { userId: string; accountId: string }[];
};

const clone = <T>(v: T): T => structuredClone(v);

/** In-memory act-as sessions (ADR-0023); same contract as Postgres (src/contract). */
export function memoryActAs(s: State): ActAsRepository {
  const view = (r: MemoryActAsRow): ActAsSession => ({
    ...clone(r),
    staffEmail: s.userEmails[r.staffUserId] ?? "",
    accountName: s.accounts.find((a) => a.id === r.accountId)?.name ?? "",
  });
  const open = (r: MemoryActAsRow, now: Date) => r.endedAt === null && r.expiresAt > now;
  const live = (r: MemoryActAsRow) => s.accounts.some((a) => a.id === r.accountId);
  const staffIn = (accountId: string) =>
    s.memberships.some(
      (m) =>
        m.accountId === accountId &&
        (isCompanyAddress(s.userEmails[m.userId] ?? "") || s.platformRoles.some((p) => p.userId === m.userId)),
    );

  return {
    active: async (staffUserId, authSessionId, now) => {
      const r = s.actAsSessions.find(
        (x) => x.staffUserId === staffUserId && x.authSessionId === authSessionId && open(x, now) && live(x),
      );
      return r ? view(r) : null;
    },
    openFor: async (staffUserId, now) => {
      const r = s.actAsSessions.find((x) => x.staffUserId === staffUserId && open(x, now) && live(x));
      return r ? view(r) : null;
    },
    get: async (id) => {
      const r = s.actAsSessions.find((x) => x.id === id);
      return r ? view(r) : null;
    },
    staffInAccount: async (accountId) => staffIn(accountId),
    create: async (input) => {
      // Like Postgres's partial unique index: one unclosed session per staff member.
      if (s.actAsSessions.some((x) => x.staffUserId === input.staffUserId && x.endedAt === null)) {
        throw new ConflictError(ACT_AS_ALREADY_OPEN);
      }
      const row: MemoryActAsRow = { id: randomUUID(), ...clone(input), endedAt: null, endReason: null };
      s.actAsSessions.push(row);
      return view(row);
    },
    renew: async (id, expiresAt, reason, now) => {
      const r = s.actAsSessions.find((x) => x.id === id);
      if (!r || !open(r, now)) return false;
      r.expiresAt = expiresAt;
      r.reason = reason;
      return true;
    },
    end: async (id, at, reason: ActAsEndReason) => {
      const r = s.actAsSessions.find((x) => x.id === id);
      if (r?.endedAt !== null) return false;
      r.endedAt = at;
      r.endReason = reason;
      return true;
    },
    due: async (now, roles, limit, staffUserId) =>
      s.actAsSessions
        .filter((r) => r.endedAt === null && live(r) && (staffUserId === undefined || r.staffUserId === staffUserId))
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .flatMap((r) => {
          const reason =
            r.expiresAt <= now
              ? ("expired" as const)
              : !s.sessions.some((x) => x.id === r.authSessionId && x.userId === r.staffUserId && x.expiresAt > now)
                ? ("signed_out" as const)
                : !s.platformRoles.some((p) => p.userId === r.staffUserId && roles.includes(p.role))
                  ? ("role_removed" as const)
                  : staffIn(r.accountId)
                    ? ("staff_account" as const)
                    : null;
          return reason ? [{ session: view(r), reason }] : [];
        })
        .slice(0, limit),
  };
}
