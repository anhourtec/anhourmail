// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, inArray, lt, lte, type SQL, sql } from "drizzle-orm";

import { type AccessRepository, ConflictError, type Repositories, type UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import type { AliasKind, AliasRepository, MailAlias } from "@anhourmail/core/aliases";
import type { CustomerDomain, DomainRepository, DomainStatus } from "@anhourmail/core/domains";
import type { Mailbox, MailboxRepository, MailboxStatus } from "@anhourmail/core/mailboxes";
import type {
  DomainState,
  JobKind,
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
import { PLAN_ORDER, type PlanId } from "@anhourmail/shared/plans";
import { ACCOUNT_ROLES, type AccountRole, PLATFORM_ROLES, type PlatformRole } from "@anhourmail/shared/rbac";

import type { Db, Executor } from "./client";
import {
  accountMembership,
  auditLog,
  authUser,
  customerAccount,
  customerDomain,
  mailAlias,
  mailbox,
  platformRoleAssignment,
  provisioningJob,
  userProfile,
} from "./schema";

// Row <-> domain mapping happens only here (ADR-0008).

/** Postgres unique violation (23505), whether or not the driver error is wrapped. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = e.cause, depth++) {
    if ((e as Error & { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** Runs an insert; a duplicate address becomes a 409 rather than a 500. */
async function insertAddress(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("That address is already in use.");
    throw err;
  }
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

  members(accountId: string): Promise<{ userId: string; email: string; role: AccountRole }[]> {
    return accountMembers(this.x, accountId);
  }
}

async function accountMembers(
  x: Executor,
  accountId: string,
): Promise<{ userId: string; email: string; role: AccountRole }[]> {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return [];
  const rows = await x
    .select({ userId: accountMembership.userId, email: authUser.email, role: accountMembership.role })
    .from(accountMembership)
    .innerJoin(authUser, eq(authUser.id, accountMembership.userId))
    .where(eq(accountMembership.accountId, accountId))
    .orderBy(authUser.email);
  return rows.flatMap((r) => (isAccountRole(r.role) ? [{ userId: r.userId, email: r.email, role: r.role }] : []));
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

  async get(id: string): Promise<{ id: string; name: string; plan: PlanId; status: string } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [r] = await this.x.select().from(customerAccount).where(eq(customerAccount.id, id));
    if (!r) return null;
    const plan = (PLAN_ORDER as readonly string[]).includes(r.plan) ? (r.plan as PlanId) : "free";
    return { id: r.id, name: r.name, plan, status: r.status };
  }

  async lock(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return;
    await this.x.execute(sql`select id from customer_account where id = ${id} for update`);
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

/** A job left `running` this long (crashed worker) is claimable again. */
const STALE_RUNNING_MS = 10 * 60 * 1000;

function toJob(r: typeof provisioningJob.$inferSelect): ProvisioningJob {
  return {
    id: r.id,
    kind: r.kind as JobKind,
    subjectId: r.subjectId,
    status: r.status as ProvisioningJob["status"],
    attempts: r.attempts,
    lastError: r.lastError,
    runAfter: r.runAfter,
  };
}

class PgProvisioningRepository implements ProvisioningRepository {
  constructor(private readonly x: Executor) {}

  async enqueue(input: { kind: JobKind; subjectId: string; runAfter: Date }): Promise<ProvisioningJob> {
    const [existing] = await this.x
      .select()
      .from(provisioningJob)
      .where(
        and(
          eq(provisioningJob.kind, input.kind),
          eq(provisioningJob.subjectId, input.subjectId),
          eq(provisioningJob.status, "queued"),
        ),
      )
      .limit(1);
    if (existing) return toJob(existing);
    const [row] = await this.x
      .insert(provisioningJob)
      .values({
        id: randomUUID(),
        kind: input.kind,
        subjectId: input.subjectId,
        status: "queued",
        runAfter: input.runAfter,
      })
      .returning();
    if (!row) throw new Error("job not created");
    return toJob(row);
  }

  /** Atomic claim: FOR UPDATE SKIP LOCKED, so concurrent workers never take the same job. */
  async claimNext(now: Date): Promise<ProvisioningJob | null> {
    const stale = new Date(now.getTime() - STALE_RUNNING_MS);
    const res = await this.x.execute<{ id: string }>(sql`
      update provisioning_job set status = 'running', attempts = attempts + 1, locked_at = ${now}, updated_at = ${now}
      where id = (
        select id from provisioning_job
        where (status = 'queued' and run_after <= ${now}) or (status = 'running' and locked_at < ${stale})
        order by run_after
        limit 1
        for update skip locked
      )
      returning id`);
    const id = res.rows[0]?.id;
    if (!id) return null;
    return this.get(id);
  }

  async complete(id: string, now: Date): Promise<void> {
    await this.x
      .update(provisioningJob)
      .set({ status: "succeeded", lastError: null, lockedAt: null, updatedAt: now })
      .where(eq(provisioningJob.id, id));
  }

  async retry(id: string, error: string, runAfter: Date, now: Date): Promise<void> {
    await this.x
      .update(provisioningJob)
      .set({ status: "queued", lastError: error, runAfter, lockedAt: null, updatedAt: now })
      .where(eq(provisioningJob.id, id));
  }

  async giveUp(id: string, error: string, now: Date): Promise<void> {
    await this.x
      .update(provisioningJob)
      .set({ status: "failed", lastError: error, lockedAt: null, updatedAt: now })
      .where(eq(provisioningJob.id, id));
  }

  async get(id: string): Promise<ProvisioningJob | null> {
    const [row] = await this.x.select().from(provisioningJob).where(eq(provisioningJob.id, id));
    return row ? toJob(row) : null;
  }
}

class PgMailDirectoryRepository implements MailDirectoryRepository {
  constructor(private readonly x: Executor) {}

  async getDomain(id: string): Promise<DomainState | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [r] = await this.x.select().from(customerDomain).where(eq(customerDomain.id, id));
    return r ? { id: r.id, name: r.name, status: r.status, stalwartId: r.stalwartId } : null;
  }

  async getMailbox(id: string): Promise<MailboxState | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [m] = await this.x.select().from(mailbox).where(eq(mailbox.id, id));
    if (!m) return null;
    const aliases = await this.x.select().from(mailAlias).where(eq(mailAlias.mailboxId, id)).orderBy(mailAlias.address);
    return {
      id: m.id,
      accountId: m.accountId,
      address: m.address,
      quotaBytes: m.quotaBytes,
      status: m.status,
      stalwartId: m.stalwartId,
      aliases: aliases.map((a) => ({
        address: a.address,
        kind: a.kind === "masked" ? "masked" : "alias",
        enabled: a.enabled,
        description: a.description,
      })),
    };
  }

  async markDomain(id: string, update: { stalwartId?: string; lastError: string | null }): Promise<void> {
    await this.x
      .update(customerDomain)
      .set({ lastError: update.lastError, ...(update.stalwartId ? { stalwartId: update.stalwartId } : {}) })
      .where(eq(customerDomain.id, id));
  }

  async claimedDomainOwner(name: string): Promise<string | null> {
    const [r] = await this.x
      .select({ accountId: customerDomain.accountId })
      .from(customerDomain)
      .where(and(eq(customerDomain.name, name), inArray(customerDomain.status, ["active", "removing"])))
      .limit(1);
    return r?.accountId ?? null;
  }

  async deleteDomain(id: string): Promise<void> {
    await this.x.delete(customerDomain).where(and(eq(customerDomain.id, id), eq(customerDomain.status, "removing")));
  }

  async markMailbox(
    id: string,
    update: { status: string; stalwartId?: string; lastError: string | null },
  ): Promise<void> {
    await this.x
      .update(mailbox)
      .set({
        status: update.status,
        lastError: update.lastError,
        ...(update.stalwartId ? { stalwartId: update.stalwartId } : {}),
      })
      .where(eq(mailbox.id, id));
  }

  async desired(): Promise<{ domains: string[]; mailboxes: { address: string; quotaBytes: number }[] }> {
    // Sequential: a transaction holds one database connection, which runs one query at a time.
    const domains = await this.x
      .select({ name: customerDomain.name })
      .from(customerDomain)
      .where(eq(customerDomain.status, "active"));
    const mailboxes = await this.x
      .select({ address: mailbox.address, quotaBytes: mailbox.quotaBytes })
      .from(mailbox)
      .where(eq(mailbox.status, "active"));
    return { domains: domains.map((d) => d.name), mailboxes };
  }
}

const DOMAIN_STATUSES: readonly DomainStatus[] = ["pending_dns", "active", "removing"];

function toDomain(r: typeof customerDomain.$inferSelect): CustomerDomain {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    status: DOMAIN_STATUSES.includes(r.status as DomainStatus) ? (r.status as DomainStatus) : "pending_dns",
    verifyToken: r.verifyToken,
    stalwartId: r.stalwartId,
    lastError: r.lastError,
    createdAt: r.createdAt,
  };
}

class PgDomainRepository implements DomainRepository {
  constructor(private readonly x: Executor) {}

  async listByAccount(accountId: string): Promise<CustomerDomain[]> {
    const rows = await this.x
      .select()
      .from(customerDomain)
      .where(eq(customerDomain.accountId, accountId))
      .orderBy(customerDomain.name);
    return rows.map(toDomain);
  }

  async get(accountId: string, id: string): Promise<CustomerDomain | null> {
    const [r] = await this.x
      .select()
      .from(customerDomain)
      .where(and(eq(customerDomain.id, id), eq(customerDomain.accountId, accountId)));
    return r ? toDomain(r) : null;
  }

  async nameTaken(name: string): Promise<boolean> {
    const [r] = await this.x
      .select({ id: customerDomain.id })
      .from(customerDomain)
      .where(and(eq(customerDomain.name, name), inArray(customerDomain.status, ["active", "removing"])))
      .limit(1);
    return r !== undefined;
  }

  async insert(d: CustomerDomain): Promise<void> {
    await this.x.insert(customerDomain).values({
      id: d.id,
      accountId: d.accountId,
      name: d.name,
      status: d.status,
      verifyToken: d.verifyToken,
      stalwartId: d.stalwartId,
      lastError: d.lastError,
      createdAt: d.createdAt,
    });
  }

  async transition(id: string, from: DomainStatus, to: DomainStatus): Promise<boolean> {
    const rows = await this.x
      .update(customerDomain)
      .set({ status: to })
      .where(and(eq(customerDomain.id, id), eq(customerDomain.status, from)))
      .returning({ id: customerDomain.id });
    return rows.length > 0;
  }

  async deletePending(id: string): Promise<boolean> {
    const rows = await this.x
      .delete(customerDomain)
      .where(and(eq(customerDomain.id, id), eq(customerDomain.status, "pending_dns")))
      .returning({ id: customerDomain.id });
    return rows.length > 0;
  }

  async addressCount(name: string): Promise<number> {
    const pattern = `%@${name}`;
    const [m] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(mailbox)
      .where(sql`${mailbox.address} like ${pattern}`);
    const [a] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(mailAlias)
      .where(sql`${mailAlias.address} like ${pattern}`);
    return (m?.n ?? 0) + (a?.n ?? 0);
  }

  async pending(since: Date, limit: number): Promise<CustomerDomain[]> {
    const rows = await this.x
      .select()
      .from(customerDomain)
      .where(and(eq(customerDomain.status, "pending_dns"), gte(customerDomain.createdAt, since)))
      .orderBy(sql`random()`)
      .limit(limit);
    return rows.map(toDomain);
  }
}

const MAILBOX_STATUSES: readonly MailboxStatus[] = ["provisioning", "active", "failed", "suspended"];

function toMailbox(r: typeof mailbox.$inferSelect): Mailbox {
  return {
    id: r.id,
    accountId: r.accountId,
    userId: r.userId,
    address: r.address,
    status: MAILBOX_STATUSES.includes(r.status as MailboxStatus) ? (r.status as MailboxStatus) : "provisioning",
    quotaBytes: r.quotaBytes,
    stalwartId: r.stalwartId,
    lastError: r.lastError,
    createdAt: r.createdAt,
  };
}

class PgMailboxRepository implements MailboxRepository {
  constructor(private readonly x: Executor) {}

  async listByAccount(accountId: string): Promise<Mailbox[]> {
    const rows = await this.x.select().from(mailbox).where(eq(mailbox.accountId, accountId)).orderBy(mailbox.address);
    return rows.map(toMailbox);
  }

  async get(accountId: string, id: string): Promise<Mailbox | null> {
    const [r] = await this.x
      .select()
      .from(mailbox)
      .where(and(eq(mailbox.id, id), eq(mailbox.accountId, accountId)));
    return r ? toMailbox(r) : null;
  }

  async count(accountId: string): Promise<number> {
    const [r] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(mailbox)
      .where(eq(mailbox.accountId, accountId));
    return r?.n ?? 0;
  }

  async addressTaken(address: string): Promise<boolean> {
    const [m] = await this.x.select({ id: mailbox.id }).from(mailbox).where(eq(mailbox.address, address)).limit(1);
    if (m) return true;
    const [a] = await this.x
      .select({ id: mailAlias.id })
      .from(mailAlias)
      .where(eq(mailAlias.address, address))
      .limit(1);
    return a !== undefined;
  }

  async lockAddress(address: string): Promise<void> {
    await this.x.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`address:${address}`}, 0))`);
  }

  async insert(m: Mailbox): Promise<void> {
    await insertAddress(() =>
      this.x.insert(mailbox).values({
        id: m.id,
        accountId: m.accountId,
        userId: m.userId,
        address: m.address,
        status: m.status,
        quotaBytes: m.quotaBytes,
        stalwartId: m.stalwartId,
        lastError: m.lastError,
        createdAt: m.createdAt,
      }),
    );
  }

  async setQuota(id: string, quotaBytes: number): Promise<void> {
    await this.x.update(mailbox).set({ quotaBytes }).where(eq(mailbox.id, id));
  }
}

const toAlias = (r: typeof mailAlias.$inferSelect): MailAlias => ({
  id: r.id,
  accountId: r.accountId,
  mailboxId: r.mailboxId,
  address: r.address,
  kind: r.kind === "masked" ? "masked" : "alias",
  enabled: r.enabled,
  description: r.description,
  createdAt: r.createdAt,
});

class PgAliasRepository implements AliasRepository {
  constructor(private readonly x: Executor) {}

  async listByAccount(accountId: string): Promise<MailAlias[]> {
    const rows = await this.x
      .select()
      .from(mailAlias)
      .where(eq(mailAlias.accountId, accountId))
      .orderBy(mailAlias.address);
    return rows.map(toAlias);
  }

  async get(accountId: string, id: string): Promise<MailAlias | null> {
    const [r] = await this.x
      .select()
      .from(mailAlias)
      .where(and(eq(mailAlias.id, id), eq(mailAlias.accountId, accountId)));
    return r ? toAlias(r) : null;
  }

  async count(accountId: string, kind: AliasKind): Promise<number> {
    const [r] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(mailAlias)
      .where(and(eq(mailAlias.accountId, accountId), eq(mailAlias.kind, kind)));
    return r?.n ?? 0;
  }

  async insert(a: MailAlias): Promise<void> {
    await insertAddress(() =>
      this.x.insert(mailAlias).values({
        id: a.id,
        accountId: a.accountId,
        mailboxId: a.mailboxId,
        address: a.address,
        kind: a.kind,
        enabled: a.enabled,
        description: a.description,
        createdAt: a.createdAt,
      }),
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.x.update(mailAlias).set({ enabled }).where(eq(mailAlias.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.x.delete(mailAlias).where(eq(mailAlias.id, id));
  }
}

const repositories = (x: Executor): Repositories => ({
  audit: new PgAuditRepository(x),
  access: new PgAccessRepository(x),
  accounts: new PgAccountRepository(x),
  provisioning: new PgProvisioningRepository(x),
  directory: new PgMailDirectoryRepository(x),
  domains: new PgDomainRepository(x),
  mailboxes: new PgMailboxRepository(x),
  aliases: new PgAliasRepository(x),
});

/** One Postgres transaction per `run` (CLAUDE.md rule 46: the audit row commits with the change). */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly database: Db) {}

  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(repositories(tx)));
  }
}
