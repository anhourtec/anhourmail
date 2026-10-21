// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, inArray, lt, lte, type SQL, sql } from "drizzle-orm";

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
import { ACCOUNT_ROLES, type AccountRole, PLATFORM_ROLES, type PlatformRole } from "@anhourmail/shared/rbac";
import type { Utm } from "@anhourmail/shared/schemas";

import type { Db, Executor } from "./client";
import {
  accountMembership,
  auditLog,
  customerAccount,
  platformRoleAssignment,
  userProfile,
  waitlistEntry,
} from "./schema";

// Row <-> domain mapping happens only here (ADR-0008).

class PgWaitlistRepository implements WaitlistRepository {
  constructor(private readonly x: Executor) {}

  async findByEmailHash(emailHash: string): Promise<WaitlistEntry | null> {
    const [row] = await this.x.select().from(waitlistEntry).where(eq(waitlistEntry.emailHash, emailHash)).limit(1);
    return row ? toWaitlist(row) : null;
  }

  async insert(e: WaitlistEntry): Promise<void> {
    await this.x.insert(waitlistEntry).values({ ...e, utm: e.utm });
  }

  async list(opts: { limit: number; before?: Date }): Promise<WaitlistEntry[]> {
    const rows = await this.x
      .select()
      .from(waitlistEntry)
      .where(opts.before ? lt(waitlistEntry.createdAt, opts.before) : undefined)
      .orderBy(desc(waitlistEntry.createdAt), desc(waitlistEntry.id))
      .limit(opts.limit);
    return rows.map(toWaitlist);
  }

  async count(): Promise<number> {
    const [row] = await this.x.select({ n: sql<number>`count(*)::int` }).from(waitlistEntry);
    return row?.n ?? 0;
  }
}

function toWaitlist(r: typeof waitlistEntry.$inferSelect): WaitlistEntry {
  return {
    id: r.id,
    email: r.email,
    emailHash: r.emailHash,
    community: r.community,
    ref: r.ref,
    utm: (r.utm as Utm | null) ?? null,
    status: r.status === "invited" ? "invited" : "pending",
    createdAt: r.createdAt,
  };
}

class PgAuditRepository implements AuditRepository {
  constructor(private readonly x: Executor) {}

  async append(input: AuditEntryInput, at: Date): Promise<AuditEntry> {
    // Serialise appends per scope for the rest of this transaction, so the chain never forks.
    await this.x.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.scope}, 0))`);
    const [last] = await this.x
      .select({ seq: auditLog.seq, hash: auditLog.hash })
      .from(auditLog)
      .where(eq(auditLog.scope, input.scope))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const unsigned: Omit<AuditEntry, "hash"> = {
      ...input,
      id: randomUUID(),
      at: at.toISOString(),
      seq: (last?.seq ?? 0) + 1,
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const entry: AuditEntry = { ...unsigned, hash: hashEntry(unsigned) };
    await this.x.insert(auditLog).values({
      id: entry.id,
      scope: entry.scope,
      seq: entry.seq,
      at,
      action: entry.action,
      actorType: entry.actor.type,
      actorUserId: entry.actor.userId,
      actorEmail: entry.actor.email,
      actorRole: entry.actor.role,
      actorAccountId: entry.actor.accountId,
      onBehalfOf: entry.onBehalfOf,
      targetType: entry.target.type,
      targetId: entry.target.id,
      targetLabel: entry.target.label,
      result: entry.result,
      errorCode: entry.errorCode,
      requestId: entry.requestId,
      ip: entry.ip,
      userAgent: entry.userAgent,
      meta: entry.meta,
      prevHash: entry.prevHash,
      hash: entry.hash,
    });
    return entry;
  }

  async list(q: AuditQuery): Promise<AuditEntry[]> {
    const where: SQL[] = [eq(auditLog.scope, q.scope)];
    if (q.action) where.push(eq(auditLog.action, q.action));
    if (q.actorUserId) where.push(eq(auditLog.actorUserId, q.actorUserId));
    if (q.targetId) where.push(eq(auditLog.targetId, q.targetId));
    if (q.from) where.push(gte(auditLog.at, q.from));
    if (q.to) where.push(lte(auditLog.at, q.to));
    if (q.beforeSeq !== undefined) where.push(lt(auditLog.seq, q.beforeSeq));
    const rows = await this.x
      .select()
      .from(auditLog)
      .where(and(...where))
      .orderBy(desc(auditLog.seq))
      .limit(q.limit);
    return rows.map(toAudit);
  }

  async chain(scope: AuditEntry["scope"]): Promise<AuditEntry[]> {
    const rows = await this.x.select().from(auditLog).where(eq(auditLog.scope, scope)).orderBy(auditLog.seq);
    return rows.map(toAudit);
  }
}

function toAudit(r: typeof auditLog.$inferSelect): AuditEntry {
  return {
    id: r.id,
    scope: r.scope as AuditEntry["scope"],
    seq: r.seq,
    at: r.at.toISOString(),
    action: r.action as AuditEntry["action"],
    actor: {
      type: r.actorType as AuditEntry["actor"]["type"],
      userId: r.actorUserId,
      email: r.actorEmail,
      role: r.actorRole as AuditEntry["actor"]["role"],
      accountId: r.actorAccountId,
    },
    onBehalfOf: (r.onBehalfOf as AuditEntry["onBehalfOf"]) ?? null,
    target: { type: r.targetType, id: r.targetId, label: r.targetLabel },
    result: r.result as AuditEntry["result"],
    errorCode: r.errorCode,
    requestId: r.requestId,
    ip: r.ip,
    userAgent: r.userAgent,
    meta: r.meta as Record<string, unknown>,
    prevHash: r.prevHash,
    hash: r.hash,
  };
}

const isPlatformRole = (v: string): v is PlatformRole => (PLATFORM_ROLES as readonly string[]).includes(v);
const isAccountRole = (v: string): v is AccountRole => (ACCOUNT_ROLES as readonly string[]).includes(v);

class PgAccessRepository implements AccessRepository {
  constructor(private readonly x: Executor) {}

  async platformRoles(userId: string): Promise<PlatformRole[]> {
    const rows = await this.x
      .select({ role: platformRoleAssignment.role })
      .from(platformRoleAssignment)
      .where(eq(platformRoleAssignment.userId, userId));
    return rows.map((r) => r.role).filter(isPlatformRole);
  }

  async memberships(userId: string): Promise<{ accountId: string; role: AccountRole }[]> {
    const rows = await this.x
      .select({ accountId: accountMembership.accountId, role: accountMembership.role })
      .from(accountMembership)
      .where(eq(accountMembership.userId, userId));
    return rows.flatMap((r) => (isAccountRole(r.role) ? [{ accountId: r.accountId, role: r.role }] : []));
  }

  async isSuspended(userId: string): Promise<boolean> {
    const [row] = await this.x
      .select({ suspended: userProfile.suspended })
      .from(userProfile)
      .where(eq(userProfile.userId, userId));
    return row?.suspended ?? false;
  }

  async accountNames(accountIds: readonly string[]): Promise<Record<string, string>> {
    const ids = accountIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (ids.length === 0) return {};
    const rows = await this.x
      .select({ id: customerAccount.id, name: customerAccount.name })
      .from(customerAccount)
      .where(inArray(customerAccount.id, ids));
    return Object.fromEntries(rows.map((r) => [r.id, r.name] as const));
  }
}

class PgAccountRepository implements AccountRepository {
  constructor(private readonly x: Executor) {}

  async create(input: { name: string; plan: string }): Promise<{ id: string }> {
    const [row] = await this.x
      .insert(customerAccount)
      .values({ name: input.name, plan: input.plan })
      .returning({ id: customerAccount.id });
    if (!row) throw new Error("account not created");
    return row;
  }

  async addMember(input: { accountId: string; userId: string; role: AccountRole }): Promise<void> {
    await this.x.insert(accountMembership).values(input);
  }

  async setUserState(input: { userId: string; state: string }): Promise<void> {
    await this.x
      .insert(userProfile)
      .values({ userId: input.userId, state: input.state })
      .onConflictDoUpdate({ target: userProfile.userId, set: { state: input.state, updatedAt: new Date() } });
  }

  async membershipCount(userId: string): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(accountMembership)
      .where(eq(accountMembership.userId, userId));
    return row?.n ?? 0;
  }
}

const repositories = (x: Executor): Repositories => ({
  waitlist: new PgWaitlistRepository(x),
  audit: new PgAuditRepository(x),
  access: new PgAccessRepository(x),
  accounts: new PgAccountRepository(x),
});

/** One Postgres transaction per `run` (CLAUDE.md rule 46: the audit row commits with the change). */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly database: Db) {}

  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(repositories(tx)));
  }
}
