// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import type { AccessRepository, Repositories, UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import type { CustomerDomain, DomainRepository } from "@anhourmail/core/domains";
import type { Invite, InviteRepository } from "@anhourmail/core/invite";
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
import type { PlanId } from "@anhourmail/shared/plans";
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
  accounts: { id: string; name: string; plan: PlanId; status?: string }[];
  userStates: Record<string, string>;
  confirmTokens: Map<string, { hash: string; expiresAt: Date }>;
  invites: (Invite & {
    tokenHash: string;
    status: string;
    acceptedUserId: string | null;
    waitlistEntryId: string | null;
  })[];
  jobs: ProvisioningJob[];
  domains: CustomerDomain[];
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
  confirmTokens: new Map(),
  invites: [],
  jobs: [],
  domains: [],
  mailboxes: [],
});

const clone = <T>(v: T): T => structuredClone(v);

function repositories(s: MemoryState): Repositories {
  const waitlist: WaitlistRepository = {
    get: async (id) => clone(s.waitlist.find((e) => e.id === id) ?? null),
    findByEmailHash: async (h) => clone(s.waitlist.find((e) => e.emailHash === h) ?? null),
    findByConfirmToken: async (hash, now) => {
      const id = [...s.confirmTokens].find(([, t]) => t.hash === hash && t.expiresAt > now)?.[0];
      const entry = s.waitlist.find((e) => e.id === id && e.status === "pending");
      return clone(entry ?? null);
    },
    setConfirmation: async (id, { tokenHash, expiresAt, sentAt }) => {
      s.confirmTokens.set(id, { hash: tokenHash, expiresAt });
      const e = s.waitlist.find((x) => x.id === id);
      if (e) e.confirmSentAt = sentAt;
    },
    markConfirmed: async (id, at) => {
      const e = s.waitlist.find((x) => x.id === id && x.status === "pending");
      if (!e) return false;
      Object.assign(e, { status: "confirmed", confirmedAt: at });
      s.confirmTokens.delete(id);
      return true;
    },
    markInvited: async (id) => {
      const e = s.waitlist.find((x) => x.id === id && x.status === "confirmed");
      if (e) e.status = "invited";
      return Boolean(e);
    },
    insert: async (e) => {
      if (s.waitlist.some((x) => x.emailHash === e.emailHash)) return false;
      s.waitlist.push(clone(e));
      return true;
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

  const invites: InviteRepository = {
    create: async (input) => {
      const id = randomUUID();
      s.invites.push({
        id,
        email: input.email,
        accountId: input.accountId,
        role: input.role,
        source: input.source,
        expiresAt: input.expiresAt,
        tokenHash: input.tokenHash,
        status: "pending",
        acceptedUserId: null,
        waitlistEntryId: input.waitlistEntryId,
      });
      return { id };
    },
    findValid: async (hash, now) => {
      const i = s.invites.find((x) => x.tokenHash === hash && x.status === "pending" && x.expiresAt > now);
      return i
        ? clone({
            id: i.id,
            email: i.email,
            accountId: i.accountId,
            role: i.role,
            source: i.source,
            expiresAt: i.expiresAt,
          })
        : null;
    },
    markAccepted: async (id, userId) => {
      const i = s.invites.find((x) => x.id === id);
      if (i) Object.assign(i, { status: "accepted", acceptedUserId: userId });
    },
  };

  return { waitlist, audit, access, accounts, provisioning, directory, domains, invites };
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
