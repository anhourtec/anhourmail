// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { MAX_MAILBOXES, PLANS } from "@anhourmail/shared/plans";

import { type Actor, authorize } from "../actor";
import { maskEmail } from "../audit/record";
import { ConflictError, NotFoundError, PlanLimitError, ValidationError } from "../errors";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { GB, type Mailbox, type MailboxStatus, normaliseLocalPart } from "./entity";

/** What the console and API show; mail-server ids and errors stay server-side. */
export type MailboxView = {
  id: string;
  address: string;
  status: MailboxStatus;
  quotaBytes: number;
  owner: { userId: string; email: string } | null;
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
    createdAt: m.createdAt,
  }));
}

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
): Promise<MailboxView & { maxQuotaBytes: number }> {
  authorize(actor, "mailbox.read", accountId);
  return deps.uow.run(async (r) => {
    const [v] = await views(r, accountId, [await scoped(r, accountId, id)]);
    if (!v) throw new NotFoundError();
    return { ...v, maxQuotaBytes: await planQuota(r, accountId) };
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
