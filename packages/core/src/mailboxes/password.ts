// SPDX-License-Identifier: AGPL-3.0-only
import { type Actor, can } from "../actor";
import { maskEmail } from "../audit/record";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PasswordChangePendingError,
  StepUpRequiredError,
} from "../errors";
import { mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { BreachedPasswordError, passwordBreached } from "../security/breached-passwords";
import type { Mailbox } from "./entity";
import { hashMailboxPassword, mailboxPassword, type PasswordHasher } from "./password-hash";
import { lifecycleLocked } from "./service";

/**
 * Mailbox passwords (docs/internal/07-security.md "Mailbox passwords"). The password a person chooses is checked and
 * hashed here at once, to a salted argon2id PHC string (rule 23); only that hash is kept, and only until the worker has
 * given it to the mail server (`mailbox.password` / `mailbox.ensure`). The password itself is never stored, queued,
 * logged or audited.
 */

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** A mailbox that can take a new password now: on the mail server, and not being deleted. */
function assertSettable(m: Mailbox): void {
  if (m.status === "deleting") throw new ConflictError("This mailbox is being deleted. Restore it first.");
  if (m.stalwartId === null || (m.status !== "active" && m.status !== "suspended")) {
    throw new ConflictError("This mailbox isn't ready yet. Try again in a minute.");
  }
}

/**
 * Hashes the password and queues the worker with it for an existing account (same unit of work as the caller's audit
 * entry), with the grant the management proxy needs to accept the replacement (bound to this account and hash).
 */
async function queuePassword(
  deps: Deps,
  repos: Repositories,
  hasher: PasswordHasher,
  m: Mailbox,
  password: string,
  byOwner = false,
) {
  const phc = await hashMailboxPassword(hasher, password);
  const grant =
    m.stalwartId === null ? null : (hasher.grant?.({ externalId: m.stalwartId, passwordHash: phc }) ?? null);
  await repos.mailboxPasswords.setPending(m.id, phc, grant, { byOwner });
  return repos.provisioning.enqueue({ kind: "mailbox.password", subjectId: m.id, runAfter: deps.clock.now() });
}

export type MailboxPasswordReset = {
  address: string;
  /** The person the mailbox belongs to (to notify them), when it belongs to someone. */
  owner: { userId: string; email: string } | null;
  /** The provisioning job that applies it. */
  jobId: string;
};

type Refusal = "locked" | "act_as" | "step_up_required";

/**
 * Sets a new password on a mailbox in the account (`mailbox.password.reset`): an admin's reset, for the person who
 * forgot theirs or a mailbox handed to someone new. Needs a recent step-up on this console session; refused during a
 * staff act-as session (a password opens the mailbox's mail, so staff never choose one for a customer); an Owner's or
 * an admin's mailbox needs an Owner, as for suspending it. The worker applies it with the provisioning key; the
 * mailbox's webmail sessions end (the mail server revokes their tokens) and its app passwords keep working. Audited
 * as `mailbox.password_reset` without any secret; refusals are audited as denied.
 */
export async function resetMailboxPassword(
  deps: Deps,
  hasher: PasswordHasher,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  input: { password?: unknown },
  session: { sessionId: string | null },
  req: RequestMeta,
): Promise<MailboxPasswordReset> {
  // Asked before the unit of work (a network lookup never holds a lock), and only for someone who may reset passwords
  // in this account; the answer is used once the password has passed the rules.
  const breached =
    can(actor, "mailbox.password.reset", accountId) && (await passwordBreached(hasher.breaches, input.password));
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "mailbox.password_reset",
      permission: "mailbox.password.reset",
      accountId,
      target: { type: "mailbox", id: mailboxId },
    },
    async (repos): Promise<MutationOutcome<MailboxPasswordReset | Refusal>> => {
      const m = isId(mailboxId) ? await repos.mailboxes.get(accountId, mailboxId) : null;
      if (!m) throw new NotFoundError();
      const refuse = (code: Refusal) => ({
        result: code,
        target: { label: m.address },
        denied: { code: code === "locked" ? "forbidden" : code },
      });
      if (actor.kind !== "user") throw new ForbiddenError();
      const members = await repos.access.members(accountId);
      if (lifecycleLocked(actor, accountId, m, members)) return refuse("locked");
      if (actor.actingAs) return refuse("act_as");
      assertSettable(m);
      const password = mailboxPassword(input.password, m.address);
      if (breached) throw new BreachedPasswordError();
      if (
        !session.sessionId ||
        !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))
      ) {
        return refuse("step_up_required");
      }
      await repos.accounts.lock(accountId); // serialised with the mailbox's own change (`changeOwnMailboxPassword`)
      const job = await queuePassword(deps, repos, hasher, m, password);
      const ownerEmail = m.userId ? (members.find((x) => x.userId === m.userId)?.email ?? null) : null;
      const owner = m.userId && ownerEmail ? { userId: m.userId, email: ownerEmail } : null;
      return {
        result: { address: m.address, owner, jobId: job.id },
        target: { label: m.address },
        meta: {
          ownMailbox: m.userId === actor.userId,
          owner: owner ? maskEmail(owner.email) : null,
          status: m.status,
        },
      };
    },
  );
  if (out === "locked") {
    throw new ForbiddenError("Only an owner can set the password of a mailbox that belongs to an owner or an admin.");
  }
  if (out === "act_as") throw new ForbiddenError("Mailbox passwords can't be set while acting as someone.");
  if (out === "step_up_required") throw new StepUpRequiredError();
  return out;
}

/**
 * The person's own password change from the webmail (the caller is the webmail session of `address`, which has just
 * proved the current password to the mail server). Written as the mailbox itself, in its account's log
 * (`mailbox.password_changed`), like other webmail settings. Only an active mailbox (a suspended one can't use the
 * webmail). Returns the job that applies it, so the caller can wait for it and keep its own session signed in. A
 * first-sign-in password change (`mustChangePassword`) ends only when the worker has applied this password to the mail
 * server (`runNextJob`), never here: until then the administrator's password is still the mailbox's password.
 *
 * Refused (409 `password_change_pending`, audited as denied) while a password an administrator set is still waiting
 * for the mail server, or never reached it: the "current" password proved here is then the one being replaced, so
 * whoever knew it (e.g. everyone who used a shared address that "Make this a user" handed to one person) could
 * otherwise overwrite the administrator's password and lock the new person out (docs/internal/07-security.md).
 */
export async function changeOwnMailboxPassword(
  deps: Deps,
  hasher: PasswordHasher,
  address: string,
  input: { password?: unknown },
  req: RequestMeta,
): Promise<{ jobId: string; ownerEmail: string | null }> {
  const key = address.trim().toLowerCase();
  const found = await deps.uow.run((r) => r.webmailSettings.mailboxByAddress(key));
  if (!found) throw new NotFoundError();
  const actor: Actor = { kind: "system", name: found.address };
  const breached = await passwordBreached(hasher.breaches, input.password); // before the unit of work (no lock held)
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "mailbox.password_changed",
      permission: "mailbox.read",
      accountId: found.accountId,
      target: { type: "mailbox", id: found.id, label: found.address },
    },
    async (repos): Promise<MutationOutcome<{ jobId: string; ownerEmail: string | null } | "pending">> => {
      const m = await repos.mailboxes.get(found.accountId, found.id);
      if (!m) throw new NotFoundError();
      if (m.status !== "active" || m.stalwartId === null) {
        throw new ConflictError("This mailbox can't change its password right now.");
      }
      // Serialised with an administrator setting one (reset, "Make this a user"), so this check can't pass just before
      // their password is recorded and then overwrite it.
      await repos.accounts.lock(m.accountId);
      if (await adminPasswordWaiting(repos, m.id)) {
        return { result: "pending", meta: { by: "self" }, denied: { code: "password_change_pending" } };
      }
      const password = mailboxPassword(input.password, m.address);
      if (breached) throw new BreachedPasswordError();
      const job = await queuePassword(deps, repos, hasher, m, password, true);
      // The person's console identity (if the mailbox belongs to someone) gets the change notice.
      const owner = m.userId
        ? ((await repos.access.members(m.accountId)).find((x) => x.userId === m.userId)?.email ?? null)
        : null;
      return { result: { jobId: job.id, ownerEmail: owner }, meta: { by: "self" } };
    },
  );
  if (out === "pending") throw new PasswordChangePendingError();
  return out;
}

/**
 * A password an administrator set (a reset, "Add a user" or "Make this a user") is waiting for the mail server, or
 * its job gave up and it is kept so the console can ask for it again (`runNextJob`): the mailbox's current password is
 * the one being replaced.
 */
async function adminPasswordWaiting(repos: Repositories, mailboxId: string): Promise<boolean> {
  const state = await repos.directory.getMailbox(mailboxId);
  return state?.pendingPasswordHash != null && !state.pendingPasswordByOwner;
}

/** Where a password job is: still waiting or running, applied, or given up. */
export type PasswordJobState = "pending" | "applied" | "failed";

/** The state of the job a reset or change returned (unknown ids count as failed). */
export async function passwordJobState(deps: Deps, jobId: string): Promise<PasswordJobState> {
  const job = await deps.uow.run((r) => r.provisioning.get(jobId));
  if (job?.kind !== "mailbox.password") return "failed";
  if (job.status === "succeeded") return "applied";
  return job.status === "failed" ? "failed" : "pending";
}

/**
 * For the webmail's first-sign-in step: whether the person's own last password change gave up, so the step can say
 * the previous change didn't go through (the mailbox keeps the password it had, and the step stays). False while an
 * administrator's password is waiting or failed (that is for the administrator to set again; the change itself is
 * refused meanwhile). Read-only; unknown addresses are false.
 */
export async function lastPasswordChangeFailed(deps: Deps, address: string): Promise<boolean> {
  return deps.uow.run(async (r) => {
    const m = await r.webmailSettings.mailboxByAddress(address.trim().toLowerCase());
    if (!m) return false;
    if (await adminPasswordWaiting(r, m.id)) return false;
    return (await r.provisioning.latest("mailbox.password", m.id))?.status === "failed";
  });
}

/**
 * Whether a console password reset for the login `email` must not be sent: the address is a mailbox in this
 * deployment that is between owners — its first-sign-in password change is still required, or a password an
 * administrator set hasn't reached the mail server. The reset email would land in that mailbox, which whoever knew
 * its previous password may still be able to read ("Make this a user" on a shared address; docs/internal/07-security.md
 * "Mailbox passwords"). The person asks an administrator instead, or resets once they've chosen their own mailbox
 * password. Read-only; any other address is false.
 */
export async function consoleResetHeld(deps: Deps, email: string): Promise<boolean> {
  return deps.uow.run(async (r) => {
    const m = await r.webmailSettings.mailboxByAddress(email.trim().toLowerCase());
    if (!m) return false;
    return m.mustChangePassword || (await adminPasswordWaiting(r, m.id));
  });
}
