// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import type { AccessRepository, Repositories, UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import type { CustomerDomain, DomainRepository } from "@anhourmail/core/domains";
import type { Mailbox, MailboxRepository } from "@anhourmail/core/mailboxes";
import type {
  AliasState,
  DomainState,
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
import type { PlanId } from "@anhourmail/shared/plans";
import type { AccountRole, PlatformRole } from "@anhourmail/shared/rbac";

/**
 * In-memory adapter for unit tests (ADR-0008). Same contract as Postgres (src/contract): `run` is atomic —
 * a throw restores the state from before the call — and runs are serialised like transactions.
 */
export type MemoryState = {
  audit: AuditEntry[];
  platformRoles: { userId: string; role: PlatformRole }[];
  memberships: { userId: string; accountId: string; role: AccountRole }[];
  suspended: string[];
  accounts: { id: string; name: string; plan: PlanId; status?: string }[];
  userStates: Record<string, string>;
  jobs: ProvisioningJob[];
  domains: CustomerDomain[];
  mailboxes: (Mailbox & { aliases: AliasState[] })[];
  /** Sign-in emails by user id (memberships reference them). */
  userEmails: Record<string, string>;
};

export const emptyState = (): MemoryState => ({
  audit: [],
  platformRoles: [],
  memberships: [],
  suspended: [],
  accounts: [],
  userStates: {},
  jobs: [],
  domains: [],
  mailboxes: [],
  userEmails: {},
});

const clone = <T>(v: T): T => structuredClone(v);

function repositories(s: MemoryState): Repositories {
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
    members: async (accountId) =>
      s.memberships
        .filter((m) => m.accountId === accountId)
        .map((m) => ({ userId: m.userId, email: s.userEmails[m.userId] ?? m.userId, role: m.role }))
        .sort((a, b) => a.email.localeCompare(b.email)),
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
    // Runs are already serialised in memory: nothing to lock.
    lock: async () => undefined,
    get: async (id) => {
      const a = s.accounts.find((x) => x.id === id);
      return a ? { id: a.id, name: a.name, plan: a.plan, status: a.status ?? "active" } : null;
    },
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
      return d ? clone<DomainState>({ id: d.id, name: d.name, status: d.status, stalwartId: d.stalwartId }) : null;
    },
    getMailbox: async (id) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (!m) return null;
      return clone({
        id: m.id,
        accountId: m.accountId,
        address: m.address,
        quotaBytes: m.quotaBytes,
        status: m.status,
        stalwartId: m.stalwartId,
        aliases: m.aliases,
      });
    },
    markDomain: async (id, update) => {
      const d = s.domains.find((x) => x.id === id);
      if (d)
        Object.assign(d, {
          lastError: update.lastError,
          ...(update.stalwartId ? { stalwartId: update.stalwartId } : {}),
        });
    },
    claimedDomainOwner: async (name) =>
      s.domains.find((d) => d.name === name && d.status !== "pending_dns")?.accountId ?? null,
    deleteDomain: async (id) => {
      s.domains = s.domains.filter((d) => !(d.id === id && d.status === "removing"));
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

  const domains: DomainRepository = {
    listByAccount: async (accountId) =>
      clone(s.domains.filter((d) => d.accountId === accountId).sort((a, b) => a.name.localeCompare(b.name))),
    get: async (accountId, id) => clone(s.domains.find((d) => d.id === id && d.accountId === accountId) ?? null),
    nameTaken: async (name) => s.domains.some((d) => d.name === name && d.status !== "pending_dns"),
    insert: async (d) => {
      if (s.domains.some((x) => x.accountId === d.accountId && x.name === d.name)) throw new Error("duplicate domain");
      s.domains.push(clone(d));
    },
    transition: async (id, from, to) => {
      const d = s.domains.find((x) => x.id === id && x.status === from);
      if (!d) return false;
      if (
        to !== "pending_dns" &&
        s.domains.some((x) => x.id !== id && x.name === d.name && x.status !== "pending_dns")
      ) {
        throw new Error("duplicate claimed domain name"); // mirrors the partial unique index in Postgres
      }
      d.status = to;
      return true;
    },
    deletePending: async (id) => {
      const before = s.domains.length;
      s.domains = s.domains.filter((d) => !(d.id === id && d.status === "pending_dns"));
      return s.domains.length < before;
    },
    addressCount: async (name) =>
      s.mailboxes.filter((m) => m.address.endsWith(`@${name}`)).length +
      s.mailboxes.flatMap((m) => m.aliases).filter((a) => a.address.endsWith(`@${name}`)).length,
    pending: async (since, limit) =>
      clone(
        s.domains
          .filter((d) => d.status === "pending_dns" && d.createdAt >= since)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit),
      ),
  };

  const mailboxes: MailboxRepository = {
    listByAccount: async (accountId) =>
      clone(
        s.mailboxes
          .filter((m) => m.accountId === accountId)
          .sort((a, b) => a.address.localeCompare(b.address))
          .map(({ aliases: _a, ...m }) => m),
      ),
    get: async (accountId, id) => {
      const m = s.mailboxes.find((x) => x.id === id && x.accountId === accountId);
      if (!m) return null;
      const { aliases: _a, ...rest } = m;
      return clone(rest);
    },
    count: async (accountId) => s.mailboxes.filter((m) => m.accountId === accountId).length,
    addressTaken: async (address) =>
      s.mailboxes.some((m) => m.address === address || m.aliases.some((a) => a.address === address)),
    insert: async (m) => {
      if (s.mailboxes.some((x) => x.address === m.address)) throw new Error("duplicate mailbox address");
      s.mailboxes.push({ ...clone(m), aliases: [] });
    },
    setQuota: async (id, quotaBytes) => {
      const m = s.mailboxes.find((x) => x.id === id);
      if (m) m.quotaBytes = quotaBytes;
    },
  };

  return { audit, access, accounts, provisioning, directory, domains, mailboxes };
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
