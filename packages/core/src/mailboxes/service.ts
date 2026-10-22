// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { MAILBOX_DELETE_GRACE_DAYS, MAX_MAILBOXES, PLANS } from "@anhourmail/shared/plans";

import { type Actor, authorize } from "../actor";
import { maskEmail } from "../audit/record";
import { turnOffCatchAllFor } from "../domains/catch-all";
import { ConflictError, ForbiddenError, NotFoundError, PlanLimitError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { MailServer } from "../provisioning/ports";
import { GB, type Mailbox, type MailboxStatus, normaliseLocalPart } from "./entity";

/** What the console and API show; mail-server ids and errors stay server-side. */
export type MailboxView = {
  id: string;
  address: string;
  status: MailboxStatus;
  quotaBytes: number;
  owner: { userId: string; email: string } | null;
  /** While `deleting`: when it is removed for good (it can be restored until then). */
  purgeAfter: Date | null;
  /**
   * The worker gave up applying the current state to the mail server (e.g. a suspension isn't in force yet). Only
   * whether it happened; the error text stays server-side. Suspend or delete again to retry.
   */
  applyFailed: boolean;
  createdAt: Date;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function scoped(repos: Repositories, accountId: string, id: string): Promise<Mailbox> {
  const m = isId(id) ? await repos.mailboxes.get(accountId, id) : null;
  if (!m) throw new NotFoundError();
  return m;
}

async function views(repos: Repositories, accountId: string, list: Mailbox[]): Promise<MailboxView[]> {
  const members = new Map((await repos.access.members(accountId)).map((m) => [m.userId, m.email] as const));
  return list.map((m) => ({
    id: m.id,
    address: m.address,
    status: m.status,
    quotaBytes: m.quotaBytes,
    owner: m.userId && members.has(m.userId) ? { userId: m.userId, email: members.get(m.userId) ?? "" } : null,
    purgeAfter: m.purgeAfter,
    applyFailed: m.lastError !== null,
    createdAt: m.createdAt,
  }));
}

/**
 * Suspending, deleting or restoring a mailbox that belongs to an owner or an admin of the account (any role but
 * Member) takes an Owner: a User Admin can't lock out the people above them or each other. Their own mailbox and
 * unassigned or members' mailboxes are fine.
 */
export function lifecycleLocked(
  actor: Actor,
  accountId: string,
  m: Mailbox,
  members: readonly { userId: string; role: string }[],
): boolean {
  if (actor.kind !== "user") return false;
  if (actor.memberships.find((x) => x.accountId === accountId)?.role === "owner") return false;
  if (m.userId === null || m.userId === actor.userId) return false;
  const role = members.find((x) => x.userId === m.userId)?.role;
  return role !== undefined && role !== "member";
}

const LOCKED_MESSAGE = "Only an owner can suspend, delete or restore a mailbox that belongs to an owner or an admin.";

/**
 * Refuses changes to an address whose domain is no longer this account's: it must be one of the account's active
 * domains, or a platform domain nobody has claimed.
 */
export async function assertDomainHeld(repos: Repositories, accountId: string, address: string): Promise<void> {
  const domainName = address.slice(address.lastIndexOf("@") + 1);
  const own = (await repos.domains.listByAccount(accountId)).find((d) => d.name === domainName);
  if (own ? own.status !== "active" : await repos.domains.nameTaken(domainName)) {
    throw new ConflictError("This mailbox's domain is no longer active in this account.");
  }
}

/** Largest quota a mailbox can have on the account's plan (each mailbox gets up to the plan's storage). */
async function planQuota(repos: Repositories, accountId: string): Promise<number> {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  return PLANS[account.plan].storageGb * GB;
}

function parseQuota(input: unknown, max: number): number {
  if (input === undefined || input === null || input === "") return max;
  const gb = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(gb) || gb < 1 || gb * GB > max) {
    throw new ValidationError(`Choose a whole number of GB from 1 to ${String(max / GB)}.`);
  }
  return gb * GB;
}

export async function listMailboxes(deps: Deps, actor: Actor, accountId: string): Promise<MailboxView[]> {
  authorize(actor, "mailbox.read", accountId);
  return deps.uow.run(async (r) => views(r, accountId, await r.mailboxes.listByAccount(accountId)));
}

export async function getMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
): Promise<MailboxView & { maxQuotaBytes: number; lifecycleLocked: boolean }> {
  authorize(actor, "mailbox.read", accountId);
  return deps.uow.run(async (r) => {
    const m = await scoped(r, accountId, id);
    const [v] = await views(r, accountId, [m]);
    if (!v) throw new NotFoundError();
    return {
      ...v,
      maxQuotaBytes: await planQuota(r, accountId),
      /** True when this person may not suspend, delete or restore it (the console hides those actions). */
      lifecycleLocked: lifecycleLocked(actor, accountId, m, await r.access.members(accountId)),
    };
  });
}

/** What the create form needs: the account's active domains, its members and the quota bounds (`mailbox.manage`). */
export async function mailboxOptions(deps: Deps, actor: Actor, accountId: string) {
  authorize(actor, "mailbox.manage", accountId);
  return deps.uow.run(async (r) => ({
    domains: (await r.domains.listByAccount(accountId))
      .filter((d) => d.status === "active")
      .map((d) => ({ id: d.id, name: d.name })),
    members: (await r.access.members(accountId)).map((m) => ({ userId: m.userId, email: m.email })),
    maxQuotaGb: (await planQuota(r, accountId)) / GB,
    remaining: MAX_MAILBOXES - (await r.mailboxes.count(accountId)),
  }));
}

/**
 * Creates a mailbox on one of the account's active domains, optionally for one of its members. The worker creates
 * it on the mail server (no password is set: people use webmail sign-in and app passwords).
 */
export async function createMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { localPart?: unknown; domainId?: unknown; ownerUserId?: unknown; quotaGb?: unknown },
  req: RequestMeta,
): Promise<MailboxView> {
  return mutation(
    deps,
    actor,
    req,
    { action: "mailbox.created", permission: "mailbox.manage", accountId, target: { type: "mailbox" } },
    async (repos) => {
      await repos.accounts.lock(accountId); // the mailbox ceiling holds under concurrent creates
      const local = normaliseLocalPart(input.localPart);
      const domainId = typeof input.domainId === "string" ? input.domainId : "";
      const domain = isId(domainId) ? await repos.domains.get(accountId, domainId) : null;
      if (domain?.status !== "active") throw new ValidationError("Choose one of your active domains.");
      let userId: string | null = null;
      if (input.ownerUserId !== undefined && input.ownerUserId !== null && input.ownerUserId !== "") {
        const members = await repos.access.members(accountId);
        const owner = members.find((m) => m.userId === input.ownerUserId);
        if (!owner) throw new ValidationError("Choose someone in this account.");
        userId = owner.userId;
      }
      const quotaBytes = parseQuota(input.quotaGb, await planQuota(repos, accountId));
      if ((await repos.mailboxes.count(accountId)) >= MAX_MAILBOXES) {
        throw new PlanLimitError(`An account can have up to ${String(MAX_MAILBOXES)} mailboxes.`);
      }
      const address = `${local}@${domain.name}`;
      await repos.mailboxes.lockAddress(address); // mailboxes and aliases share one address space
      if (await repos.mailboxes.addressTaken(address)) throw new ConflictError("That address is already in use.");
      const mailbox: Mailbox = {
        id: randomUUID(),
        accountId,
        userId,
        address,
        status: "provisioning",
        quotaBytes,
        stalwartId: null,
        lastError: null,
        purgeAfter: null,
        createdAt: deps.clock.now(),
      };
      await repos.mailboxes.insert(mailbox);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      const [v] = await views(repos, accountId, [mailbox]);
      if (!v) throw new NotFoundError();
      return {
        result: v,
        target: { id: mailbox.id, label: address },
        meta: { quotaGb: quotaBytes / GB, owner: v.owner ? maskEmail(v.owner.email) : null },
      };
    },
  );
}

const BEING_DELETED = "This mailbox is being deleted. Restore it first.";

/** Changes a mailbox's quota (1 GB to the plan's storage); the worker applies it to the mail server. */
export async function setMailboxQuota(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  input: { quotaGb?: unknown },
  req: RequestMeta,
): Promise<MailboxView> {
  return mutation(
    deps,
    actor,
    req,
    { action: "mailbox.quota_changed", permission: "mailbox.manage", accountId, target: { type: "mailbox", id } },
    async (repos) => {
      const m = await scoped(repos, accountId, id);
      if (m.status === "deleting") throw new ConflictError(BEING_DELETED);
      await assertDomainHeld(repos, accountId, m.address);
      if (input.quotaGb === undefined || input.quotaGb === null || input.quotaGb === "") {
        throw new ValidationError("Choose a quota in GB.");
      }
      const quotaBytes = parseQuota(input.quotaGb, await planQuota(repos, accountId));
      await repos.mailboxes.setQuota(m.id, quotaBytes);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
      const [v] = await views(repos, accountId, [{ ...m, quotaBytes }]);
      if (!v) throw new NotFoundError();
      return {
        result: v,
        target: { label: m.address },
        meta: { fromGb: m.quotaBytes / GB, toGb: quotaBytes / GB },
      };
    },
  );
}

const DAY_MS = 24 * 3600_000;

/** One view of a mailbox after a lifecycle change, from inside the same unit of work. */
async function viewOf(repos: Repositories, accountId: string, m: Mailbox): Promise<MailboxView> {
  const [v] = await views(repos, accountId, [m]);
  if (!v) throw new NotFoundError();
  return v;
}

/**
 * Applies a lifecycle change (status + purge date; clears the last error) and queues the worker, which brings the
 * mail server to it. The change is conditional on the status read, so a concurrent change makes this one a conflict
 * instead of a lost update. `to` may equal the current status: that re-queues a change whose job gave up.
 */
async function moveTo(
  deps: Deps,
  repos: Repositories,
  m: Mailbox,
  to: MailboxStatus,
  purgeAfter: Date | null,
): Promise<Mailbox> {
  if (!(await repos.mailboxes.transition(m.id, [m.status], to, purgeAfter))) {
    throw new ConflictError("This mailbox changed while you were working on it. Reload and try again.");
  }
  await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
  return { ...m, status: to, purgeAfter, lastError: null };
}

type LifecycleAction = "mailbox.suspended" | "mailbox.unsuspended" | "mailbox.deletion_scheduled" | "mailbox.restored";

/**
 * Shared shape of suspend / resume / delete / restore: `mailbox.manage`, scoped to the account (404), the
 * owner-or-admin guard (403, audited as denied), then `change` in one audited unit of work.
 */
async function lifecycle(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
  action: LifecycleAction,
  change: (repos: Repositories, m: Mailbox) => Promise<{ next: Mailbox; meta?: Record<string, unknown> }>,
): Promise<MailboxView> {
  const out = await mutation(
    deps,
    actor,
    req,
    { action, permission: "mailbox.manage", accountId, target: { type: "mailbox", id } },
    async (repos) => {
      const m = await scoped(repos, accountId, id);
      if (lifecycleLocked(actor, accountId, m, await repos.access.members(accountId))) {
        return { result: null, target: { label: m.address }, denied: { code: "forbidden" } };
      }
      const { next, meta } = await change(repos, m);
      return { result: await viewOf(repos, accountId, next), target: { label: m.address }, meta: meta ?? {} };
    },
  );
  if (out === null) throw new ForbiddenError(LOCKED_MESSAGE);
  return out;
}

/**
 * Suspends a mailbox: nobody can sign in to it over any protocol and its mail is refused, but nothing it holds is
 * deleted. The worker applies it to the mail server. Suspending a suspended mailbox whose job gave up retries it.
 */
export async function suspendMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.suspended", async (repos, m) => {
    if (m.status === "deleting") throw new ConflictError(BEING_DELETED);
    if (m.status === "suspended") {
      if (m.lastError === null) throw new ConflictError("This mailbox is already suspended.");
      return { next: await moveTo(deps, repos, m, "suspended", null), meta: { from: m.status, retry: true } };
    }
    const next = await moveTo(deps, repos, m, "suspended", null);
    const catchAllOff = await turnOffCatchAllFor(deps, repos, m.id);
    return { next, meta: { from: m.status, ...(catchAllOff.length > 0 ? { catchAllOff } : {}) } };
  });
}

/** Resumes a suspended mailbox: the worker restores access, then it shows as active again. */
export async function resumeMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.unsuspended", async (repos, m) => {
    if (m.status !== "suspended") throw new ConflictError("This mailbox isn't suspended.");
    await assertDomainHeld(repos, accountId, m.address);
    return { next: await moveTo(deps, repos, m, "provisioning", null) };
  });
}

/**
 * Deletes a mailbox with a grace period: it is suspended at once (mail kept, its aliases off the mail server, its
 * address and theirs still reserved) and removed for good after `MAILBOX_DELETE_GRACE_DAYS`, unless restored.
 * Deleting a deleting mailbox whose job gave up retries it (the purge date stays).
 */
export async function deleteMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.deletion_scheduled", async (repos, m) => {
    if (m.status === "deleting") {
      if (m.lastError === null) throw new ConflictError("This mailbox is already being deleted.");
      const next = await moveTo(deps, repos, m, "deleting", m.purgeAfter);
      return { next, meta: { from: m.status, retry: true, purgeAfter: m.purgeAfter?.toISOString() ?? null } };
    }
    const purgeAfter = new Date(deps.clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY_MS);
    const next = await moveTo(deps, repos, m, "deleting", purgeAfter);
    const aliases = (await repos.aliases.listByAccount(accountId)).filter((a) => a.mailboxId === m.id).length;
    const catchAllOff = await turnOffCatchAllFor(deps, repos, m.id);
    return {
      next,
      meta: {
        from: m.status,
        purgeAfter: purgeAfter.toISOString(),
        aliases,
        ...(catchAllOff.length > 0 ? { catchAllOff } : {}),
      },
    };
  });
}

/**
 * Restores a mailbox during its grace period: the worker turns access and its aliases back on. Refused once the
 * grace period has ended, or when the mailbox's domain is no longer this account's.
 */
export async function restoreMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.restored", async (repos, m) => {
    if (m.status !== "deleting") throw new ConflictError("This mailbox isn't being deleted.");
    if (m.purgeAfter !== null && m.purgeAfter <= deps.clock.now()) {
      throw new ConflictError("This mailbox's grace period has ended, so it can't be restored.");
    }
    await assertDomainHeld(repos, accountId, m.address);
    return { next: await moveTo(deps, repos, m, "provisioning", null) };
  });
}

const PURGE = { kind: "system", name: "mailbox-purge" } as const;

/** Per scheduler run: at most this many mailboxes (the rest wait for the next run). */
export const PURGE_BATCH = 25;

/**
 * Scheduler: permanently removes mailboxes whose grace period has ended — the mail-server account (and its mail)
 * first, then the mailbox and alias rows, which frees their addresses. Each one is audited in its account's log as
 * `platform.mailbox_purged` by the system; a failure is audited as `failed` and retried on the next run.
 */
export async function purgeDueMailboxes(
  deps: Deps,
  mail: MailServer,
  limit = PURGE_BATCH,
): Promise<{ purged: number; failed: number }> {
  const due = await deps.uow.run((r) => r.mailboxes.dueForPurge(deps.clock.now(), limit));
  const out = { purged: 0, failed: 0 };
  for (const m of due) {
    try {
      await mutation(
        deps,
        PURGE,
        { requestId: `purge-${m.id}`, ip: null, userAgent: null },
        {
          action: "platform.mailbox_purged",
          permission: "mailbox.manage",
          accountId: m.accountId,
          target: { type: "mailbox", id: m.id, label: m.address },
        },
        async (repos) => {
          const current = await repos.mailboxes.get(m.accountId, m.id);
          const now = deps.clock.now();
          if (current?.status !== "deleting" || current.purgeAfter === null || current.purgeAfter > now) {
            throw new ConflictError("The mailbox changed before it could be removed."); // e.g. restored meanwhile
          }
          const aliases = (await repos.aliases.listByAccount(m.accountId)).filter((a) => a.mailboxId === m.id).length;
          // Delete the row first (conditional: still deleting and due), which also locks it until this unit of work
          // ends: a restore arriving now waits, then finds nothing to restore (409) instead of reporting success for
          // a mailbox whose mail is being destroyed. If the mail server refuses, everything rolls back.
          if (!(await repos.mailboxes.deleteIfDue(m.id, now))) {
            throw new ConflictError("The mailbox changed before it could be removed.");
          }
          await mail.destroyMailbox({ externalId: current.stalwartId, address: current.address });
          return { result: undefined, meta: { aliases, purgeAfter: current.purgeAfter.toISOString() } };
        },
      );
      out.purged += 1;
    } catch {
      out.failed += 1; // audited as `failed` by mutation(); retried on the next run
    }
  }
  return out;
}
