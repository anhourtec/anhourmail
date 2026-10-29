// SPDX-License-Identifier: AGPL-3.0-only
import { ACCOUNT_DELETION_GRACE_DAYS } from "@anhourmail/shared/data-lifecycle";

import { type Actor, authorize, can } from "../actor";
import { turnOffCatchAllFor } from "../domains/catch-all";
import { ConflictError, ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import { mutation, type MutationOutcome } from "../mutation";
import { holdMailboxes, releaseMailboxes } from "../platform/suspension";
import { staffHeld } from "../mailboxes/service";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { AccountDeletion } from "./entity";

/**
 * Account deletion (ADR-0025). An Owner asks (`account.delete`, fresh step-up, the account's name typed exactly); the
 * account then waits `ACCOUNT_DELETION_GRACE_DAYS`: its usable mailboxes are suspended at once (mail kept; held with
 * kind `deletion`, so cancelling resumes exactly those), pending invites are revoked, and nothing else changes in it
 * (the actor's `deletingAccountIds` gate). An Owner can cancel until the grace period ends. Then the scheduler's
 * `account-deletion` job removes it in idempotent steps, each audited, never before the grace period ends:
 *
 *   1. every mailbox → `deleting` with its purge date now (the hourly purge takes the mail-server account and its mail);
 *   2. once no mailbox is left, every domain is released (pending ones deleted, the rest taken off the mail server);
 *   3. once no domain is left, the account row goes, and with it memberships, invites and exports.
 *
 * The audit log stays (append-only; retained per audit.md "Retention"). People keep their console logins (they may
 * belong to other accounts); each can delete their own afterwards. Billing has no hook yet (Phase 5). Never while staff
 * act as someone; while staff hold the account or any of its mailboxes (an account or person suspension), no step
 * runs and the wait is audited (`data.deletion_started` denied `staff_hold`, at most once a day).
 */

const DAY_MS = 86_400_000;

type Session = { sessionId: string | null };
type Refusal = "act_as" | "step_up_required";

function throwRefusal(r: Refusal): never {
  if (r === "act_as")
    throw new ForbiddenError("Account deletion can't be requested or cancelled while acting as someone.");
  throw new StepUpRequiredError();
}

/** What the console shows about a pending deletion (any member of the account). */
export type AccountDeletionView = {
  requestedAt: Date;
  deleteAfter: Date;
  /** The grace period ended and removal has begun: it can't be cancelled any more. */
  started: boolean;
  /** The viewer may cancel it (an Owner, before it started). */
  canCancel: boolean;
};

export type DeletionNotice = {
  accountName: string;
  deleteAfter: Date;
  /** Everyone in the account (sign-in addresses; Owners can cancel), to tell them. */
  notify: { email: string; owner: boolean }[];
  mailboxesSuspended: number;
};

const view = (actor: Actor, d: AccountDeletion): AccountDeletionView => ({
  requestedAt: d.requestedAt,
  deleteAfter: d.deleteAfter,
  started: d.startedAt !== null,
  canCancel: d.startedAt === null && can(actor, "account.delete", d.accountId),
});

/** The account's pending deletion, or null. Any member may see it (the console shows a notice to everyone). */
export async function accountDeletionStatus(
  deps: Deps,
  actor: Actor,
  accountId: string,
): Promise<AccountDeletionView | null> {
  if (actor.kind !== "user" || !actor.memberships.some((m) => m.accountId === accountId)) {
    authorize(actor, "account.read", accountId); // 401 / 404, never confirming the account
    throw new NotFoundError();
  }
  const d = await deps.uow.run((r) => r.dataLifecycle.getDeletion(accountId));
  return d ? view(actor, d) : null;
}

/** The same for the account's settings and its API (`account.read`): Members and outsiders get 403 / 404. */
export async function accountDeletionDetails(
  deps: Deps,
  actor: Actor,
  accountId: string,
): Promise<AccountDeletionView | null> {
  authorize(actor, "account.read", accountId);
  return accountDeletionStatus(deps, actor, accountId);
}

/** Asks to delete the account (see the module comment). 400 unless `confirmName` is its name; 409 when already asked. */
export async function requestAccountDeletion(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { confirmName?: unknown },
  session: Session,
  req: RequestMeta,
): Promise<DeletionNotice> {
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "data.deletion_requested",
      permission: "account.delete",
      accountId,
      target: { type: "account", id: accountId },
    },
    async (repos): Promise<MutationOutcome<DeletionNotice | Refusal>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      const account = await repos.accounts.get(accountId);
      if (!account) throw new NotFoundError();
      const target = { label: account.name };
      if (actor.actingAs) return { result: "act_as", target, denied: { code: "act_as" } };
      const typed = typeof input.confirmName === "string" ? input.confirmName.trim() : "";
      if (typed === "" || typed !== account.name.trim()) {
        throw new ValidationError("Type the account's name exactly as shown to confirm.");
      }
      const now = deps.clock.now();
      if (!session.sessionId || !(await repos.security.stepUpFresh(actor.userId, session.sessionId, now))) {
        return { result: "step_up_required", target, denied: { code: "step_up_required" } };
      }
      // Serialised with mailbox changes and staff suspensions (they take the account lock too).
      await repos.accounts.lock(accountId);
      if (await repos.dataLifecycle.getDeletion(accountId)) {
        throw new ConflictError("This account is already scheduled for deletion.");
      }
      const deleteAfter = new Date(now.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
      await repos.dataLifecycle.scheduleDeletion({
        accountId,
        requestedBy: actor.userId,
        requestedAt: now,
        deleteAfter,
        startedAt: null,
      });
      let invitesRevoked = 0;
      for (const i of await repos.invites.listPending(accountId)) {
        if (await repos.invites.revoke(i.id)) invitesRevoked += 1;
      }
      const held = await holdMailboxes(deps, repos, await repos.mailboxes.listByAccount(accountId), "deletion");
      const members = await repos.access.members(accountId);
      const meta = {
        deleteAfter: deleteAfter.toISOString(),
        graceDays: ACCOUNT_DELETION_GRACE_DAYS,
        mailboxesSuspended: held.suspended,
        invitesRevoked,
        ...(held.catchAllOff.length > 0 ? { catchAllOff: held.catchAllOff } : {}),
      };
      return {
        result: {
          accountName: account.name,
          deleteAfter,
          notify: members.map((m) => ({ email: m.email, owner: m.role === "owner" })),
          mailboxesSuspended: held.suspended,
        },
        target,
        meta,
        // Staff see pending deletions in the platform log too.
        copies: [{ accountId: null, meta }],
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** Cancels a pending deletion before its grace period ends: the mailboxes it suspended resume. 409 if none or too late. */
export async function cancelAccountDeletion(
  deps: Deps,
  actor: Actor,
  accountId: string,
  req: RequestMeta,
): Promise<DeletionNotice> {
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "data.deletion_cancelled",
      permission: "account.delete",
      accountId,
      target: { type: "account", id: accountId },
    },
    async (repos): Promise<MutationOutcome<DeletionNotice | Refusal>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      const account = await repos.accounts.get(accountId);
      if (!account) throw new NotFoundError();
      const target = { label: account.name };
      if (actor.actingAs) return { result: "act_as", target, denied: { code: "act_as" } };
      await repos.accounts.lock(accountId);
      const d = await repos.dataLifecycle.getDeletion(accountId);
      if (!d) throw new ConflictError("This account isn't scheduled for deletion.");
      if (d.startedAt !== null || d.deleteAfter <= deps.clock.now()) {
        throw new ConflictError(
          "The grace period has ended and the account is being deleted. It can't be cancelled now.",
        );
      }
      if (!(await repos.dataLifecycle.cancelDeletion(accountId))) {
        throw new ConflictError("This account changed while you were working on it. Reload and try again.");
      }
      const released = await releaseMailboxes(deps, repos, await repos.mailboxes.listByAccount(accountId), "deletion");
      const members = await repos.access.members(accountId);
      const meta = { mailboxesResumed: released.resumed, mailboxesStillHeld: released.stillHeld };
      return {
        result: {
          accountName: account.name,
          deleteAfter: d.deleteAfter,
          notify: members.map((m) => ({ email: m.email, owner: m.role === "owner" })),
          mailboxesSuspended: 0,
        },
        target,
        meta,
        copies: [{ accountId: null, meta }],
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** Staff: every account waiting to be deleted, soonest first (`platform.deletions.read`). */
export async function pendingDeletions(
  deps: Deps,
  actor: Actor,
): Promise<{ accountId: string; accountName: string; requestedAt: Date; deleteAfter: Date; started: boolean }[]> {
  authorize(actor, "platform.deletions.read");
  const rows = await deps.uow.run((r) => r.dataLifecycle.pendingDeletions());
  return rows.map((d) => ({
    accountId: d.accountId,
    accountName: d.accountName,
    requestedAt: d.requestedAt,
    deleteAfter: d.deleteAfter,
    started: d.startedAt !== null,
  }));
}

const EXECUTOR = { kind: "system", name: "account-deletion" } as const;
const meta = (accountId: string, step: string) => ({
  requestId: `deletion-${step}-${accountId}`,
  ip: null,
  userAgent: null,
});

/** Per scheduler run: at most this many accounts are advanced. */
export const DELETION_BATCH = 10;

/** What one run did to one account. `deleted` carries who to tell. */
export type DeletionStep =
  | {
      accountId: string;
      step: "held" | "started" | "waiting_for_mailboxes" | "releasing_domains" | "waiting_for_domains";
    }
  | { accountId: string; step: "deleted"; accountName: string; notify: string[] };

/**
 * Anhourtec staff hold the account (an account suspension) or any of its mailboxes (an account or person suspension,
 * or a staff hold on it): the deletion waits, so an investigation never loses its evidence (ADR-0025).
 */
async function deletionHeld(r: Repositories, accountId: string): Promise<boolean> {
  if ((await r.suspensions.account(accountId)) !== null) return true;
  for (const m of await r.mailboxes.listByAccount(accountId)) if (await staffHeld(r, m)) return true;
  return false;
}

/** How often a deletion held by staff is recorded again (the job runs every 10 minutes). */
const HELD_AUDIT_MS = 86_400_000;

/** Records that the deletion waits for staff (`data.deletion_started` denied `staff_hold`), at most once a day. */
async function auditHeld(deps: Deps, accountId: string): Promise<void> {
  const since = new Date(deps.clock.now().getTime() - HELD_AUDIT_MS);
  const recent = await deps.uow.run((r) =>
    r.audit.list({
      scope: `account:${accountId}`,
      action: "data.deletion_started",
      result: "denied",
      from: since,
      limit: 1,
    }),
  );
  if (recent.length > 0) return;
  await mutation(
    deps,
    EXECUTOR,
    meta(accountId, "held"),
    {
      action: "data.deletion_started",
      permission: "account.delete",
      accountId,
      target: { type: "account", id: accountId },
    },
    async () => ({ result: undefined, meta: { waitingFor: "staff_hold" }, denied: { code: "staff_hold" } }),
  );
}

/** Step 1: every mailbox → deleting, purge date now; catch-alls off. */
async function start(deps: Deps, d: AccountDeletion): Promise<void> {
  await mutation(
    deps,
    EXECUTOR,
    meta(d.accountId, "start"),
    {
      action: "data.deletion_started",
      permission: "account.delete",
      accountId: d.accountId,
      target: { type: "account", id: d.accountId },
    },
    async (repos) => {
      const now = deps.clock.now();
      await repos.accounts.lock(d.accountId);
      if (d.deleteAfter > now) throw new ConflictError("The grace period hasn't ended.");
      // Under the account lock (a staff account suspension takes it too): staff may have stepped in since the check in
      // `runDueDeletions`. Nothing starts while they hold the account or any of its mailboxes.
      if (await deletionHeld(repos, d.accountId)) throw new ConflictError("Anhourtec holds this account.");
      if (!(await repos.dataLifecycle.startDeletion(d.accountId, now))) {
        throw new ConflictError("The deletion was cancelled or already started.");
      }
      let mailboxes = 0;
      for (const m of await repos.mailboxes.listByAccount(d.accountId)) {
        if (!(await repos.mailboxes.transition(m.id, [m.status], "deleting", now))) {
          throw new ConflictError("A mailbox changed while the deletion started.");
        }
        await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: now });
        await turnOffCatchAllFor(deps, repos, m.id);
        mailboxes += 1;
      }
      for (const i of await repos.invites.listPending(d.accountId)) await repos.invites.revoke(i.id);
      const account = await repos.accounts.get(d.accountId);
      const out = { mailboxes, requestedAt: d.requestedAt.toISOString(), deleteAfter: d.deleteAfter.toISOString() };
      return {
        result: undefined,
        target: { label: account?.name ?? null },
        meta: out,
        copies: [{ accountId: null, meta: out }],
      };
    },
  );
}

/** Step 2: release every domain (pending without a mail-server id: deleted; the rest: taken off by the worker). */
async function releaseDomains(deps: Deps, accountId: string): Promise<boolean> {
  const domains = await deps.uow.run((r) => r.domains.listByAccount(accountId));
  let changed = false;
  for (const d of domains) {
    if (d.status === "removing") {
      // Re-queue one whose job gave up (the queue reuses a queued job, so this never piles up).
      await deps.uow.run(async (r) => {
        const job = await r.provisioning.latest("domain.remove", d.id);
        if (job?.status === "failed") {
          await r.provisioning.enqueue({ kind: "domain.remove", subjectId: d.id, runAfter: deps.clock.now() });
        }
      });
      continue;
    }
    await mutation(
      deps,
      EXECUTOR,
      meta(accountId, `domain-${d.id}`),
      {
        action: "domain.removed",
        permission: "domain.manage",
        accountId,
        target: { type: "domain", id: d.id, label: d.name },
      },
      async (repos) => {
        if (d.status === "pending_dns" && d.stalwartId === null) {
          if (!(await repos.domains.deletePending(d.id))) throw new ConflictError("The domain changed.");
        } else {
          if (!(await repos.domains.transition(d.id, d.status, "removing")))
            throw new ConflictError("The domain changed.");
          await repos.provisioning.enqueue({ kind: "domain.remove", subjectId: d.id, runAfter: deps.clock.now() });
        }
        return { result: undefined, meta: { reason: "account_deleted", from: d.status } };
      },
    );
    changed = true;
  }
  return changed;
}

/** Step 3: the account row (and everything it owns in the control plane). The audit log stays. */
async function finish(deps: Deps, accountId: string): Promise<{ accountName: string; notify: string[] }> {
  return mutation(
    deps,
    EXECUTOR,
    meta(accountId, "finish"),
    { action: "account.deleted", permission: "account.delete", accountId, target: { type: "account", id: accountId } },
    async (repos) => {
      await repos.accounts.lock(accountId);
      const account = await repos.accounts.get(accountId);
      if (!account) throw new NotFoundError();
      if (
        (await repos.mailboxes.listByAccount(accountId)).length > 0 ||
        (await repos.domains.listByAccount(accountId)).length > 0
      ) {
        throw new ConflictError("Mailboxes or domains are still being removed.");
      }
      const members = await repos.access.members(accountId);
      if (!(await repos.dataLifecycle.deleteAccount(accountId)))
        throw new ConflictError("The account is already gone.");
      const out = { people: members.length, plan: account.plan };
      return {
        result: { accountName: account.name, notify: members.map((m) => m.email) },
        target: { label: account.name },
        meta: out,
        copies: [{ accountId: null, meta: out }],
      };
    },
  );
}

/**
 * Scheduler (`job:account-deletion`): advances each account whose grace period ended by one step (see the module
 * comment). Idempotent and resumable: every step re-reads the state and does only what is left; a failed step is
 * audited as `failed` and tried again on the next run. Never touches an account before its `deleteAfter`.
 */
export async function runDueDeletions(deps: Deps, limit = DELETION_BATCH): Promise<DeletionStep[]> {
  const due = await deps.uow.run((r) => r.dataLifecycle.dueDeletions(deps.clock.now(), limit));
  const out: DeletionStep[] = [];
  for (const d of due) {
    try {
      // Staff hold the account or one of its mailboxes (an investigation): no step runs until they lift it — before
      // the start and after it alike (the purge skips held mailboxes too). The wait is audited once a day.
      if (await deps.uow.run((r) => deletionHeld(r, d.accountId))) {
        await auditHeld(deps, d.accountId);
        out.push({ accountId: d.accountId, step: "held" });
        continue;
      }
      if (d.startedAt === null) {
        await start(deps, d);
        out.push({ accountId: d.accountId, step: "started" });
        continue;
      }
      const mailboxes = await deps.uow.run((r) => r.mailboxes.listByAccount(d.accountId));
      if (mailboxes.length > 0) {
        // The hourly purge removes them (their purge date is the deletion's start); keep any whose job gave up moving.
        out.push({ accountId: d.accountId, step: "waiting_for_mailboxes" });
        continue;
      }
      const released = await releaseDomains(deps, d.accountId);
      if (released) {
        out.push({ accountId: d.accountId, step: "releasing_domains" });
        continue;
      }
      if ((await deps.uow.run((r) => r.domains.listByAccount(d.accountId))).length > 0) {
        out.push({ accountId: d.accountId, step: "waiting_for_domains" });
        continue;
      }
      const done = await finish(deps, d.accountId);
      out.push({ accountId: d.accountId, step: "deleted", ...done });
    } catch {
      // Audited as `failed` by mutation(); the next run tries again.
    }
  }
  return out;
}
