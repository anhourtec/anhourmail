// SPDX-License-Identifier: AGPL-3.0-only
import { ACT_AS, COMPANY_DOMAIN } from "@anhourmail/shared/platform";
import { ACT_AS_ACCOUNT_ROLE, ACT_AS_ROLES, type PlatformRole } from "@anhourmail/shared/rbac";

import type { Actor, ActingAs, UserActor } from "../actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import { authorizeAudited, mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { ActAsEndReason, ActAsSession } from "./repository";

/**
 * Staff support access ("act as", ADR-0023). A Global or Support Administrator (`platform.accounts.actAs`) opens one
 * customer account from Platform → account with a written reason and a fresh step-up. For the next
 * `ACT_AS.minutes` (renewable with a new reason and step-up, up to `ACT_AS.maxMinutes` from the start) that console
 * session's actor is still the staff member, with their platform roles set aside and one membership: the account, as
 * `ACT_AS_ACCOUNT_ROLE` (read-only). Every service then checks permission and scope exactly as for anyone else, so
 * other accounts stay 404 and anything that changes something answers 403 — there is no bypass and no "with changes"
 * mode. Every entry written meanwhile carries `on_behalf_of` and shows in the account's log as Anhourtec staff
 * (rule 49); the account's Owners are emailed when it starts.
 *
 * Refused (audited as denied): without the permission (403), an unknown account (404, platform log only), no fresh
 * step-up (`step_up_required`), and any account where someone holds a staff role or signs in with a company address
 * (`staff_account`, rule 28: staff never act as staff). A suspended account (409) and a second open session for the
 * same staff member (409) are refused too. Ending is always possible; expiry, signing out and losing the role end it
 * on their own (`expireActAsSessions`, the scheduler).
 */

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const MINUTE = 60_000;
/** How many due sessions one scheduler run closes. */
const EXPIRE_BATCH = 200;

type Session = { sessionId: string | null };
type Refusal = "act_as" | "step_up_required" | "staff_account";

/** The reason from untrusted input: control characters and runs of whitespace become one space; 10–500 characters. */
export function parseActAsReason(input: unknown): string {
  if (typeof input !== "string") throw new ValidationError("Say why you need access to this account.");
  // eslint-disable-next-line no-control-regex -- strips control characters from free text on purpose
  const reason = input.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if (reason.length < ACT_AS.reasonMin) {
    throw new ValidationError(`Say why you need access, in at least ${String(ACT_AS.reasonMin)} characters.`);
  }
  if (reason.length > ACT_AS.reasonMax) {
    throw new ValidationError(`Keep the reason under ${String(ACT_AS.reasonMax)} characters.`);
  }
  return reason;
}

/** What the actor carries for an open session (built by the app from the session row on every request). */
export function actingAsFrom(s: ActAsSession): ActingAs {
  return {
    sessionId: s.id,
    accountId: s.accountId,
    staffUserId: s.staffUserId,
    staffEmail: s.staffEmail,
    staffRole: s.staffRole,
    reason: s.reason,
    expiresAt: s.expiresAt,
  };
}

/**
 * The actor for a staff member's request while `session` is open: their own identity and sign-in state, platform roles
 * set aside, the target account as their only membership (read-only), and the account suspension gate when it is
 * suspended. Null when the staff member no longer holds an act-as role: they get their own actor back.
 */
export function actingActor(
  staff: UserActor,
  session: ActAsSession,
  opts: { accountSuspended: boolean },
): UserActor | null {
  if (session.staffUserId !== staff.userId) return null;
  if (!staff.platformRoles.some((r) => ACT_AS_ROLES.includes(r))) return null;
  const { suspendedAccountIds: _own, ...rest } = staff;
  return {
    ...rest,
    platformRoles: [],
    memberships: [{ accountId: session.accountId, role: ACT_AS_ACCOUNT_ROLE }],
    actingAs: actingAsFrom(session),
    ...(opts.accountSuspended ? { suspendedAccountIds: [session.accountId] } : {}),
  };
}

/**
 * The actor for a staff member's request on console session `authSessionId`: acting (`actingActor`) when that session
 * has support access open, else null (their own actor). Only looked up for people who hold an act-as role, so
 * customers' requests never pay for it; an expired or ended session is simply not found. A session into an account
 * that has staff in it now (someone joined or became staff meanwhile, rule 28) is ignored at once; the scheduler
 * closes and records it (`staff_account`).
 */
export async function actingActorFor(deps: Deps, staff: UserActor, authSessionId: string): Promise<UserActor | null> {
  if (!staff.platformRoles.some((r) => ACT_AS_ROLES.includes(r))) return null;
  const found = await deps.uow.run(async (r) => {
    const session = await r.actAs.active(staff.userId, authSessionId, deps.clock.now());
    if (!session || (await r.actAs.staffInAccount(session.accountId))) return null;
    return { session, accountSuspended: (await r.suspensions.account(session.accountId)) !== null };
  });
  return found ? actingActor(staff, found.session, { accountSuspended: found.accountSuspended }) : null;
}

/** The refusal for a second open session (the service's check and the store's unique index say the same). */
export const ACT_AS_ALREADY_OPEN = "You already have support access open. End it before opening another account.";

/** True for an address at the company domain or any of its subdomains (`a@anhourtec.com`, `a@x.anhourtec.com`). */
export function isCompanyAddress(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return domain === COMPANY_DOMAIN || domain.endsWith(`.${COMPANY_DOMAIN}`);
}

/** The staff role that allows act-as, re-read from the database (the actor's own roles are set aside while acting). */
async function actAsRoleOf(repos: Repositories, userId: string): Promise<PlatformRole | null> {
  const roles = await repos.access.platformRoles(userId);
  return roles.find((r) => ACT_AS_ROLES.includes(r)) ?? null;
}

async function stepUpFresh(deps: Deps, repos: Repositories, actor: UserActor, session: Session): Promise<boolean> {
  return session.sessionId !== null && repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now());
}

function throwRefusal(r: Refusal): never {
  switch (r) {
    case "act_as":
      throw new ForbiddenError("End the support access you have open first.");
    case "step_up_required":
      throw new StepUpRequiredError();
    case "staff_account":
      throw new ForbiddenError("Support access isn't available for staff accounts.");
  }
}

export type ActAsStarted = {
  session: ActAsSession;
  /** The account's Owners, to email (sign-in addresses). */
  notify: { email: string }[];
};

/** Starts support access to `accountId` (see the module comment). Recorded in the account's log and the platform log. */
export async function startActAs(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { reason?: unknown },
  session: Session,
  req: RequestMeta,
): Promise<ActAsStarted> {
  const spec = {
    action: "staff.act_as_started",
    permission: "platform.accounts.actAs",
    target: { type: "account" },
  } as const;
  await authorizeAudited(deps, actor, req, { ...spec, accountId: null });
  const account = isId(accountId) ? await deps.uow.run((r) => r.platformAccounts.summary(accountId)) : null;
  if (!account) {
    // Unknown ids are recorded in the platform log only, so probes can't write into arbitrary accounts' logs.
    await mutation(deps, actor, req, { ...spec, accountId: null }, async () => ({
      result: undefined,
      denied: { code: "not_found" },
    }));
    throw new NotFoundError();
  }
  // Checked before anything is recorded: a typo in the reason isn't an event in the customer's log.
  const reason = parseActAsReason(input.reason);
  // Close (and record) this staff member's own sessions that already ended in effect — run out, signed out — but that
  // the scheduler hasn't closed yet, so they don't count as open (one unclosed session per staff member).
  if (actor.kind === "user" && !actor.actingAs) await closeDue(deps, deps.clock.now(), EXPIRE_BATCH, actor.userId);
  const out = await mutation(
    deps,
    actor,
    req,
    { ...spec, accountId, target: { type: "account", id: accountId, label: account.name }, staffPath: true },
    async (repos): Promise<MutationOutcome<ActAsStarted | Refusal>> => {
      if (actor.kind !== "user") throw new UnauthenticatedError();
      if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      if (!(await stepUpFresh(deps, repos, actor, session)) || session.sessionId === null) {
        return { result: "step_up_required", denied: { code: "step_up_required" } };
      }
      if (await repos.actAs.staffInAccount(accountId)) {
        return { result: "staff_account", denied: { code: "staff_account" } };
      }
      if (await repos.suspensions.account(accountId)) {
        throw new ConflictError("This account is suspended. Its details and the suspension are on this page.");
      }
      const now = deps.clock.now();
      if (await repos.actAs.openFor(actor.userId, now)) throw new ConflictError(ACT_AS_ALREADY_OPEN);
      const staffRole = actor.platformRoles.find((r) => ACT_AS_ROLES.includes(r));
      if (!staffRole) throw new ForbiddenError();
      const created = await repos.actAs.create({
        staffUserId: actor.userId,
        staffRole,
        authSessionId: session.sessionId,
        accountId,
        reason,
        startedAt: now,
        expiresAt: new Date(now.getTime() + ACT_AS.minutes * MINUTE),
      });
      const owners = (await repos.access.members(accountId)).filter((m) => m.role === "owner");
      const meta = { reason, minutes: ACT_AS.minutes, access: "read_only", actAsSessionId: created.id };
      return {
        result: { session: created, notify: owners.map((o) => ({ email: o.email })) },
        meta,
        copies: [{ accountId: null, meta }],
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** The open session behind an acting actor, re-read; 404 when the actor isn't acting or it has ended meanwhile. */
async function ownOpenSession(deps: Deps, repos: Repositories, actor: Actor): Promise<ActAsSession> {
  if (actor.kind !== "user" || !actor.actingAs) throw new NotFoundError("You don't have support access open.");
  const s = await repos.actAs.get(actor.actingAs.sessionId);
  if (s?.staffUserId !== actor.userId || s.endedAt !== null || s.expiresAt <= deps.clock.now()) {
    throw new NotFoundError("You don't have support access open.");
  }
  return s;
}

function requireActing(actor: Actor): { staff: UserActor; actingAs: ActingAs } {
  if (actor.kind === "anonymous") throw new UnauthenticatedError();
  if (actor.kind !== "user" || !actor.actingAs) throw new NotFoundError("You don't have support access open.");
  return { staff: actor, actingAs: actor.actingAs };
}

/**
 * Extends the open session by `ACT_AS.minutes` from now with a new reason (fresh step-up; the staff role is re-read),
 * never past `ACT_AS.maxMinutes` from its start (409 then: end it and start again). 404 when nothing is open.
 */
export async function renewActAs(
  deps: Deps,
  actor: Actor,
  input: { reason?: unknown },
  session: Session,
  req: RequestMeta,
): Promise<ActAsSession> {
  const acting = requireActing(actor);
  // Checked before anything is recorded: a typo in the reason isn't an event in the customer's log.
  const reason = parseActAsReason(input.reason);
  const spec = {
    action: "staff.act_as_renewed",
    // Your own act-as session, like your own sign-in sessions; the staff role is checked again below.
    permission: "self.security.manage",
    accountId: acting.actingAs.accountId,
    target: { type: "account", id: acting.actingAs.accountId },
  } as const;
  const out = await mutation(
    deps,
    actor,
    req,
    spec,
    async (repos): Promise<MutationOutcome<ActAsSession | Refusal>> => {
      const current = await ownOpenSession(deps, repos, actor);
      if (!(await actAsRoleOf(repos, acting.staff.userId))) throw new ForbiddenError();
      if (!(await stepUpFresh(deps, repos, acting.staff, session))) {
        return { result: "step_up_required", denied: { code: "step_up_required" } };
      }
      const now = deps.clock.now();
      const cap = current.startedAt.getTime() + ACT_AS.maxMinutes * MINUTE;
      const expiresAt = new Date(Math.min(now.getTime() + ACT_AS.minutes * MINUTE, cap));
      if (expiresAt.getTime() <= current.expiresAt.getTime()) {
        throw new ConflictError("Support access can't be extended any further. End it and start again if you need to.");
      }
      if (!(await repos.actAs.renew(current.id, expiresAt, reason, now))) {
        throw new NotFoundError("You don't have support access open.");
      }
      const meta = { reason, until: expiresAt.toISOString(), actAsSessionId: current.id };
      return {
        result: { ...current, expiresAt, reason },
        target: { label: current.accountName },
        meta,
        copies: [{ accountId: null, meta }],
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** Ends the open session now: the next request is the staff view again. Always allowed; 404 when nothing is open. */
export async function endActAs(deps: Deps, actor: Actor, req: RequestMeta): Promise<{ accountId: string }> {
  const acting = requireActing(actor);
  const accountId = acting.actingAs.accountId;
  return mutation(
    deps,
    actor,
    req,
    {
      action: "staff.act_as_ended",
      permission: "self.security.manage",
      accountId,
      target: { type: "account", id: accountId },
    },
    async (repos) => {
      const current = await ownOpenSession(deps, repos, actor);
      const now = deps.clock.now();
      if (!(await repos.actAs.end(current.id, now, "staff"))) {
        throw new NotFoundError("You don't have support access open.");
      }
      const meta = {
        ended: "staff" satisfies ActAsEndReason,
        minutes: Math.max(1, Math.round((now.getTime() - current.startedAt.getTime()) / MINUTE)),
        actAsSessionId: current.id,
      };
      return {
        result: { accountId },
        target: { label: current.accountName },
        meta,
        copies: [{ accountId: null, meta }],
      };
    },
  );
}

const SCHEDULER: Actor = { kind: "system", name: "act-as-expiry" };

/**
 * Scheduler: marks sessions ended that ran out, whose console session ended, or whose staff member lost the role, and
 * records each (`staff.act_as_ended` with the reason) in the account's log and the platform log. The console already
 * stops honouring them at once; this closes the record.
 */
export async function expireActAsSessions(deps: Deps, limit = EXPIRE_BATCH): Promise<{ ended: number }> {
  return { ended: await closeDue(deps, deps.clock.now(), limit) };
}

/** Closes and records due sessions (all, or one staff member's); how many it closed. */
async function closeDue(deps: Deps, now: Date, limit: number, staffUserId?: string): Promise<number> {
  const due = await deps.uow.run((r) => r.actAs.due(now, ACT_AS_ROLES, limit, staffUserId));
  let ended = 0;
  for (const { session, reason } of due) {
    const done = await mutation(
      deps,
      SCHEDULER,
      { requestId: `act-as-expiry-${session.id}`, ip: null, userAgent: null },
      {
        action: "staff.act_as_ended",
        permission: "platform.accounts.actAs",
        accountId: session.accountId,
        target: { type: "account", id: session.accountId, label: session.accountName },
      },
      async (repos) => {
        const at = reason === "expired" ? session.expiresAt : now;
        if (!(await repos.actAs.end(session.id, at, reason))) {
          return { result: false, denied: { code: "already_ended" } };
        }
        const meta = {
          ended: reason,
          staff: session.staffEmail,
          staffRole: session.staffRole,
          minutes: Math.max(1, Math.round((at.getTime() - session.startedAt.getTime()) / MINUTE)),
          actAsSessionId: session.id,
        };
        return { result: true, meta, copies: [{ accountId: null, meta }] };
      },
    );
    if (done) ended += 1;
  }
  return ended;
}
