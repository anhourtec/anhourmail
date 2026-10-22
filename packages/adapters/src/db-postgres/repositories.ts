// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";

import { type AccessRepository, ConflictError, type Repositories, type UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import type { AliasKind, AliasRepository, MailAlias } from "@anhourmail/core/aliases";
import type { Invite, InviteRepository, InviteStatus, MemberRecord, PeopleRepository } from "@anhourmail/core/people";
import type { AccountSummary, PlatformAccountRepository } from "@anhourmail/core/platform";
import type { CustomerDomain, DomainRepository, DomainStatus } from "@anhourmail/core/domains";
import { type Mailbox, type MailboxRepository, MAILBOX_STATUSES, type MailboxStatus } from "@anhourmail/core/mailboxes";
import type {
  DesiredMailbox,
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
  authAccount,
  authUser,
  customerAccount,
  customerDomain,
  invite,
  inviteSend,
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
    if (q.area) where.push(sql`starts_with(${auditLog.action}, ${`${q.area}.`})`);
    if (q.actorUserId) where.push(eq(auditLog.actorUserId, q.actorUserId));
    if (q.actorKind) where.push(actorKindWhere(q.actorKind));
    if (q.result) where.push(eq(auditLog.result, q.result));
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

/** Act-as entries count as staff (`on_behalf_of` set), whatever the actor type. */
function actorKindWhere(kind: NonNullable<AuditQuery["actorKind"]>): SQL {
  const noAgent = sql`(${auditLog.onBehalfOf} is null or ${auditLog.onBehalfOf} = 'null'::jsonb)`;
  switch (kind) {
    case "staff":
      return sql`(${auditLog.actorType} = 'staff' or not ${noAgent})`;
    case "user":
      return sql`(${auditLog.actorType} in ('user', 'api_token') and ${noAgent})`;
    default:
      return sql`(${auditLog.actorType} = ${kind} and ${noAgent})`;
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
    // Claims are serialised (cheap, held only for this transaction) so the "no other job for this subject is
    // running" check below can't be passed by two workers at once: one subject is never applied twice in parallel,
    // so an older job can't land after a newer one (e.g. an unsuspend after a suspend).
    await this.x.execute(sql`select pg_advisory_xact_lock(hashtextextended('provisioning_job:claim', 0))`);
    const res = await this.x.execute<{ id: string }>(sql`
      update provisioning_job set status = 'running', attempts = attempts + 1, locked_at = ${now}, updated_at = ${now}
      where id = (
        select j.id from provisioning_job j
        where ((j.status = 'queued' and j.run_after <= ${now}) or (j.status = 'running' and j.locked_at < ${stale}))
          and not exists (
            select 1 from provisioning_job r
            where r.subject_id = j.subject_id and r.id <> j.id and r.status = 'running' and r.locked_at >= ${stale}
          )
        order by j.run_after
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
      purgeAfter: m.purgeAfter,
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

  async desired(): Promise<{ domains: string[]; mailboxes: DesiredMailbox[] }> {
    // Sequential: a transaction holds one database connection, which runs one query at a time.
    const domains = await this.x
      .select({ name: customerDomain.name })
      .from(customerDomain)
      .where(eq(customerDomain.status, "active"));
    const mailboxes = await this.x
      .select({
        id: mailbox.id,
        address: mailbox.address,
        quotaBytes: mailbox.quotaBytes,
        status: mailbox.status,
        stalwartId: mailbox.stalwartId,
      })
      .from(mailbox);
    return {
      domains: domains.map((d) => d.name),
      mailboxes: mailboxes.map((m) => ({
        id: m.id,
        address: m.address,
        quotaBytes: m.quotaBytes,
        status: m.status,
        provisioned: m.stalwartId !== null,
      })),
    };
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
    purgeAfter: r.purgeAfter,
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
        purgeAfter: m.purgeAfter,
        createdAt: m.createdAt,
      }),
    );
  }

  async setQuota(id: string, quotaBytes: number): Promise<void> {
    await this.x.update(mailbox).set({ quotaBytes }).where(eq(mailbox.id, id));
  }

  async transition(
    id: string,
    from: readonly MailboxStatus[],
    to: MailboxStatus,
    purgeAfter: Date | null,
  ): Promise<boolean> {
    if (from.length === 0) return false;
    const rows = await this.x
      .update(mailbox)
      // A new intent: any error from applying the previous one no longer describes the mailbox.
      .set({ status: to, purgeAfter, lastError: null })
      .where(and(eq(mailbox.id, id), inArray(mailbox.status, [...from])))
      .returning({ id: mailbox.id });
    return rows.length > 0;
  }

  async dueForPurge(now: Date, limit: number): Promise<Mailbox[]> {
    const rows = await this.x
      .select()
      .from(mailbox)
      .where(and(eq(mailbox.status, "deleting"), lte(mailbox.purgeAfter, now)))
      .orderBy(mailbox.purgeAfter)
      .limit(limit);
    return rows.map(toMailbox);
  }

  async deleteIfDue(id: string, now: Date): Promise<boolean> {
    // Aliases go with it (mail_alias.mailbox_id is ON DELETE CASCADE).
    const rows = await this.x
      .delete(mailbox)
      .where(and(eq(mailbox.id, id), eq(mailbox.status, "deleting"), lte(mailbox.purgeAfter, now)))
      .returning({ id: mailbox.id });
    return rows.length > 0;
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

const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

class PgPeopleRepository implements PeopleRepository {
  constructor(private readonly x: Executor) {}

  async list(accountId: string): Promise<MemberRecord[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .select({
        userId: accountMembership.userId,
        name: authUser.name,
        email: authUser.email,
        role: accountMembership.role,
        joinedAt: accountMembership.createdAt,
        suspended: userProfile.suspended,
      })
      .from(accountMembership)
      .innerJoin(authUser, eq(authUser.id, accountMembership.userId))
      .leftJoin(userProfile, eq(userProfile.userId, accountMembership.userId))
      .where(eq(accountMembership.accountId, accountId))
      .orderBy(authUser.email);
    return rows.flatMap((r) =>
      isAccountRole(r.role)
        ? [
            {
              userId: r.userId,
              name: r.name,
              email: r.email,
              role: r.role,
              joinedAt: r.joinedAt,
              suspended: r.suspended ?? false,
            },
          ]
        : [],
    );
  }

  async setRole(accountId: string, userId: string, role: AccountRole): Promise<boolean> {
    if (!isId(accountId)) return false;
    const rows = await this.x
      .update(accountMembership)
      .set({ role })
      .where(and(eq(accountMembership.accountId, accountId), eq(accountMembership.userId, userId)))
      .returning({ userId: accountMembership.userId });
    return rows.length > 0;
  }

  async remove(accountId: string, userId: string): Promise<boolean> {
    if (!isId(accountId)) return false;
    const rows = await this.x
      .delete(accountMembership)
      .where(and(eq(accountMembership.accountId, accountId), eq(accountMembership.userId, userId)))
      .returning({ userId: accountMembership.userId });
    return rows.length > 0;
  }

  async userByEmail(email: string): Promise<{ id: string; name: string } | null> {
    const [r] = await this.x
      .select({ id: authUser.id, name: authUser.name })
      .from(authUser)
      .where(sql`lower(${authUser.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return r ?? null;
  }

  async createLogin(input: {
    email: string;
    name: string;
    firstName: string;
    lastName: string | null;
    passwordHash: string;
  }): Promise<{ id: string }> {
    const id = randomUUID();
    try {
      // The same rows better-auth writes for an email + password sign-up (provider "credential").
      await this.x.insert(authUser).values({
        id,
        name: input.name,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        emailVerified: true,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("That address already has a login.");
      throw err;
    }
    await this.x.insert(authAccount).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: input.passwordHash,
    });
    return { id };
  }
}

const INVITE_STATUSES: readonly InviteStatus[] = ["pending", "accepted", "revoked"];

function toInvite(r: typeof invite.$inferSelect): Invite | null {
  if (r.accountId === null || r.role === null || !isAccountRole(r.role)) return null;
  return {
    id: r.id,
    accountId: r.accountId,
    email: r.email,
    role: r.role,
    status: INVITE_STATUSES.includes(r.status as InviteStatus) ? (r.status as InviteStatus) : "revoked",
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

class PgInviteRepository implements InviteRepository {
  constructor(private readonly x: Executor) {}

  async listPending(accountId: string): Promise<Invite[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .select()
      .from(invite)
      .where(and(eq(invite.accountId, accountId), eq(invite.status, "pending")))
      .orderBy(desc(invite.createdAt), invite.id);
    return rows.flatMap((r) => toInvite(r) ?? []);
  }

  async get(accountId: string, id: string): Promise<Invite | null> {
    if (!isId(accountId) || !isId(id)) return null;
    const [r] = await this.x
      .select()
      .from(invite)
      .where(and(eq(invite.id, id), eq(invite.accountId, accountId)));
    return r ? toInvite(r) : null;
  }

  async findByToken(tokenHash: string): Promise<Invite | null> {
    const [r] = await this.x.select().from(invite).where(eq(invite.tokenHash, tokenHash));
    return r ? toInvite(r) : null;
  }

  async create(input: Omit<Invite, "id" | "status"> & { tokenHash: string }): Promise<Invite> {
    const [r] = await this.x
      .insert(invite)
      .values({
        email: input.email,
        accountId: input.accountId,
        role: input.role,
        tokenHash: input.tokenHash,
        status: "pending",
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
        createdAt: input.createdAt,
      })
      .returning();
    const created = r ? toInvite(r) : null;
    if (!created) throw new Error("invite not created");
    return created;
  }

  async reissue(id: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
    const rows = await this.x
      .update(invite)
      .set({ tokenHash, expiresAt })
      .where(and(eq(invite.id, id), eq(invite.status, "pending")))
      .returning({ id: invite.id });
    return rows.length > 0;
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.x
      .update(invite)
      .set({ status: "revoked" })
      .where(and(eq(invite.id, id), eq(invite.status, "pending")))
      .returning({ id: invite.id });
    return rows.length > 0;
  }

  async accept(id: string, userId: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(invite)
      .set({ status: "accepted", acceptedUserId: userId, acceptedAt: at })
      .where(and(eq(invite.id, id), eq(invite.status, "pending"), sql`${invite.expiresAt} > ${at}`))
      .returning({ id: invite.id });
    return rows.length > 0;
  }

  async recordSend(accountId: string, inviteId: string, at: Date): Promise<void> {
    await this.x.insert(inviteSend).values({ accountId, inviteId, sentAt: at });
  }

  async sendsSince(accountId: string, since: Date): Promise<number> {
    if (!isId(accountId)) return 0;
    const [r] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(inviteSend)
      .where(and(eq(inviteSend.accountId, accountId), gte(inviteSend.sentAt, since)));
    return r?.n ?? 0;
  }
}

/** `like` pattern for a literal substring (escapes %, _ and the escape character). */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

class PgPlatformAccountRepository implements PlatformAccountRepository {
  constructor(private readonly x: Executor) {}

  private readonly columns = {
    id: customerAccount.id,
    name: customerAccount.name,
    plan: customerAccount.plan,
    status: customerAccount.status,
    createdAt: customerAccount.createdAt,
    members: sql<number>`(select count(*)::int from ${accountMembership} where ${accountMembership.accountId} = ${customerAccount.id})`,
    mailboxes: sql<number>`(select count(*)::int from ${mailbox} where ${mailbox.accountId} = ${customerAccount.id})`,
    domains: sql<number>`(select count(*)::int from ${customerDomain} where ${customerDomain.accountId} = ${customerAccount.id})`,
  };

  private static toSummary(r: {
    id: string;
    name: string;
    plan: string;
    status: string;
    createdAt: Date;
    members: number;
    mailboxes: number;
    domains: number;
  }): AccountSummary {
    const plan = (PLAN_ORDER as readonly string[]).includes(r.plan) ? (r.plan as PlanId) : "free";
    return { ...r, plan };
  }

  async search(q: { query: string | null; limit: number; offset: number }) {
    let where: SQL | undefined;
    if (q.query !== null) {
      const pattern = contains(q.query.toLowerCase());
      const matchesMember = sql`exists (select 1 from ${accountMembership} m join ${authUser} u on u.id = m.user_id
        where m.account_id = ${customerAccount.id} and lower(u.email) like ${pattern})`;
      where = or(
        sql`lower(${customerAccount.name}) like ${pattern}`,
        ...(isId(q.query) ? [eq(customerAccount.id, q.query)] : []),
        matchesMember,
      );
    }
    const [count] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(customerAccount)
      .where(where);
    const rows = await this.x
      .select(this.columns)
      .from(customerAccount)
      .where(where)
      .orderBy(desc(customerAccount.createdAt), customerAccount.id)
      .limit(q.limit)
      .offset(q.offset);
    return { total: count?.n ?? 0, rows: rows.map((r) => PgPlatformAccountRepository.toSummary(r)) };
  }

  async summary(id: string): Promise<AccountSummary | null> {
    if (!isId(id)) return null;
    const [r] = await this.x.select(this.columns).from(customerAccount).where(eq(customerAccount.id, id));
    return r ? PgPlatformAccountRepository.toSummary(r) : null;
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
  people: new PgPeopleRepository(x),
  invites: new PgInviteRepository(x),
  platformAccounts: new PgPlatformAccountRepository(x),
});

/** One Postgres transaction per `run` (CLAUDE.md rule 46: the audit row commits with the change). */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly database: Db) {}

  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(repositories(tx)));
  }
}
