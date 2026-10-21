// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import type { AccessRepository, Repositories, UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import {
  type AuditEntry,
  type AuditEntryInput,
  type AuditQuery,
  type AuditRepository,
  GENESIS_HASH,
  hashEntry,
} from "@anhourmail/core/audit";
import type { WaitlistEntry, WaitlistRepository } from "@anhourmail/core/waitlist";
import type { AccountRole, PlatformRole } from "@anhourmail/shared/rbac";

/**
 * In-memory adapter for unit tests (ADR-0008). Same contract as Postgres (src/contract): `run` is atomic —
 * a throw restores the state from before the call — and runs are serialised like transactions.
 */
export type MemoryState = {
  waitlist: WaitlistEntry[];
  audit: AuditEntry[];
  platformRoles: { userId: string; role: PlatformRole }[];
  memberships: { userId: string; accountId: string; role: AccountRole }[];
  suspended: string[];
  accounts: { id: string; name: string; plan?: string }[];
  userStates: Record<string, string>;
};

export const emptyState = (): MemoryState => ({
  waitlist: [],
  audit: [],
  platformRoles: [],
  memberships: [],
  suspended: [],
  accounts: [],
  userStates: {},
});

const clone = <T>(v: T): T => structuredClone(v);

function repositories(s: MemoryState): Repositories {
  const waitlist: WaitlistRepository = {
    findByEmailHash: async (h) => clone(s.waitlist.find((e) => e.emailHash === h) ?? null),
    insert: async (e) => {
      if (s.waitlist.some((x) => x.emailHash === e.emailHash)) throw new Error("duplicate email_hash");
      s.waitlist.push(clone(e));
    },
    list: async ({ limit, before }) =>
      clone(
        s.waitlist
          .filter((e) => !before || e.createdAt < before)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
          .slice(0, limit),
      ),
    count: async () => s.waitlist.length,
  };

  const audit: AuditRepository = {
    append: async (input: AuditEntryInput, at: Date) => {
      const last = s.audit.filter((e) => e.scope === input.scope).at(-1);
      const unsigned: Omit<AuditEntry, "hash"> = {
        ...clone(input),
        id: randomUUID(),
        at: at.toISOString(),
        seq: (last?.seq ?? 0) + 1,
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const entry = { ...unsigned, hash: hashEntry(unsigned) };
      s.audit.push(entry);
      return clone(entry);
    },
    list: async (q: AuditQuery) =>
      clone(
        s.audit
          .filter(
            (e) =>
              e.scope === q.scope &&
              (!q.action || e.action === q.action) &&
              (!q.actorUserId || e.actor.userId === q.actorUserId) &&
              (!q.targetId || e.target.id === q.targetId) &&
              (!q.from || new Date(e.at) >= q.from) &&
              (!q.to || new Date(e.at) <= q.to) &&
              (q.beforeSeq === undefined || e.seq < q.beforeSeq),
          )
          .sort((a, b) => b.seq - a.seq)
          .slice(0, q.limit),
      ),
    chain: async (scope) => clone(s.audit.filter((e) => e.scope === scope).sort((a, b) => a.seq - b.seq)),
  };

  const access: AccessRepository = {
    platformRoles: async (userId) => s.platformRoles.filter((r) => r.userId === userId).map((r) => r.role),
    memberships: async (userId) =>
      s.memberships.filter((m) => m.userId === userId).map(({ accountId, role }) => ({ accountId, role })),
    isSuspended: async (userId) => s.suspended.includes(userId),
    accountNames: async (ids) =>
      Object.fromEntries(s.accounts.filter((a) => ids.includes(a.id)).map((a) => [a.id, a.name] as const)),
  };

  const accounts: AccountRepository = {
    create: async ({ name, plan }) => {
      const id = randomUUID();
      s.accounts.push({ id, name, plan });
      return { id };
    },
    addMember: async ({ accountId, userId, role }) => {
      if (s.memberships.some((m) => m.accountId === accountId && m.userId === userId)) {
        throw new Error("duplicate membership");
      }
      s.memberships.push({ accountId, userId, role });
    },
    setUserState: async ({ userId, state }) => {
      s.userStates[userId] = state;
    },
    membershipCount: async (userId) => s.memberships.filter((m) => m.userId === userId).length,
  };

  return { waitlist, audit, access, accounts };
}

export class MemoryUnitOfWork implements UnitOfWork {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly state: MemoryState = emptyState()) {}

  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => {
      const snapshot = clone(this.state);
      try {
        return await fn(repositories(this.state));
      } catch (err) {
        Object.assign(this.state, snapshot);
        throw err;
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
