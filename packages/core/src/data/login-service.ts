// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, authorize } from "../actor";
import { maskEmail } from "../audit/record";
import { ConflictError, ForbiddenError, StepUpRequiredError, ValidationError } from "../errors";
import { dropPersonGrants } from "../delegation/cascade";
import { type AuditAlso, mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";

/**
 * A person deletes their own console login (`self.login.delete`, ADR-0025): fresh step-up, their sign-in address typed
 * to confirm, never while staff act as someone. Only when no account depends on it:
 *
 * - no mailbox anywhere is theirs (an account's admins remove them first, which keeps the mailbox for the account);
 * - every account where they are the only Owner is empty (no mailboxes, domains or other people): those accounts are
 *   deleted with the login, right away (there is nothing in them to wait for);
 * - staff (anyone with a platform role) can't: their role is removed first.
 *
 * Memberships in other accounts are removed (each account's log records it, rule 49). Sessions, sign-in factors,
 * profile details, photo and exports go with the login. The audit log keeps what it recorded (append-only; its actor
 * snapshots keep entries readable, retained per audit.md "Retention"); this entry's target label masks the address.
 */

export type LoginDeletionBlocker = "mailboxes" | "sole_owner" | "staff" | "deleting";

/** What would happen, for the console page: whether it's possible and what stops it. */
export type LoginDeletionPlan = {
  allowed: boolean;
  blockers: { reason: LoginDeletionBlocker; accountId: string | null; accountName: string | null }[];
  /** Empty accounts the person is the only Owner of: deleted with the login. */
  accountsDeleted: { accountId: string; accountName: string }[];
  /** Accounts they leave. */
  accountsLeft: { accountId: string; accountName: string }[];
};

async function planFor(r: Repositories, userId: string): Promise<LoginDeletionPlan> {
  const plan: LoginDeletionPlan = { allowed: false, blockers: [], accountsDeleted: [], accountsLeft: [] };
  if ((await r.access.platformRoles(userId)).length > 0) {
    plan.blockers.push({ reason: "staff", accountId: null, accountName: null });
  }
  const memberships = await r.access.memberships(userId);
  const names = await r.access.accountNames(memberships.map((m) => m.accountId));
  for (const m of memberships) {
    const accountName = names[m.accountId] ?? "";
    const mailboxes = await r.mailboxes.listByAccount(m.accountId);
    if (mailboxes.some((x) => x.userId === userId)) {
      plan.blockers.push({ reason: "mailboxes", accountId: m.accountId, accountName });
      continue;
    }
    const members = await r.access.members(m.accountId);
    const otherOwners = members.filter((x) => x.role === "owner" && x.userId !== userId);
    if (m.role !== "owner" || otherOwners.length > 0) {
      plan.accountsLeft.push({ accountId: m.accountId, accountName });
      continue;
    }
    const empty =
      mailboxes.length === 0 && members.length === 1 && (await r.domains.listByAccount(m.accountId)).length === 0;
    if (!empty) {
      plan.blockers.push({ reason: "sole_owner", accountId: m.accountId, accountName });
    } else if ((await r.suspensions.account(m.accountId)) !== null) {
      // An account staff suspended stays until they lift it, even an empty one.
      plan.blockers.push({ reason: "deleting", accountId: m.accountId, accountName });
    } else {
      plan.accountsDeleted.push({ accountId: m.accountId, accountName });
    }
  }
  plan.allowed = plan.blockers.length === 0;
  return plan;
}

/** What deleting the person's login would do (for the console page). */
export async function loginDeletionPlan(deps: Deps, actor: Actor): Promise<LoginDeletionPlan> {
  authorize(actor, "self.login.delete");
  if (actor.kind !== "user") throw new ForbiddenError();
  if (actor.actingAs) throw new ForbiddenError("Logins can't be deleted while acting as someone.");
  return deps.uow.run((r) => planFor(r, actor.userId));
}

type Session = { sessionId: string | null };
type Refusal = "act_as" | "step_up_required" | LoginDeletionBlocker;

const BLOCKED: Record<LoginDeletionBlocker, string> = {
  staff: "Staff logins can't be deleted here. Ask a Global Administrator to remove your platform role first.",
  mailboxes:
    "A mailbox in one of your accounts is still yours. Ask that account's admins to remove you (the mailbox stays with the account), then try again.",
  sole_owner:
    "You're the only Owner of an account that still has mailboxes, domains or other people. Delete that account, or make someone else an Owner, first.",
  deleting: "One of your accounts is suspended by Anhourtec and can't be deleted until the suspension is lifted.",
};

/** Deletes the person's own console login (see the module comment). 400 unless `confirmEmail` is their address. */
export async function deleteOwnLogin(
  deps: Deps,
  actor: Actor,
  input: { confirmEmail?: unknown },
  session: Session,
  req: RequestMeta,
): Promise<{ email: string; accountsDeleted: number; accountsLeft: number }> {
  const label = actor.kind === "user" ? maskEmail(actor.email) : null;
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "auth.login_deleted",
      permission: "self.login.delete",
      accountId: null,
      target: { type: "user", id: actor.kind === "user" ? actor.userId : null, label },
    },
    async (
      repos,
    ): Promise<MutationOutcome<{ email: string; accountsDeleted: number; accountsLeft: number } | Refusal>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      const typed = typeof input.confirmEmail === "string" ? input.confirmEmail.trim().toLowerCase() : "";
      if (typed === "" || typed !== actor.email.trim().toLowerCase()) {
        throw new ValidationError("Type your sign-in email address exactly to confirm.");
      }
      if (
        !session.sessionId ||
        !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))
      ) {
        return { result: "step_up_required", denied: { code: "step_up_required" } };
      }
      // The login first (no new membership can appear for this person until the end), then each account; then the
      // memberships again: one that appeared before the lock means the plan would be stale, so ask to try again.
      await repos.dataLifecycle.lockLogin(actor.userId);
      const before = (await repos.access.memberships(actor.userId)).map((m) => m.accountId).sort();
      for (const id of before) await repos.accounts.lock(id);
      const after = (await repos.access.memberships(actor.userId)).map((m) => m.accountId).sort();
      if (before.join(",") !== after.join(",")) throw new ConflictError("Your accounts changed. Try again.");
      const plan = await planFor(repos, actor.userId);
      const first = plan.blockers[0];
      if (first) return { result: first.reason, denied: { code: first.reason } };
      const also: AuditAlso[] = [];
      for (const a of plan.accountsLeft) {
        // The grants they hold there go on record in that account's log before the membership takes them (ADR-0026).
        also.push(...(await dropPersonGrants(repos, a.accountId, actor.userId, { accountScoped: true })));
        if (!(await repos.people.remove(a.accountId, actor.userId)))
          throw new ConflictError("Your accounts changed. Try again.");
      }
      for (const a of plan.accountsDeleted) {
        if (!(await repos.dataLifecycle.deleteAccount(a.accountId)))
          throw new ConflictError("Your accounts changed. Try again.");
      }
      if (!(await repos.dataLifecycle.deleteLogin(actor.userId)))
        throw new ConflictError("This login is already gone.");
      return {
        result: {
          email: actor.email,
          accountsDeleted: plan.accountsDeleted.length,
          accountsLeft: plan.accountsLeft.length,
        },
        meta: { accountsDeleted: plan.accountsDeleted.length, accountsLeft: plan.accountsLeft.length },
        // Each account they left or that went with them records it (its admins see who left; rule 49).
        copies: [
          ...plan.accountsLeft.map((a) => ({ accountId: a.accountId, meta: { left: true } })),
          ...plan.accountsDeleted.map((a) => ({ accountId: a.accountId, meta: { accountDeleted: true } })),
        ],
        also,
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Logins can't be deleted while acting as someone.");
  if (out === "step_up_required") throw new StepUpRequiredError();
  if (typeof out === "string") throw new ConflictError(BLOCKED[out]);
  return out;
}
