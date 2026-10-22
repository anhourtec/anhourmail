// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { ALIAS_CEILING, PLANS, type PlanId } from "@anhourmail/shared/plans";

import { type Actor, authorize, can } from "../actor";
import { ConflictError, NotFoundError, PlanLimitError, ValidationError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { isReservedLocalPart, normaliseLocalPart } from "../mailboxes/entity";
import { assertDomainHeld } from "../mailboxes/service";
import { mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { type AliasKind, type MailAlias, maskedLocalPart, normaliseDescription } from "./entity";

/**
 * Aliases and masked aliases (ADR-0009). Both are extra addresses on one mailbox; the worker syncs a mailbox's
 * aliases to the mail server (`mailbox.ensure`). `alias.manage.any` reaches every mailbox in the account;
 * `alias.manage.own` only the mailboxes that belong to the person — anything else is not found.
 */

export type AliasView = {
  id: string;
  address: string;
  kind: AliasKind;
  enabled: boolean;
  description: string | null;
  /** `deleting`: the mailbox is in its deletion grace period, so this alias is off on the mail server. */
  mailbox: { id: string; address: string; deleting: boolean };
  createdAt: Date;
};

export type AliasOverview = {
  aliases: AliasView[];
  /** Mailboxes the person can point an alias at (not ones being deleted). */
  mailboxes: { id: string; address: string }[];
  /** The account's active domains (chosen aliases can use any of them). */
  domains: { id: string; name: string }[];
  /** `max` is null when the plan lists it as unlimited (the abuse ceiling still applies). */
  limits: Record<AliasKind, { used: number; max: number | null }>;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

const ACTIONS = {
  alias: { created: "alias.created", toggled: "alias.toggled", deleted: "alias.deleted" },
  masked: { created: "masked_alias.created", toggled: "masked_alias.toggled", deleted: "masked_alias.deleted" },
} as const;

const KIND_LABEL: Record<AliasKind, string> = { alias: "aliases", masked: "masked aliases" };

/** Mailboxes this actor may manage aliases for. */
async function reachable(repos: Repositories, actor: Actor, accountId: string): Promise<Mailbox[]> {
  const all = await repos.mailboxes.listByAccount(accountId);
  if (can(actor, "alias.manage.any", accountId)) return all;
  const self = actor.kind === "user" ? actor.userId : null;
  return all.filter((m) => self !== null && m.userId === self);
}

const planMax = (plan: PlanId, kind: AliasKind): number | null =>
  kind === "alias" ? PLANS[plan].aliases : PLANS[plan].maskedAliases;

const maxFor = (plan: PlanId, kind: AliasKind): number => planMax(plan, kind) ?? ALIAS_CEILING;

async function planOf(repos: Repositories, accountId: string): Promise<PlanId> {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  return account.plan;
}

const view = (a: MailAlias, mailbox: Mailbox): AliasView => ({
  id: a.id,
  address: a.address,
  kind: a.kind,
  enabled: a.enabled,
  description: a.description,
  mailbox: { id: mailbox.id, address: mailbox.address, deleting: mailbox.status === "deleting" },
  createdAt: a.createdAt,
});

/** An alias the actor can reach (on one of their mailboxes, or any with `alias.manage.any`), else 404. */
async function scopedAlias(
  repos: Repositories,
  actor: Actor,
  accountId: string,
  id: string,
): Promise<{ alias: MailAlias; mailbox: Mailbox }> {
  const alias = isId(id) ? await repos.aliases.get(accountId, id) : null;
  const mailbox = alias && (await reachable(repos, actor, accountId)).find((m) => m.id === alias.mailboxId);
  if (!alias || !mailbox) throw new NotFoundError();
  return { alias, mailbox };
}

/** The aliases page: the person's reachable aliases, where new ones can point, and the plan's limits. */
export async function listAliases(deps: Deps, actor: Actor, accountId: string): Promise<AliasOverview> {
  authorize(actor, "alias.manage.own", accountId);
  return deps.uow.run(async (r) => {
    const mailboxes = await reachable(r, actor, accountId);
    const byId = new Map(mailboxes.map((m) => [m.id, m] as const));
    const aliases = (await r.aliases.listByAccount(accountId)).flatMap((a) => {
      const m = byId.get(a.mailboxId);
      return m ? [view(a, m)] : [];
    });
    const plan = await planOf(r, accountId);
    return {
      aliases,
      mailboxes: mailboxes.filter((m) => m.status !== "deleting").map((m) => ({ id: m.id, address: m.address })),
      domains: (await r.domains.listByAccount(accountId))
        .filter((d) => d.status === "active")
        .map((d) => ({ id: d.id, name: d.name })),
      limits: {
        alias: { used: await r.aliases.count(accountId, "alias"), max: planMax(plan, "alias") },
        masked: { used: await r.aliases.count(accountId, "masked"), max: planMax(plan, "masked") },
      },
    };
  });
}

/**
 * Adds an alias to a mailbox. `alias`: a chosen local part on one of the account's active domains. `masked`: a
 * random address on the mailbox's own domain. Counts against the plan (per account).
 */
export async function createAlias(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { kind?: unknown; mailboxId?: unknown; localPart?: unknown; domainId?: unknown; description?: unknown },
  req: RequestMeta,
): Promise<AliasView> {
  const kind: AliasKind = input.kind === "masked" ? "masked" : "alias";
  return mutation(
    deps,
    actor,
    req,
    { action: ACTIONS[kind].created, permission: "alias.manage.own", accountId, target: { type: "alias" } },
    async (repos) => {
      if (input.kind !== undefined && input.kind !== "alias" && input.kind !== "masked") {
        throw new ValidationError("Choose an alias or a masked alias.");
      }
      await repos.accounts.lock(accountId); // the plan's alias limits hold under concurrent creates
      const mailboxId = typeof input.mailboxId === "string" ? input.mailboxId : "";
      const mailbox = (await reachable(repos, actor, accountId)).find((m) => m.id === mailboxId);
      if (!mailbox) throw new ValidationError("Choose one of your mailboxes.");
      if (mailbox.status === "deleting") throw new ConflictError("That mailbox is being deleted. Restore it first.");
      const description = normaliseDescription(input.description);

      let next: () => string; // the address to try (masked: a fresh random one each time)
      if (kind === "alias") {
        const local = normaliseLocalPart(input.localPart);
        if (isReservedLocalPart(local) && !can(actor, "alias.manage.any", accountId)) {
          throw new ValidationError(`Only an account admin can use ${local}@. Ask an owner if you need it.`);
        }
        const domainId = typeof input.domainId === "string" ? input.domainId : "";
        const domain = isId(domainId) ? await repos.domains.get(accountId, domainId) : null;
        if (domain?.status !== "active") throw new ValidationError("Choose one of your active domains.");
        const chosen = `${local}@${domain.name}`;
        next = () => chosen;
      } else {
        await assertDomainHeld(repos, accountId, mailbox.address);
        const domainName = mailbox.address.slice(mailbox.address.lastIndexOf("@") + 1);
        next = () => `${maskedLocalPart()}@${domainName}`;
      }

      const max = maxFor(await planOf(repos, accountId), kind);
      if ((await repos.aliases.count(accountId, kind)) >= max) {
        throw new PlanLimitError(`This account can have up to ${String(max)} ${KIND_LABEL[kind]}.`);
      }

      let address = "";
      for (let attempt = 0; attempt < 3 && address === ""; attempt++) {
        const candidate = next();
        await repos.mailboxes.lockAddress(candidate);
        if (!(await repos.mailboxes.addressTaken(candidate))) address = candidate;
        else if (kind === "alias") break;
      }
      if (address === "") throw new ConflictError("That address is already in use.");

      const alias: MailAlias = {
        id: randomUUID(),
        accountId,
        mailboxId: mailbox.id,
        address,
        kind,
        enabled: true,
        description,
        createdAt: deps.clock.now(),
      };
      await repos.aliases.insert(alias);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      return {
        result: view(alias, mailbox),
        target: { id: alias.id, label: address },
        meta: { mailbox: mailbox.address },
      };
    },
  );
}

/** Picks the audit action by the alias's kind; the lookup is scoped to the account and reveals nothing. */
async function kindOf(deps: Deps, accountId: string, id: string): Promise<AliasKind> {
  const a = isId(id) ? await deps.uow.run((r) => r.aliases.get(accountId, id)) : null;
  return a?.kind ?? "alias";
}

/** Turns an alias on or off. Off: mail to it is refused and it can't be sent from; the address stays reserved. */
export async function setAliasEnabled(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  input: { enabled?: unknown },
  req: RequestMeta,
): Promise<AliasView> {
  const kind = await kindOf(deps, accountId, id);
  return mutation(
    deps,
    actor,
    req,
    { action: ACTIONS[kind].toggled, permission: "alias.manage.own", accountId, target: { type: "alias", id } },
    async (repos) => {
      const { alias, mailbox } = await scopedAlias(repos, actor, accountId, id);
      if (typeof input.enabled !== "boolean") throw new ValidationError("Say whether the alias is on or off.");
      if (mailbox.status === "deleting") {
        throw new ConflictError("This alias's mailbox is being deleted. Restore the mailbox first.");
      }
      await repos.aliases.setEnabled(alias.id, input.enabled);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      return {
        result: view({ ...alias, enabled: input.enabled }, mailbox),
        target: { label: alias.address },
        meta: { enabled: input.enabled },
      };
    },
  );
}

/** Deletes an alias; the mail server stops accepting mail for it once the worker has synced the mailbox. */
export async function deleteAlias(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<{ id: string }> {
  const kind = await kindOf(deps, accountId, id);
  return mutation(
    deps,
    actor,
    req,
    { action: ACTIONS[kind].deleted, permission: "alias.manage.own", accountId, target: { type: "alias", id } },
    async (repos) => {
      const { alias, mailbox } = await scopedAlias(repos, actor, accountId, id);
      await repos.aliases.delete(alias.id);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      return { result: { id: alias.id }, target: { label: alias.address }, meta: { mailbox: mailbox.address } };
    },
  );
}
