// SPDX-License-Identifier: AGPL-3.0-only
import { DELEGATED_MAILBOXES_PER_PERSON, DELEGATES_PER_MAILBOX, PLANS } from "@anhourmail/shared/plans";

import { type Actor, can } from "../actor";
import { ConflictError, NotFoundError, PlanLimitError } from "../errors";
import { lifecycleLocked } from "../mailboxes/service";
import type { Mailbox } from "../mailboxes/entity";
import type { AuditAlso } from "../mutation";
import type { MemberRecord } from "../people/entity";
import type { Repositories } from "../ports";
import { type DelegationGrantReason, delegationEntry } from "./cascade";
import type { DelegationRight } from "./entity";

/** One person and one right on the mailbox being changed. */
export type DelegationRequest = { userId: string; right: DelegationRight };

/**
 * Whether the actor may add or remove people on this mailbox's lists (ADR-0026 §4): `delegation.manage.any` (Owner,
 * User Administrator), never while acting as someone, and guard rail 8 — an Owner's or another administrator's mailbox
 * takes an Owner (`lifecycleLocked`, the same rule as suspending it or setting its password).
 */
export function mayDelegate(
  actor: Actor,
  accountId: string,
  mailbox: Mailbox,
  members: readonly { userId: string; role: string }[],
): boolean {
  if (actor.kind !== "user" || actor.actingAs) return false;
  return can(actor, "delegation.manage.any", accountId) && !lifecycleLocked(actor, accountId, mailbox, members);
}

/** The account's plan includes delegation (`Plan.delegation`), else 403 `plan_limit`. */
export async function assertDelegationPlan(repos: Repositories, accountId: string): Promise<void> {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  const plan = PLANS[account.plan];
  if (!plan.delegation) {
    throw new PlanLimitError(
      `The ${plan.name} plan doesn't include giving people access to other mailboxes. Upgrade to use delegation.`,
    );
  }
}

export type AppliedDelegation = { granted: number; revoked: number; also: AuditAlso[] };

/**
 * Applies removes, then adds, to one mailbox's lists inside the caller's unit of work, and returns one audit entry per
 * change that happened (adding a right someone holds, or removing one they don't, changes nothing and records nothing).
 * The caller has checked permission, guard rail 8, the plan and the step-up, and holds the account lock. Refused:
 * a person who isn't a member of the account (404, never confirming anyone outside it), the mailbox's own person (409),
 * and going over `DELEGATES_PER_MAILBOX` people on the mailbox or `DELEGATED_MAILBOXES_PER_PERSON` mailboxes for a
 * person (409). A throw rolls everything back.
 */
export async function applyDelegationChanges(
  repos: Repositories,
  ctx: {
    accountId: string;
    mailbox: Pick<Mailbox, "id" | "address" | "userId">;
    members: readonly MemberRecord[];
    grantedBy: string | null;
    now: Date;
    reason: DelegationGrantReason;
  },
  changes: { add: readonly DelegationRequest[]; remove: readonly DelegationRequest[] },
): Promise<AppliedDelegation> {
  const { accountId, mailbox } = ctx;
  const people = new Map(ctx.members.map((m) => [m.userId, m] as const));
  for (const c of [...changes.add, ...changes.remove]) {
    if (!people.has(c.userId)) throw new NotFoundError("That person isn't in this account.");
  }
  for (const c of changes.add) {
    if (c.userId === mailbox.userId) {
      throw new ConflictError(
        `${people.get(c.userId)?.name ?? "That person"} already owns this mailbox, so they can't be a delegate of it.`,
      );
    }
  }
  const note = (c: DelegationRequest) => ({
    mailboxId: mailbox.id,
    address: mailbox.address,
    granteeUserId: c.userId,
    granteeEmail: people.get(c.userId)?.email ?? null,
    right: c.right,
  });
  const also: AuditAlso[] = [];
  let revoked = 0;
  for (const c of changes.remove) {
    if (await repos.delegation.revoke(accountId, mailbox.id, c.userId, c.right)) {
      revoked += 1;
      also.push(delegationEntry("delegation.revoked", note(c), "admin"));
    }
  }
  const newcomers = new Set<string>();
  for (const c of changes.add) {
    const added = await repos.delegation.grant({
      accountId,
      mailboxId: mailbox.id,
      granteeUserId: c.userId,
      right: c.right,
      grantedBy: ctx.grantedBy,
      at: ctx.now,
    });
    if (added) {
      newcomers.add(c.userId);
      also.push(delegationEntry("delegation.granted", note(c), ctx.reason));
    }
  }
  if (newcomers.size > 0) {
    const onMailbox = new Set(
      (await repos.delegation.listForMailbox(accountId, mailbox.id)).map((g) => g.granteeUserId),
    );
    if (onMailbox.size > DELEGATES_PER_MAILBOX) {
      throw new ConflictError(
        `A mailbox can have up to ${String(DELEGATES_PER_MAILBOX)} people who can open or send from it. Remove someone first.`,
      );
    }
    for (const userId of newcomers) {
      const theirs = new Set((await repos.delegation.listForGrantee(accountId, userId)).map((g) => g.mailboxId));
      if (theirs.size > DELEGATED_MAILBOXES_PER_PERSON) {
        throw new ConflictError(
          `${people.get(userId)?.name ?? "That person"} can already open or send from ${String(DELEGATED_MAILBOXES_PER_PERSON)} mailboxes, the most one person can.`,
        );
      }
    }
  }
  return { granted: also.length - revoked, revoked, also };
}
