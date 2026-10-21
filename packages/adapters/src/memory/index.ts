// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import type { AccessRepository, Repositories, UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import type {
  DomainState,
  MailboxState,
  MailDirectoryRepository,
  ProvisioningJob,
  ProvisioningRepository,
} from "@anhourmail/core/provisioning";
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
  jobs: ProvisioningJob[];
  domains: (DomainState & { lastError: string | null })[];
  mailboxes: (MailboxState & { lastError: string | null })[];
};

export const emptyState = (): MemoryState => ({
  waitlist: [],
  audit: [],
  platformRoles: [],
  memberships: [],
  suspended: [],
  accounts: [],
  userStates: {},
  jobs: [],
  domains: [],
  mailboxes: [],
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

  const provisioning: ProvisioningRepository = {
    enqueue: async ({ kind, subjectId, runAfter }) => {
      const existing = s.jobs.find((j) => j.kind === kind && j.subjectId === subjectId && j.status === "queued");
      if (existing) return clone(existing);
      const job: ProvisioningJob = {
        id: randomUUID(),
        kind,
        subjectId,
        status: "queued",
        attempts: 0,
        lastError: null,
        runAfter,
      };
      s.jobs.push(job);
      return clone(job);
    },
    claimNext: async (now) => {
      const job = s.jobs
        .filter((j) => j.status === "queued" && j.runAfter <= now)
        .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime())[0];
      if (!job) return null;
      job.status = "running";
      job.attempts += 1;
      return clone(job);
    },
    complete: async (id) => {
      const job = s.jobs.find((j) => j.id === id);
      if (job) Object.assign(job, { status: "succeeded", lastError: null });
    },
    retry: async (id, error, runAfter) => {
      const job = s.jobs.find((j) => j.id === id);
      if (job) Object.assign(job, { status: "queued", lastError: error, runAfter });
    },
    giveUp: async (id, error) => {
      const job = s.jobs.find((j) => j.id === id);
      if (job) Object.assign(job, { status: "failed", lastError: error });
    },
    get: async (id) => clone(s.jobs.find((j) => j.id === id) ?? null),
  };

  const directory: MailDirectoryRepository = {
    getDomain: async (id) => {
      const d = s.domains.find((x) => x.id === id);
      return d ? clone({ id: d.id, name: d.name, status: d.status, stalwartId: d.stalwartId }) : null;
    },
    getMailbox: async (id) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (!m) return null;
      const { lastError: _e, ...state } = m;
      return clone(state);
    },
    markDomain: async (id, update) => {
      const d = s.domains.find((x) => x.id === id);
      if (d)
        Object.assign(d, {
          lastError: update.lastError,
          ...(update.stalwartId ? { stalwartId: update.stalwartId } : {}),
        });
    },
    markMailbox: async (id, update) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (m) {
        Object.assign(m, {
          status: update.status,
          lastError: update.lastError,
          ...(update.stalwartId ? { stalwartId: update.stalwartId } : {}),
        });
      }
    },
    desired: async () => ({
      domains: s.domains.filter((d) => d.status === "active").map((d) => d.name),
      mailboxes: s.mailboxes
        .filter((m) => m.status === "active")
        .map((m) => ({ address: m.address, quotaBytes: m.quotaBytes })),
    }),
  };

  return { waitlist, audit, access, accounts, provisioning, directory };
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
