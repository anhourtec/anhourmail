// SPDX-License-Identifier: AGPL-3.0-only
import { convertToSharedSchema, firstIssue } from "@anhourmail/shared/delegation";

import { type Actor, can } from "../actor";
import { maskEmail } from "../audit/record";
import { applyDelegationChanges, assertDelegationPlan } from "../delegation/grants";
import { ConflictError, ForbiddenError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import { type AuditAlso, mutation, type MutationOutcome } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import type { PasswordHasher } from "./password-hash";
import { releaseMailboxOwner } from "./release";
import { lifecycleLocked, type MailboxView, viewOf } from "./service";

export type ConvertedToShared = {
  mailbox: MailboxView;
  /** Grants written with the conversion (read and manage, and send as when asked, per person). */
  grants: number;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

type Refusal = "act_as" | "locked" | "delegation" | "step_up_required";

/**
 * "Convert to shared mailbox" on a person's mailbox (ADR-0026 §3): the mailbox stays, with its mail, its address and
 * its aliases, but nobody signs in to it any more — the same release a removal does (`releaseMailboxOwner`: the owner
 * link released, a new generated password nobody is shown queued as a `mailbox.password` job with the proxy's grant,
 * its app passwords revoked) — and, optionally, people in the account get read and manage (and send as, with `sendAs`)
 * on it in the same unit of work. The person stays in the account. Back again with "Make this a user".
 *
 * `mailbox.manage` (403 without it, 404 for another account's id or mailbox), never while acting as someone (403), guard
 * rail 8 (an Owner's or another admin's mailbox: Owners only, 403 audited) and a fresh step-up on this console session
 * (403 `step_up_required`): it replaces a password in use. Giving people access needs `delegation.manage.any` and a
 * plan with delegation as well (403 for the whole request), and follows the grant rules (404 a person outside the
 * account; 409 the limits). Refused (409) for a mailbox that is already shared, being deleted, or not on the mail server
 * yet. Audited as `mailbox.converted_to_shared` (meta: the former person's id and masked address, app passwords
 * revoked, grants written) with one `delegation.granted` entry per grant (reason `converted_to_shared`).
 */
export async function convertMailboxToShared(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  input: unknown,
  session: { sessionId: string | null },
  req: RequestMeta,
  hasher: PasswordHasher,
): Promise<ConvertedToShared> {
  const parsed = convertToSharedSchema.safeParse(input ?? {});
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "mailbox.converted_to_shared",
      permission: "mailbox.manage",
      accountId,
      target: { type: "mailbox", id: mailboxId },
    },
    async (repos): Promise<MutationOutcome<ConvertedToShared | Refusal>> => {
      if (actor.kind !== "user") throw new ForbiddenError();
      if (actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      if (!parsed.success) throw new ValidationError(firstIssue(parsed.error));
      // Lock first, then read (serialised with a removal of its person, a role change and other grants): the mailbox's
      // status and person and the members' roles below are the ones this change acts on.
      await repos.accounts.lock(accountId);
      const m = isId(mailboxId) ? await repos.mailboxes.get(accountId, mailboxId) : null;
      if (!m) throw new NotFoundError();
      const refuse = (code: Refusal) => ({
        result: code,
        target: { label: m.address },
        denied: { code: code === "locked" || code === "delegation" ? "forbidden" : code },
      });
      const members = await repos.people.list(accountId);
      if (lifecycleLocked(actor, accountId, m, members)) return refuse("locked");
      const fullAccessTo = [...new Set(parsed.data.fullAccessTo)];
      if (fullAccessTo.length > 0) {
        if (!can(actor, "delegation.manage.any", accountId)) return refuse("delegation");
        await assertDelegationPlan(repos, accountId);
      }
      if (m.userId === null) throw new ConflictError("This mailbox is already a shared mailbox.");
      if (m.status === "deleting") throw new ConflictError("This mailbox is being deleted. Restore it first.");
      if (m.status === "provisioning" || m.stalwartId === null) {
        throw new ConflictError("This mailbox is still being set up on the mail server. Try again in a minute.");
      }
      if (
        !session.sessionId ||
        !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))
      ) {
        return refuse("step_up_required");
      }
      const formerUserId = m.userId;
      const released = await releaseMailboxOwner(deps, repos, hasher, m, formerUserId);
      if (!released)
        throw new ConflictError("This mailbox changed while you were working on it. Reload and try again.");
      let also: AuditAlso[] = [];
      let grants = 0;
      if (fullAccessTo.length > 0) {
        const rights = parsed.data.sendAs ? (["full_access", "send_as"] as const) : (["full_access"] as const);
        const applied = await applyDelegationChanges(
          repos,
          {
            accountId,
            mailbox: { ...m, userId: null },
            members,
            grantedBy: actor.userId,
            now: deps.clock.now(),
            reason: "converted_to_shared",
          },
          { add: fullAccessTo.flatMap((userId) => rights.map((right) => ({ userId, right }))), remove: [] },
        );
        also = applied.also;
        grants = applied.granted;
      }
      const former = members.find((p) => p.userId === formerUserId);
      return {
        result: { mailbox: await viewOf(repos, accountId, { ...m, userId: null, mustChangePassword: false }), grants },
        target: { label: m.address },
        meta: {
          formerUserId,
          ...(former ? { former: maskEmail(former.email) } : {}),
          status: m.status,
          appPasswordsRevoked: released.appPasswordsRevoked,
          grants,
        },
        also,
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Mailboxes can't be converted while acting as someone.");
  if (out === "locked") {
    throw new ForbiddenError("Only an owner can convert a mailbox that belongs to an owner or an admin.");
  }
  if (out === "delegation") throw new ForbiddenError("You can't give people access to this mailbox.");
  if (out === "step_up_required") throw new StepUpRequiredError();
  return out;
}
