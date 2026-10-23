// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { accountRoleCan } from "@anhourmail/shared/rbac";
import { APP_PASSWORDS_PER_MAILBOX, type AppPasswordProtocol } from "@anhourmail/shared/security";

import { type Actor, authorize, can } from "../actor";
import { ConflictError, ForbiddenError, NotFoundError, PlanLimitError, StepUpRequiredError } from "../errors";
import type { Mailbox, MailboxStatus } from "../mailboxes/entity";
import { lifecycleLocked } from "../mailboxes/service";
import { mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { type AppPassword, appPasswordName, appPasswordProtocols, type AppPasswordStatus } from "./entity";
import type { AppPasswordInventory, AppPasswordIssuer } from "./ports";

/** What the console shows: never the mail server's ids, and never a secret. */
export type AppPasswordView = {
  id: string;
  name: string;
  protocols: AppPasswordProtocol[];
  status: AppPasswordStatus;
  createdAt: Date;
};

export type MailboxAppPasswords = {
  mailboxId: string;
  address: string;
  mailboxStatus: MailboxStatus;
  appPasswords: AppPasswordView[];
  /** A new one can be made now: the mailbox is active on the mail server and below the limit. */
  canCreate: boolean;
  /** The viewer may revoke them (their own mailbox, or one they manage). */
  canRevoke: boolean;
  limit: number;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const view = (p: AppPassword): AppPasswordView => ({
  id: p.id,
  name: p.name,
  protocols: [...p.protocols],
  status: p.status,
  createdAt: p.createdAt,
});

async function scopedMailbox(repos: Repositories, accountId: string, id: string): Promise<Mailbox> {
  const m = isId(id) ? await repos.mailboxes.get(accountId, id) : null;
  if (!m) throw new NotFoundError();
  return m;
}

const ownedBy = (actor: Actor, m: Mailbox): boolean => actor.kind === "user" && m.userId === actor.userId;

const creatable = (m: Mailbox, count: number): boolean =>
  m.status === "active" && m.stalwartId !== null && count < APP_PASSWORDS_PER_MAILBOX;

async function summary(
  repos: Repositories,
  m: Mailbox,
  canRevoke: boolean,
  own: boolean,
): Promise<MailboxAppPasswords> {
  const list = await repos.appPasswords.listByMailbox(m.id);
  return {
    mailboxId: m.id,
    address: m.address,
    mailboxStatus: m.status,
    appPasswords: list.map(view),
    canCreate: own && creatable(m, list.length),
    canRevoke,
    limit: APP_PASSWORDS_PER_MAILBOX,
  };
}

/** The person's own mailboxes in this account, each with its app passwords (`app_password.manage.own`). */
export async function listMyAppPasswords(deps: Deps, actor: Actor, accountId: string): Promise<MailboxAppPasswords[]> {
  authorize(actor, "app_password.manage.own", accountId);
  return deps.uow.run(async (r) => {
    const mine = (await r.mailboxes.listByAccount(accountId)).filter((m) => ownedBy(actor, m));
    const out: MailboxAppPasswords[] = [];
    for (const m of mine) out.push(await summary(r, m, true, true));
    return out;
  });
}

/**
 * One mailbox's app passwords for people who can see mailboxes (`mailbox.read`): names and dates only. Revoking is
 * offered to its owner and to people who manage it (an Owner's or admin's mailbox: Owners only, as for suspending).
 */
export async function listMailboxAppPasswords(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
): Promise<MailboxAppPasswords> {
  authorize(actor, "mailbox.read", accountId);
  return deps.uow.run(async (r) => {
    const m = await scopedMailbox(r, accountId, mailboxId);
    const own = ownedBy(actor, m) && can(actor, "app_password.manage.own", accountId);
    const manages =
      can(actor, "mailbox.manage", accountId) &&
      !lifecycleLocked(actor, accountId, m, await r.access.members(accountId));
    return summary(r, m, own || manages, own);
  });
}

export type CreatedAppPassword = {
  appPassword: AppPasswordView;
  /** Shown to the person once, never stored or logged by us. */
  secret: string;
  address: string;
};

type Refusal = "forbidden" | "act_as" | "step_up_required";

/**
 * Creates an app password on one of the person's own mailboxes (`app_password.manage.own`). Needs a recent step-up
 * on this console session (`sessionId`), an active mailbox and room under the per-mailbox limit. Never while a staff
 * member acts as the person: an app password opens the mailbox's mail. The mail server makes the secret; it is
 * returned here once and never stored by us. Audited without any secret; refusals are audited as denied.
 */
export async function createAppPassword(
  deps: Deps,
  issuer: AppPasswordIssuer,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  input: { name?: unknown; protocols?: unknown },
  session: { sessionId: string | null },
  req: RequestMeta,
): Promise<CreatedAppPassword> {
  let issued: { externalId: string; credentialId: string; createdAt: Date } | null = null;
  try {
    const out = await mutation(
      deps,
      actor,
      req,
      {
        action: "auth.app_password_created",
        permission: "app_password.manage.own",
        accountId,
        target: { type: "mailbox", id: mailboxId },
      },
      async (repos): Promise<MutationOutcome<CreatedAppPassword | Refusal>> => {
        const m = await scopedMailbox(repos, accountId, mailboxId);
        const refuse = (code: Refusal) => ({ result: code, target: { label: m.address }, denied: { code } });
        if (actor.kind !== "user") throw new ForbiddenError();
        if (!ownedBy(actor, m)) {
          // Someone who can see mailboxes knows this one exists: 403. Anyone else: it doesn't exist for them.
          if (!can(actor, "mailbox.read", accountId)) throw new NotFoundError();
          return refuse("forbidden");
        }
        if (actor.actingAs) return refuse("act_as");
        const name = appPasswordName(input.name);
        const protocols = appPasswordProtocols(input.protocols);
        const now = deps.clock.now();
        if (!session.sessionId || !(await repos.security.stepUpFresh(actor.userId, session.sessionId, now))) {
          return refuse("step_up_required");
        }
        // Serialised with removing people (which revokes their app passwords) and with other creates (the limit), then
        // read again: someone removed from the account or no longer holding the mailbox gets nothing.
        await repos.accounts.lock(accountId);
        const role = (await repos.access.members(accountId)).find((x) => x.userId === actor.userId)?.role;
        const fresh = await repos.mailboxes.get(accountId, m.id);
        if (!role || !accountRoleCan(role, "app_password.manage.own") || !fresh || !ownedBy(actor, fresh)) {
          throw new NotFoundError();
        }
        if (fresh.status !== "active" || fresh.stalwartId === null) {
          throw new ConflictError(
            fresh.status === "suspended" || fresh.status === "deleting"
              ? "This mailbox is suspended or being deleted, so it can't have new app passwords."
              : "This mailbox isn't ready yet. Try again in a minute.",
          );
        }
        if ((await repos.appPasswords.listByMailbox(m.id)).length >= APP_PASSWORDS_PER_MAILBOX) {
          throw new PlanLimitError(
            `A mailbox can have up to ${String(APP_PASSWORDS_PER_MAILBOX)} app passwords. Revoke one you no longer use first.`,
          );
        }
        const made = await issuer.create({ externalId: fresh.stalwartId, name, protocols });
        issued = { externalId: fresh.stalwartId, credentialId: made.credentialId, createdAt: made.createdAt };
        const row: AppPassword = {
          id: randomUUID(),
          accountId,
          mailboxId: m.id,
          name,
          protocols,
          credentialId: made.credentialId,
          credentialCreatedAt: made.createdAt,
          createdAt: now,
          createdBy: actor.userId,
          status: "active",
        };
        await repos.appPasswords.insert(row);
        return {
          result: { appPassword: view(row), secret: made.secret, address: m.address },
          target: { label: m.address },
          meta: { name, protocols },
        };
      },
    );
    if (out === "step_up_required") throw new StepUpRequiredError();
    if (out === "act_as") throw new ForbiddenError("App passwords can't be created while acting as someone.");
    if (out === "forbidden")
      throw new ForbiddenError("Only the person a mailbox belongs to can create its app passwords.");
    return out;
  } catch (err) {
    // The mail server made it but the record didn't save: take it off again, so no credential exists that the
    // console can't show or revoke.
    const made = issued as { externalId: string; credentialId: string; createdAt: Date } | null;
    if (made) await issuer.revoke(made).catch(() => undefined);
    throw err;
  }
}

/**
 * Revokes one app password (`appPasswordId`) or all of a mailbox's (`null`). Its owner may (`app_password.manage.own`);
 * so may people who manage mailboxes (`mailbox.manage`; an Owner's or admin's mailbox: Owners only). The worker
 * removes them from the mail server; they show as revoking until then, and revoking again re-queues it. Audited,
 * refusals too.
 */
export async function revokeAppPasswords(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  appPasswordId: string | null,
  req: RequestMeta,
): Promise<{ revoked: number }> {
  const manages = can(actor, "mailbox.manage", accountId);
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "auth.app_password_revoked",
      permission: manages ? "mailbox.manage" : "app_password.manage.own",
      accountId,
      target: { type: "mailbox", id: mailboxId },
    },
    async (repos): Promise<MutationOutcome<{ revoked: number } | "not_yours" | "locked">> => {
      const m = await scopedMailbox(repos, accountId, mailboxId);
      if (!ownedBy(actor, m)) {
        if (!manages) {
          if (!can(actor, "mailbox.read", accountId)) throw new NotFoundError();
          return { result: "not_yours", target: { label: m.address }, denied: { code: "forbidden" } };
        }
        if (lifecycleLocked(actor, accountId, m, await repos.access.members(accountId))) {
          return { result: "locked", target: { label: m.address }, denied: { code: "forbidden" } };
        }
      }
      let name: string | null = null;
      let retry = false;
      if (appPasswordId !== null) {
        const one = isId(appPasswordId) ? await repos.appPasswords.get(m.id, appPasswordId) : null;
        if (!one) throw new NotFoundError();
        name = one.name;
        // Already being revoked: asking again re-queues the worker (e.g. after its job gave up).
        retry = one.status === "revoking";
      }
      const moved = await repos.appPasswords.markRevoking(m.id, appPasswordId);
      if ((await repos.appPasswords.revoking(m.id)).length > 0) {
        await repos.provisioning.enqueue({ kind: "app_password.revoke", subjectId: m.id, runAfter: deps.clock.now() });
      }
      return {
        result: { revoked: moved.length },
        target: { label: m.address },
        meta: appPasswordId === null ? { all: true, count: moved.length } : { name, ...(retry ? { retry } : {}) },
      };
    },
  );
  if (out === "not_yours") throw new ForbiddenError("You can revoke app passwords only on your own mailboxes.");
  if (out === "locked") {
    throw new ForbiddenError(
      "Only an owner can revoke app passwords on a mailbox that belongs to an owner or an admin.",
    );
  }
  return out;
}

export type AppPasswordDrift = {
  /** Mailboxes whose `revoking` app passwords were queued again (their revoke job gave up). */
  requeued: number;
  /** Mailboxes with revocations in flight (a job queued or running): expected, not drift. */
  revokingInFlight: number;
  /** App passwords on the mail server with no row here: made outside the console, or a row lost. */
  unknownOnMailServer: number;
  /** App passwords whose permissions aren't exactly what their row's protocols give (or no value we make). */
  unexpectedPermissions: number;
  /** Active rows the mail server no longer has (e.g. a credential list replaced by hand). */
  missingOnMailServer: number;
  /** API keys on customer mailboxes: end users never get one. */
  apiKeys: number;
  /**
   * Mailboxes without exactly one sign-in Password credential: 0 means it was replaced oddly, >1 (Stalwart refuses a
   * second through our client, so this is a direct-access write) means a password was added by hand — a way to sign
   * in as the mailbox or, with `impersonate`, master-user into it over the mail ports.
   */
  extraPasswords: number;
  /**
   * Mailboxes whose one Password credential isn't the one the control plane set (a different credential id): the
   * password was replaced outside the console, the webmail and the worker. Not counted while a new password is
   * waiting for the worker. Stalwart keeps the id across some replacements, so this catches many, not all (07-security
   * "Mailbox passwords").
   */
  passwordReplaced: number;
  /** Mailboxes whose Password credential was never recorded (from before tracking; `job:mailbox-backfill` records). */
  passwordUntracked: number;
  /** Mailboxes whose credentials the mail server couldn't list. */
  unreachable: number;
  /** Addresses with drift (returned to the caller; never logged or audited). */
  addresses: string[];
  clean: boolean;
};

const RECONCILER = { kind: "system", name: "reconcile" } as const;
const sameTime = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) < 1000;

/**
 * Reconciler (CLAUDE.md rule 26): re-queues revocations that are still pending (a job that gave up is retried), then
 * compares every mailbox's app passwords and API keys on the mail server with ours. Reports and audits drift as
 * `platform.reconciler_drift` (counts only); never revokes or deletes anything by itself.
 */
export async function reconcileAppPasswords(deps: Deps, inventory: AppPasswordInventory): Promise<AppPasswordDrift> {
  const revoking = await deps.uow.run((r) => r.appPasswords.mailboxesWithRevoking());
  // Revocations with a job queued or running are in flight, not drift; the rest (their job gave up) are queued again.
  const pending = revoking.filter((x) => !x.jobOpen).map((x) => x.mailboxId);
  const mailboxes = await deps.uow.run((r) => r.appPasswords.mailboxesOnServer());
  const out: AppPasswordDrift = {
    requeued: 0,
    revokingInFlight: 0,
    unknownOnMailServer: 0,
    unexpectedPermissions: 0,
    missingOnMailServer: 0,
    apiKeys: 0,
    extraPasswords: 0,
    passwordReplaced: 0,
    passwordUntracked: 0,
    unreachable: 0,
    addresses: [],
    clean: true,
  };
  for (const m of mailboxes) {
    const rows = await deps.uow.run((r) => r.appPasswords.listByMailbox(m.id));
    // One mailbox the mail server can't answer for (e.g. its account removed by hand) doesn't stop the rest.
    const onServer = await inventory.list(m.stalwartId).catch(() => null);
    if (!onServer) {
      out.unreachable += 1;
      out.addresses.push(m.address);
      continue;
    }
    let drift = false;
    for (const c of onServer.appPasswords) {
      const row = rows.find((x) => x.credentialId === c.credentialId && sameTime(x.credentialCreatedAt, c.createdAt));
      if (!row) {
        out.unknownOnMailServer += 1;
        drift = true;
      } else if (c.protocols?.join(",") !== row.protocols.join(",")) {
        out.unexpectedPermissions += 1;
        drift = true;
      }
    }
    for (const row of rows.filter((x) => x.status === "active")) {
      const found = onServer.appPasswords.some(
        (c) => c.credentialId === row.credentialId && sameTime(c.createdAt, row.credentialCreatedAt),
      );
      if (!found) {
        out.missingOnMailServer += 1;
        drift = true;
      }
    }
    if (onServer.apiKeys > 0) {
      out.apiKeys += onServer.apiKeys;
      drift = true;
    }
    if (onServer.passwords !== 1) {
      out.extraPasswords += 1;
      drift = true;
    } else if (!m.passwordPending) {
      // A reset or change in flight is expected to change it; otherwise it must be the one we set (report only).
      if (m.passwordCredentialId === null) {
        out.passwordUntracked += 1;
        drift = true;
      } else if (onServer.passwordIds[0] !== m.passwordCredentialId) {
        out.passwordReplaced += 1;
        drift = true;
      }
    }
    if (drift) out.addresses.push(m.address);
  }
  out.requeued = pending.length;
  out.revokingInFlight = revoking.length - pending.length;
  out.clean =
    out.unknownOnMailServer +
      out.unexpectedPermissions +
      out.missingOnMailServer +
      out.apiKeys +
      out.extraPasswords +
      out.passwordReplaced +
      out.passwordUntracked +
      out.unreachable +
      out.requeued ===
    0;
  if (!out.clean) {
    const now = deps.clock.now();
    await mutation(
      deps,
      RECONCILER,
      { requestId: `reconcile-app-passwords-${String(now.getTime())}`, ip: null, userAgent: null },
      {
        action: "platform.reconciler_drift",
        permission: "self.profile.read",
        accountId: null,
        target: { type: "mail_server", label: "app passwords" },
      },
      async (repos) => {
        // Retry pending revocations through the normal job, in the same unit of work as the audit entry.
        for (const id of pending) {
          await repos.provisioning.enqueue({ kind: "app_password.revoke", subjectId: id, runAfter: now });
        }
        return {
          result: undefined,
          meta: {
            appPasswordRevocationsRequeued: out.requeued,
            unknownAppPasswords: out.unknownOnMailServer,
            unexpectedAppPasswordPermissions: out.unexpectedPermissions,
            missingAppPasswords: out.missingOnMailServer,
            apiKeysOnMailboxes: out.apiKeys,
            mailboxesWithExtraPasswords: out.extraPasswords,
            mailboxPasswordsReplaced: out.passwordReplaced,
            mailboxPasswordsUntracked: out.passwordUntracked,
            mailboxesUnreachable: out.unreachable,
          },
        };
      },
    );
  }
  return out;
}
