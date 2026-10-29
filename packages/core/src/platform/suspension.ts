// SPDX-License-Identifier: AGPL-3.0-only
import { isSuspensionReason, SUSPENSION_REASONS, type SuspensionReason } from "@anhourmail/shared/platform";
import type { AccountRole } from "@anhourmail/shared/rbac";

import { type Actor, authorize } from "../actor";
import type { AuditAction } from "../audit/catalogue";
import { maskEmail } from "../audit/record";
import { turnOffCatchAllFor } from "../domains/catch-all";
import { ConflictError, ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import type { Mailbox, MailboxStatus } from "../mailboxes/entity";
import { authorizeAudited, mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { MailboxHoldKind, SuspensionRecord } from "./repository";

/**
 * Staff suspension (`platform.account.suspend`, Global Administrator only; docs/internal/03-anti-spam-and-abuse.md
 * "Staff suspension"). Two kinds:
 *
 * - **Account:** the customer account's status becomes `suspended`; every usable mailbox in it is suspended on the mail
 *   server through the normal provisioning job (mail kept; no sign-in, sending or receiving), and its people can sign
 *   in to the console but every account permission answers 403 `account_suspended` (the console shows a notice).
 * - **Person:** their console sign-in is refused and their sessions end; the mailboxes assigned to them, in any
 *   account, are suspended the same way. Staff (anyone with a platform role) and the actor themselves are refused.
 *
 * Both need a fresh step-up, a reason category and are refused while acting as someone. Each suspended mailbox gets a
 * hold of that kind, so lifting resumes exactly the mailboxes the suspension stopped — never one the account had
 * suspended itself — and a mailbox held by both kinds resumes only when both are lifted. The internal note is
 * staff-only: kept on the suspension and in the platform audit entry, never in the customer's log or in emails.
 * Refusals before the subject is known (missing permission, unknown id) are audited in the platform log only.
 */

/** Longest internal note kept (characters). */
export const SUSPENSION_NOTE_MAX = 1000;

/** Mailbox states a suspension stops (and a lift brings back): the ones that can be in use. */
const USABLE: readonly MailboxStatus[] = ["active", "provisioning", "failed"];

/** Account roles told about an account suspension (Owners and the administrators). */
const NOTIFIED_ROLES: readonly AccountRole[] = ["owner", "domain_admin", "user_admin", "billing_admin"];

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const isUserId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

export type SuspendInput = { reason?: unknown; note?: unknown };
type Session = { sessionId: string | null };
type Refusal = "act_as" | "step_up_required" | "self" | "staff";

/** The reason category and the trimmed note (null when empty), or a 400. */
export function parseSuspendInput(input: SuspendInput): { reason: SuspensionReason; note: string | null } {
  if (!isSuspensionReason(input.reason)) throw new ValidationError("Choose a reason for the suspension.");
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    throw new ValidationError("The internal note must be text.");
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > SUSPENSION_NOTE_MAX) {
    throw new ValidationError(`Keep the internal note under ${String(SUSPENSION_NOTE_MAX)} characters.`);
  }
  return { reason: input.reason, note: note === "" ? null : note };
}

/** The plain-words label for a reason category (what the customer sees). */
export const reasonLabel = (reason: SuspensionReason): string => SUSPENSION_REASONS[reason];

/** Suspends the usable mailboxes among `list` (or adds this hold to one another suspension already holds). */
export async function holdMailboxes(deps: Deps, repos: Repositories, list: readonly Mailbox[], kind: MailboxHoldKind) {
  const holds = await repos.suspensions.holds(list.map((m) => m.id));
  let suspended = 0;
  const catchAllOff: string[] = [];
  for (const m of list) {
    if (USABLE.includes(m.status)) {
      if (!(await repos.mailboxes.transition(m.id, [m.status], "suspended", null))) {
        throw new ConflictError("A mailbox changed while suspending. Try again.");
      }
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
      await repos.suspensions.addHold(m.id, kind);
      catchAllOff.push(...(await turnOffCatchAllFor(deps, repos, m.id)));
      suspended += 1;
    } else if (m.status === "suspended" && holds.some((h) => h.mailboxId === m.id)) {
      // Already held by the other kind of suspension: both must be lifted before it resumes.
      await repos.suspensions.addHold(m.id, kind);
    }
  }
  return { suspended, catchAllOff };
}

/** Removes this hold from `list`; mailboxes with no hold left are resumed (the worker restores access). */
export async function releaseMailboxes(
  deps: Deps,
  repos: Repositories,
  list: readonly Mailbox[],
  kind: MailboxHoldKind,
) {
  const holds = await repos.suspensions.holds(list.map((m) => m.id));
  let resumed = 0;
  let stillHeld = 0;
  for (const m of list) {
    const mine = holds.filter((h) => h.mailboxId === m.id);
    if (!mine.some((h) => h.kind === kind)) continue;
    await repos.suspensions.removeHold(m.id, kind);
    if (mine.some((h) => h.kind !== kind)) {
      stillHeld += 1;
      continue;
    }
    if (m.status !== "suspended") continue; // deleted meanwhile: nothing to resume
    if (!(await repos.mailboxes.transition(m.id, ["suspended"], "provisioning", null))) {
      throw new ConflictError("A mailbox changed while lifting the suspension. Try again.");
    }
    await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
    resumed += 1;
  }
  return { resumed, stillHeld };
}

/** Act-as and step-up checks shared by every staff suspension change (refusals are audited as denied). */
async function staffChecks(deps: Deps, repos: Repositories, actor: Actor, session: Session): Promise<Refusal | null> {
  if (actor.kind !== "user") throw new ForbiddenError();
  if (actor.actingAs) return "act_as";
  if (!session.sessionId || !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))) {
    return "step_up_required";
  }
  return null;
}

function throwRefusal(r: Refusal): never {
  switch (r) {
    case "act_as":
      throw new ForbiddenError("Suspensions can't be changed while acting as someone.");
    case "step_up_required":
      throw new StepUpRequiredError();
    case "self":
      throw new ConflictError("You can't suspend yourself.");
    case "staff":
      throw new ConflictError("Staff can't be suspended here. Remove their platform role first.");
  }
}

/** Refusals before the subject is known: audited in the platform log, then 403 / 404. */
async function knownOr404<T>(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: { action: AuditAction; target: { type: string } },
  load: (r: Repositories) => Promise<T | null>,
  valid: boolean,
): Promise<T> {
  const platformSpec = { ...spec, permission: "platform.account.suspend", accountId: null } as const;
  await authorizeAudited(deps, actor, req, platformSpec);
  const found = valid ? await deps.uow.run(load) : null;
  if (found === null) {
    await mutation(deps, actor, req, platformSpec, async () => ({ result: undefined, denied: { code: "not_found" } }));
    throw new NotFoundError();
  }
  return found;
}

export type AccountSuspensionResult = {
  accountName: string;
  reason: SuspensionReason;
  /** Owners and administrators to email (sign-in addresses). */
  notify: { email: string }[];
  mailboxes: number;
};

/** Suspends a customer account (see the module comment). 409 when it is already suspended. */
export async function suspendAccount(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: SuspendInput,
  session: Session,
  req: RequestMeta,
): Promise<AccountSuspensionResult> {
  const spec = { action: "trust.suspended", target: { type: "account" } } as const;
  const account = await knownOr404(deps, actor, req, spec, (r) => r.accounts.get(accountId), isId(accountId));
  const out = await mutation(
    deps,
    actor,
    req,
    {
      ...spec,
      permission: "platform.account.suspend",
      accountId,
      target: { ...spec.target, id: accountId, label: account.name },
      staffPath: true,
    },
    async (repos): Promise<MutationOutcome<AccountSuspensionResult | Refusal>> => {
      const refusal = await staffChecks(deps, repos, actor, session);
      if (refusal) return { result: refusal, denied: { code: refusal } };
      const { reason, note } = parseSuspendInput(input);
      await repos.accounts.lock(accountId);
      if (await repos.suspensions.account(accountId)) throw new ConflictError("This account is already suspended.");
      const record: SuspensionRecord = {
        reason,
        note,
        at: deps.clock.now(),
        byUserId: actor.kind === "user" ? actor.userId : null,
      };
      await repos.suspensions.setAccount(accountId, record);
      const held = await holdMailboxes(deps, repos, await repos.mailboxes.listByAccount(accountId), "account");
      const members = await repos.access.members(accountId);
      const meta = {
        reason: reasonLabel(reason),
        reasonCategory: reason,
        mailboxesSuspended: held.suspended,
        ...(held.catchAllOff.length > 0 ? { catchAllOff: held.catchAllOff } : {}),
      };
      return {
        result: {
          accountName: account.name,
          reason,
          notify: members.filter((m) => NOTIFIED_ROLES.includes(m.role)).map((m) => ({ email: m.email })),
          mailboxes: held.suspended,
        },
        meta,
        // The platform log keeps the internal note; the account's own log (above) never does.
        copies: [{ accountId: null, meta: { ...meta, internalNote: note } }],
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** Lifts an account suspension: its status is `active` again and the mailboxes it suspended resume. 409 if not suspended. */
export async function liftAccountSuspension(
  deps: Deps,
  actor: Actor,
  accountId: string,
  session: Session,
  req: RequestMeta,
): Promise<AccountSuspensionResult> {
  const spec = { action: "trust.unsuspended", target: { type: "account" } } as const;
  const account = await knownOr404(deps, actor, req, spec, (r) => r.accounts.get(accountId), isId(accountId));
  const out = await mutation(
    deps,
    actor,
    req,
    {
      ...spec,
      permission: "platform.account.suspend",
      accountId,
      target: { ...spec.target, id: accountId, label: account.name },
      staffPath: true,
    },
    async (repos): Promise<MutationOutcome<AccountSuspensionResult | Refusal>> => {
      const refusal = await staffChecks(deps, repos, actor, session);
      if (refusal) return { result: refusal, denied: { code: refusal } };
      await repos.accounts.lock(accountId);
      const current = await repos.suspensions.account(accountId);
      if (!current) throw new ConflictError("This account isn't suspended.");
      await repos.suspensions.setAccount(accountId, null);
      const released = await releaseMailboxes(deps, repos, await repos.mailboxes.listByAccount(accountId), "account");
      const members = await repos.access.members(accountId);
      const meta = {
        reason: reasonLabel(current.reason),
        reasonCategory: current.reason,
        mailboxesResumed: released.resumed,
        mailboxesStillHeld: released.stillHeld,
      };
      return {
        result: {
          accountName: account.name,
          reason: current.reason,
          notify: members.filter((m) => NOTIFIED_ROLES.includes(m.role)).map((m) => ({ email: m.email })),
          mailboxes: released.resumed,
        },
        meta,
        copies: [{ accountId: null, meta }],
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

export type PersonSuspensionResult = {
  email: string;
  name: string;
  reason: SuspensionReason;
  mailboxes: number;
  sessionsRevoked: number;
};

/**
 * Suspends a person's console sign-in (see the module comment): sessions revoked, their mailboxes suspended. Refused
 * for staff and for yourself (409, audited as denied). 409 when already suspended. Recorded in the platform log (with
 * the note) and in each of their accounts' logs (without it).
 */
export async function suspendPerson(
  deps: Deps,
  actor: Actor,
  userId: string,
  input: SuspendInput,
  session: Session,
  req: RequestMeta,
): Promise<PersonSuspensionResult> {
  const spec = { action: "trust.suspended", target: { type: "user" } } as const;
  const person = await knownOr404(deps, actor, req, spec, (r) => r.suspensions.personInfo(userId), isUserId(userId));
  const label = maskEmail(person.email);
  const out = await mutation(
    deps,
    actor,
    req,
    { ...spec, permission: "platform.account.suspend", accountId: null, target: { type: "user", id: userId, label } },
    async (repos): Promise<MutationOutcome<PersonSuspensionResult | Refusal>> => {
      const refusal = await staffChecks(deps, repos, actor, session);
      if (refusal) return { result: refusal, denied: { code: refusal } };
      if (actor.kind === "user" && actor.userId === userId) return { result: "self", denied: { code: "self" } };
      if ((await repos.access.platformRoles(userId)).length > 0) return { result: "staff", denied: { code: "staff" } };
      const { reason, note } = parseSuspendInput(input);
      if (await repos.suspensions.person(userId)) throw new ConflictError("This person is already suspended.");
      await repos.suspensions.setPerson(userId, {
        reason,
        note,
        at: deps.clock.now(),
        byUserId: actor.kind === "user" ? actor.userId : null,
      });
      const sessionsRevoked = await repos.security.revokeOtherSessions(userId, "");
      const mailboxes = await repos.suspensions.mailboxesOf(userId);
      const held = await holdMailboxes(deps, repos, mailboxes, "person");
      const shared = { reason: reasonLabel(reason), reasonCategory: reason };
      // Each of their accounts' logs shows it too (rule 49), without the internal note.
      const copies = (await repos.access.memberships(userId)).map((m) => ({
        accountId: m.accountId,
        meta: { ...shared, mailboxesSuspended: held.suspended },
      }));
      return {
        result: { email: person.email, name: person.name, reason, mailboxes: held.suspended, sessionsRevoked },
        meta: {
          ...shared,
          mailboxesSuspended: held.suspended,
          sessionsRevoked,
          internalNote: note,
          ...(held.catchAllOff.length > 0 ? { catchAllOff: held.catchAllOff } : {}),
        },
        copies,
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** Lifts a person's suspension: they can sign in again and the mailboxes it suspended resume. 409 if not suspended. */
export async function liftPersonSuspension(
  deps: Deps,
  actor: Actor,
  userId: string,
  session: Session,
  req: RequestMeta,
): Promise<PersonSuspensionResult> {
  const spec = { action: "trust.unsuspended", target: { type: "user" } } as const;
  const person = await knownOr404(deps, actor, req, spec, (r) => r.suspensions.personInfo(userId), isUserId(userId));
  const label = maskEmail(person.email);
  const out = await mutation(
    deps,
    actor,
    req,
    { ...spec, permission: "platform.account.suspend", accountId: null, target: { type: "user", id: userId, label } },
    async (repos): Promise<MutationOutcome<PersonSuspensionResult | Refusal>> => {
      const refusal = await staffChecks(deps, repos, actor, session);
      if (refusal) return { result: refusal, denied: { code: refusal } };
      const current = await repos.suspensions.person(userId);
      if (!current) throw new ConflictError("This person isn't suspended.");
      await repos.suspensions.setPerson(userId, null);
      const released = await releaseMailboxes(deps, repos, await repos.suspensions.mailboxesOf(userId), "person");
      const meta = {
        reason: reasonLabel(current.reason),
        reasonCategory: current.reason,
        mailboxesResumed: released.resumed,
        mailboxesStillHeld: released.stillHeld,
      };
      const copies = (await repos.access.memberships(userId)).map((m) => ({ accountId: m.accountId, meta }));
      return {
        result: {
          email: person.email,
          name: person.name,
          reason: current.reason,
          mailboxes: released.resumed,
          sessionsRevoked: 0,
        },
        meta,
        copies,
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** What the customer's notice page shows: the reason category and when. Any member of the account may read it. */
export async function accountSuspensionNotice(
  deps: Deps,
  actor: Actor,
  accountId: string,
): Promise<{ reason: SuspensionReason; reasonLabel: string; since: Date } | null> {
  if (actor.kind !== "user" || !actor.memberships.some((m) => m.accountId === accountId)) {
    authorize(actor, "account.read", accountId); // 401 / 404, never confirming the account
    throw new NotFoundError();
  }
  const s = await deps.uow.run((r) => r.suspensions.account(accountId));
  return s ? { reason: s.reason, reasonLabel: reasonLabel(s.reason), since: s.at } : null;
}

/** Staff view of an account's suspension (with the internal note), for the Platform → account page. */
export async function staffSuspensionView(
  deps: Deps,
  actor: Actor,
  accountId: string,
): Promise<{
  account: (SuspensionRecord & { reasonLabel: string }) | null;
  people: Record<string, SuspensionRecord & { reasonLabel: string }>;
}> {
  authorize(actor, "platform.accounts.read");
  if (!isId(accountId)) throw new NotFoundError();
  return deps.uow.run(async (r) => {
    const account = await r.suspensions.account(accountId);
    const people: Record<string, SuspensionRecord & { reasonLabel: string }> = {};
    for (const m of await r.access.members(accountId)) {
      const p = await r.suspensions.person(m.userId);
      if (p) people[m.userId] = { ...p, reasonLabel: reasonLabel(p.reason) };
    }
    return { account: account ? { ...account, reasonLabel: reasonLabel(account.reason) } : null, people };
  });
}
