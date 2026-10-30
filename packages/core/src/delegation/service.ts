// SPDX-License-Identifier: AGPL-3.0-only
import { DELEGATION_RIGHTS, delegationUpdateSchema, firstIssue } from "@anhourmail/shared/delegation";

import { type Actor, authorize } from "../actor";
import { ConflictError, ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { mutation, type MutationOutcome } from "../mutation";
import type { MemberRecord } from "../people/entity";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { DelegationGrant, DelegationRight } from "./entity";
import { applyDelegationChanges, assertDelegationPlan, mayDelegate } from "./grants";

/**
 * Mailbox delegation in the console (ADR-0026): a mailbox's three lists — read and manage (`full_access`), send as,
 * send on behalf — read with `delegation.read` and changed with `delegation.manage.any`. The service checks everything
 * itself (rules 5, 25): the mailbox is in the account (404), guard rail 8 (an Owner's or another admin's mailbox needs
 * an Owner, 403 audited), never while acting as someone (403), the plan, a fresh step-up, and the grant rules in
 * `applyDelegationChanges`. A grant changes nothing on the mail server, so it works once it commits.
 */

/** A person on one of the lists, as the console shows them. */
export type DelegatePerson = { userId: string; name: string; email: string };

export type MailboxDelegation = {
  mailboxId: string;
  address: string;
  fullAccess: DelegatePerson[];
  sendAs: DelegatePerson[];
  sendOnBehalf: DelegatePerson[];
  /** The viewer may change the lists (the console shows the controls only then; the server checks again). */
  canManage: boolean;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function scopedMailbox(repos: Repositories, accountId: string, id: string): Promise<Mailbox> {
  const m = isId(id) ? await repos.mailboxes.get(accountId, id) : null;
  if (!m) throw new NotFoundError();
  return m;
}

const LIST_OF: Record<DelegationRight, "fullAccess" | "sendAs" | "sendOnBehalf"> = {
  full_access: "fullAccess",
  send_as: "sendAs",
  send_on_behalf: "sendOnBehalf",
};

function viewOf(
  actor: Actor,
  accountId: string,
  m: Mailbox,
  grants: readonly DelegationGrant[],
  members: readonly MemberRecord[],
): MailboxDelegation {
  const people = new Map(members.map((p) => [p.userId, p] as const));
  const out: MailboxDelegation = {
    mailboxId: m.id,
    address: m.address,
    fullAccess: [],
    sendAs: [],
    sendOnBehalf: [],
    canManage: mayDelegate(actor, accountId, m, members),
  };
  for (const g of grants) {
    const p = people.get(g.granteeUserId);
    if (p) out[LIST_OF[g.right]].push({ userId: p.userId, name: p.name, email: p.email });
  }
  return out;
}

/** A mailbox's Delegation tab (`delegation.read`): who can read and manage, send as, and send on behalf of it. */
export async function getMailboxDelegation(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
): Promise<MailboxDelegation> {
  authorize(actor, "delegation.read", accountId);
  return deps.uow.run(async (r) => {
    const m = await scopedMailbox(r, accountId, mailboxId);
    return viewOf(
      actor,
      accountId,
      m,
      await r.delegation.listForMailbox(accountId, m.id),
      await r.people.list(accountId),
    );
  });
}

/** One mailbox a person can open or send from, with their rights on it (People panel, `delegation.read`). */
export type PersonDelegation = { mailboxId: string; address: string; rights: DelegationRight[] };

/** "Mailboxes they can open" on a person's panel (`delegation.read`); someone outside the account is 404. */
export async function listPersonDelegations(
  deps: Deps,
  actor: Actor,
  accountId: string,
  userId: string,
): Promise<PersonDelegation[]> {
  authorize(actor, "delegation.read", accountId);
  return deps.uow.run(async (r) => {
    if (userId.length > 200 || !(await r.people.list(accountId)).some((p) => p.userId === userId)) {
      throw new NotFoundError();
    }
    const addresses = new Map((await r.mailboxes.listByAccount(accountId)).map((m) => [m.id, m.address] as const));
    const byMailbox = new Map<string, PersonDelegation>();
    for (const g of await r.delegation.listForGrantee(accountId, userId)) {
      const address = addresses.get(g.mailboxId);
      if (address === undefined) continue;
      const row = byMailbox.get(g.mailboxId) ?? { mailboxId: g.mailboxId, address, rights: [] };
      row.rights.push(g.right);
      byMailbox.set(g.mailboxId, row);
    }
    return [...byMailbox.values()]
      .map((row) => ({ ...row, rights: DELEGATION_RIGHTS.filter((x) => row.rights.includes(x)) }))
      .sort((a, b) => a.address.localeCompare(b.address));
  });
}

type Refusal = "act_as" | "locked" | "step_up_required";

/**
 * Adds and removes people on a mailbox's three lists in one batch (`delegation.manage.any`): one unit of work, one audit
 * entry per change (`delegation.granted` / `delegation.revoked`, reason `admin`; the first change is the main entry).
 * Order of checks: acting as someone (403 `act_as`, before anything is looked up), the request's shape (400), the
 * mailbox (404), guard rail 8 (403), the plan (403 `plan_limit`), a mailbox being deleted (409), a fresh step-up on this
 * console session (403 `step_up_required`), then the grant rules (404 a person outside the account; 409 the mailbox's
 * own person, the limits). Refusals are audited as denied. Returns the lists as they now are.
 */
export async function updateMailboxDelegation(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  input: unknown,
  session: { sessionId: string | null },
  req: RequestMeta,
): Promise<MailboxDelegation> {
  const parsed = delegationUpdateSchema.safeParse(input);
  const action = parsed.success && parsed.data.add.length === 0 ? "delegation.revoked" : "delegation.granted";
  const out = await mutation(
    deps,
    actor,
    req,
    { action, permission: "delegation.manage.any", accountId, target: { type: "mailbox", id: mailboxId } },
    async (repos): Promise<MutationOutcome<MailboxDelegation | Refusal>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
      // Lock first, then read: the mailbox's status and person and everyone's roles are read under the account lock, so
      // a concurrent deletion, removal or role change either lands before these reads or waits for this batch.
      await repos.accounts.lock(accountId);
      const m = await scopedMailbox(repos, accountId, mailboxId);
      const refuse = (code: Refusal) => ({
        result: code,
        target: { label: m.address },
        denied: { code: code === "locked" ? "forbidden" : code },
      });
      const members = await repos.people.list(accountId);
      if (!mayDelegate(actor, accountId, m, members)) return refuse("locked");
      await assertDelegationPlan(repos, accountId);
      if (m.status === "deleting") throw new ConflictError("This mailbox is being deleted. Restore it first.");
      if (
        !session.sessionId ||
        !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))
      ) {
        return refuse("step_up_required");
      }
      const applied = await applyDelegationChanges(
        repos,
        {
          accountId,
          mailbox: m,
          members,
          grantedBy: actor.userId,
          now: deps.clock.now(),
          reason: "admin",
        },
        parsed.data,
      );
      const view = viewOf(actor, accountId, m, await repos.delegation.listForMailbox(accountId, m.id), members);
      // The main entry carries the first change of the main action; every other change is its own entry after it.
      // A batch with none of the main action (nothing changed, or only the other kind did) records the counts instead.
      const main = applied.also.findIndex((e) => e.action === action);
      const first = applied.also[main];
      if (!first) {
        return {
          result: view,
          target: { label: m.address },
          meta: { mailboxId: m.id, granted: applied.granted, revoked: applied.revoked },
          also: applied.also,
        };
      }
      return {
        result: view,
        target: { label: first.target.label ?? m.address },
        meta: { ...first.meta, changes: applied.also.length },
        also: applied.also.filter((_, i) => i !== main),
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Delegation can't be changed while acting as someone.");
  if (out === "locked") {
    throw new ForbiddenError("Only an owner can give access to a mailbox that belongs to an owner or an admin.");
  }
  if (out === "step_up_required") throw new StepUpRequiredError();
  return out;
}
