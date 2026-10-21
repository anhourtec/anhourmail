// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, gte, inArray, lt, lte, type SQL, sql } from "drizzle-orm";

import type { AccessRepository, Repositories, UnitOfWork } from "@anhourmail/core";
import type { AccountRepository } from "@anhourmail/core/account";
import type { Invite, InviteRepository, InviteSource } from "@anhourmail/core/invite";
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
import type { WaitlistEntry, WaitlistRepository } from "@anhourmail/core/waitlist";
import { ACCOUNT_ROLES, type AccountRole, PLATFORM_ROLES, type PlatformRole } from "@anhourmail/shared/rbac";
import type { Utm } from "@anhourmail/shared/schemas";

import type { Db, Executor } from "./client";
import {
  accountMembership,
  auditLog,
  customerAccount,
  customerDomain,
  invite,
  mailAlias,
  mailbox,
  platformRoleAssignment,
  provisioningJob,
  userProfile,
  waitlistEntry,
} from "./schema";

// Row <-> domain mapping happens only here (ADR-0008).

class PgWaitlistRepository implements WaitlistRepository {
  constructor(private readonly x: Executor) {}

  async get(id: string): Promise<WaitlistEntry | null> {
    const [row] = await this.x.select().from(waitlistEntry).where(eq(waitlistEntry.id, id)).limit(1);
    return row ? toWaitlist(row) : null;
  }

  async findByConfirmToken(tokenHash: string, now: Date): Promise<WaitlistEntry | null> {
    const [row] = await this.x
      .select()
      .from(waitlistEntry)
      .where(
        and(
          eq(waitlistEntry.confirmTokenHash, tokenHash),
          eq(waitlistEntry.status, "pending"),
          gt(waitlistEntry.confirmExpiresAt, now),
        ),
      )
      .limit(1);
    return row ? toWaitlist(row) : null;
  }

  async setConfirmation(id: string, input: { tokenHash: string; expiresAt: Date; sentAt: Date }): Promise<void> {
    await this.x
      .update(waitlistEntry)
      .set({ confirmTokenHash: input.tokenHash, confirmExpiresAt: input.expiresAt, confirmSentAt: input.sentAt })
      .where(eq(waitlistEntry.id, id));
  }

  async markConfirmed(id: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(waitlistEntry)
      .set({ status: "confirmed", confirmedAt: at, confirmTokenHash: null, confirmExpiresAt: null })
      .where(and(eq(waitlistEntry.id, id), eq(waitlistEntry.status, "pending")))
      .returning({ id: waitlistEntry.id });
    return rows.length > 0;
  }

  async markInvited(id: string): Promise<boolean> {
    const rows = await this.x
      .update(waitlistEntry)
      .set({ status: "invited" })
      .where(and(eq(waitlistEntry.id, id), eq(waitlistEntry.status, "confirmed")))
      .returning({ id: waitlistEntry.id });
    return rows.length > 0;
  }

  async findByEmailHash(emailHash: string): Promise<WaitlistEntry | null> {
    const [row] = await this.x.select().from(waitlistEntry).where(eq(waitlistEntry.emailHash, emailHash)).limit(1);
    return row ? toWaitlist(row) : null;
  }

  async insert(e: WaitlistEntry): Promise<boolean> {
    const rows = await this.x
      .insert(waitlistEntry)
      .values({
        id: e.id,
        email: e.email,
        emailHash: e.emailHash,
        community: e.community,
        ref: e.ref,
        utm: e.utm,
        status: e.status,
        createdAt: e.createdAt,
        confirmSentAt: e.confirmSentAt,
        confirmedAt: e.confirmedAt,
      })
      .onConflictDoNothing({ target: waitlistEntry.emailHash })
      .returning({ id: waitlistEntry.id });
    return rows.length > 0;
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
    status: r.status === "invited" || r.status === "confirmed" ? r.status : "pending",
    createdAt: r.createdAt,
    confirmSentAt: r.confirmSentAt,
    confirmedAt: r.confirmedAt,
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
    const [domains, mailboxes] = await Promise.all([
      this.x.select({ name: customerDomain.name }).from(customerDomain).where(eq(customerDomain.status, "active")),
      this.x
        .select({ address: mailbox.address, quotaBytes: mailbox.quotaBytes })
        .from(mailbox)
        .where(eq(mailbox.status, "active")),
    ]);
    return { domains: domains.map((d) => d.name), mailboxes };
  }
}

class PgInviteRepository implements InviteRepository {
  constructor(private readonly x: Executor) {}

  async create(input: Parameters<InviteRepository["create"]>[0]): Promise<{ id: string }> {
    const [row] = await this.x
      .insert(invite)
      .values({
        email: input.email,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        source: input.source,
        createdBy: input.createdBy,
        waitlistEntryId: input.waitlistEntryId,
        accountId: input.accountId,
        role: input.role,
      })
      .returning({ id: invite.id });
    if (!row) throw new Error("invite not created");
    return row;
  }

  async findValid(tokenHash: string, now: Date): Promise<Invite | null> {
    const [r] = await this.x
      .select()
      .from(invite)
      .where(and(eq(invite.tokenHash, tokenHash), eq(invite.status, "pending"), gt(invite.expiresAt, now)))
      .limit(1);
    if (!r) return null;
    return {
      id: r.id,
      email: r.email,
      accountId: r.accountId,
      role: r.role !== null && isAccountRole(r.role) ? r.role : null,
      source: (["waitlist", "staff", "referral"].includes(r.source) ? r.source : "staff") as InviteSource,
      expiresAt: r.expiresAt,
    };
  }

  async markAccepted(id: string, userId: string, at: Date): Promise<void> {
    await this.x
      .update(invite)
      .set({ status: "accepted", acceptedUserId: userId, acceptedAt: at })
      .where(and(eq(invite.id, id), eq(invite.status, "pending")));
  }
}

const repositories = (x: Executor): Repositories => ({
  waitlist: new PgWaitlistRepository(x),
  audit: new PgAuditRepository(x),
  access: new PgAccessRepository(x),
  accounts: new PgAccountRepository(x),
  provisioning: new PgProvisioningRepository(x),
  directory: new PgMailDirectoryRepository(x),
  invites: new PgInviteRepository(x),
});

/** One Postgres transaction per `run` (CLAUDE.md rule 46: the audit row commits with the change). */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly database: Db) {}

  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(repositories(tx)));
  }
}
