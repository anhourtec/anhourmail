// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { isReservedPlatformLocalPart } from "@anhourmail/shared/addresses";
import { ALIAS_YEAR_DAYS, ALIASES_PER_MAILBOX, PLANS, type PlanId } from "@anhourmail/shared/plans";

import { type Actor, authorize, can } from "../actor";
import {
  AliasAdminLockedError,
  AliasDailyLimitError,
  AliasMailboxLimitError,
  AliasYearlyLimitError,
  ConflictError,
  type DomainError,
  NotFoundError,
  PlanLimitError,
  ValidationError,
} from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { isReservedLocalPart, normaliseLocalPart } from "../mailboxes/entity";
import { onPlatformDomain, platformAddressFree } from "../mailboxes/platform";
import { assertDomainHeld } from "../mailboxes/service";
import { mutation, type MutationOutcome } from "../mutation";
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
  /** Turned off by an administrator: only an administrator can turn it back on or delete it. */
  adminLocked: boolean;
  description: string | null;
  /** `deleting`: the mailbox is in its deletion grace period, so this alias is off on the mail server. */
  mailbox: { id: string; address: string; deleting: boolean };
  createdAt: Date;
};

export type AliasOverview = {
  aliases: AliasView[];
  /**
   * Mailboxes the person can point an alias at (not ones being deleted), each with its aliases and masked aliases
   * together (`addresses`) against `perMailbox`.
   */
  mailboxes: { id: string; address: string; addresses: number }[];
  /** Aliases and masked aliases together one mailbox can have (`ALIASES_PER_MAILBOX`, every plan). */
  perMailbox: number;
  /** The account's active domains (chosen aliases can use any of them). */
  domains: { id: string; name: string }[];
  /**
   * `max`: how many can exist in the account at a time; null when the plan has no account-wide count (then only
   * `perMailbox` applies). `createdToday` / `perDay`: creations this UTC day (deleted ones included) against the
   * plan's daily cap. `createdThisYear` / `perYear`: creations in the rolling year against the plan's yearly cap
   * (`perYear` null: none); `nextSlot` is the UTC day (`YYYY-MM-DD`) a slot comes back while it is full, else null.
   */
  limits: Record<
    AliasKind,
    {
      used: number;
      max: number | null;
      createdToday: number;
      perDay: number;
      createdThisYear: number;
      perYear: number | null;
      nextSlot: string | null;
    }
  >;
};

/** The UTC day a creation counts against (`YYYY-MM-DD`). */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));

/** The first UTC day of the rolling year that ends on `today` (`ALIAS_YEAR_DAYS` days, today included). */
const yearStart = (today: string): string => addDays(today, 1 - ALIAS_YEAR_DAYS);

/**
 * Creations in the rolling year and, when they reach `perYear`, the UTC day the oldest counted ones fall out of the
 * window far enough to free one slot (a creation on day D counts until D + 364 and is gone on D + 365).
 */
export function yearlyUse(
  days: readonly { day: string; count: number }[],
  perYear: number | null,
): { used: number; nextSlot: string | null } {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const used = sorted.reduce((n, d) => n + d.count, 0);
  if (perYear === null || used < perYear) return { used, nextSlot: null };
  const need = used - perYear + 1;
  let gone = 0;
  for (const d of sorted) {
    gone += d.count;
    if (gone >= need) return { used, nextSlot: addDays(d.day, ALIAS_YEAR_DAYS) };
  }
  return { used, nextSlot: null }; // unreachable: `need` <= `used`
}

const slotDate = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });
/** `2027-10-28` → `Oct 28, 2027` (the day is UTC). */
const showDay = (day: string): string => slotDate.format(new Date(`${day}T00:00:00Z`));

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

const perYearFor = (plan: PlanId, kind: AliasKind): number | null => PLANS[plan].aliasCreationsPerYear?.[kind] ?? null;

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
  adminLocked: a.adminLocked,
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
    const all = await r.aliases.listByAccount(accountId);
    const aliases = all.flatMap((a) => {
      const m = byId.get(a.mailboxId);
      return m ? [view(a, m)] : [];
    });
    const onMailbox = (id: string) => all.filter((a) => a.mailboxId === id).length;
    const plan = await planOf(r, accountId);
    const day = utcDay(deps.clock.now());
    const limit = async (kind: AliasKind) => {
      const perYear = perYearFor(plan, kind);
      const year = yearlyUse(await r.aliases.creationsSince(accountId, kind, yearStart(day)), perYear);
      return {
        used: await r.aliases.count(accountId, kind),
        max: planMax(plan, kind),
        createdToday: await r.aliases.creationsOn(accountId, kind, day),
        perDay: PLANS[plan].aliasCreationsPerDay[kind],
        createdThisYear: year.used,
        perYear,
        nextSlot: year.nextSlot,
      };
    };
    return {
      aliases,
      mailboxes: mailboxes
        .filter((m) => m.status !== "deleting")
        .map((m) => ({ id: m.id, address: m.address, addresses: onMailbox(m.id) })),
      perMailbox: ALIASES_PER_MAILBOX,
      domains: (await r.domains.listByAccount(accountId))
        .filter((d) => d.status === "active")
        .map((d) => ({ id: d.id, name: d.name })),
      limits: { alias: await limit("alias"), masked: await limit("masked") },
    };
  });
}

/**
 * Adds an alias to a mailbox. `alias`: a chosen local part on one of the account's active domains. `masked`: a
 * random address on the mailbox's own domain. Limits, aliases and masked aliases each on their own except the
 * per-mailbox one:
 *   - how many can exist in the account at a time (`PLANS[plan].aliases` / `maskedAliases`): 403 `plan_limit`;
 *   - aliases and masked aliases together on the chosen mailbox (`ALIASES_PER_MAILBOX`): 409 `alias_mailbox_limit`;
 *   - creations in the rolling year (`aliasCreationsPerYear`, Free only): 429 `alias_yearly_limit`, saying the date
 *     a slot comes back;
 *   - creations per UTC day (`aliasCreationsPerDay`): 429 `alias_daily_limit`.
 * The creation caps count creations (deleting gives none back); a refused create counts nothing. The last three
 * are audited as denied. All are checked, and the creation counted, under the account lock in the same unit of work,
 * so they hold under concurrent creates and fail closed.
 */
export async function createAlias(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { kind?: unknown; mailboxId?: unknown; localPart?: unknown; domainId?: unknown; description?: unknown },
  req: RequestMeta,
): Promise<AliasView> {
  const kind: AliasKind = input.kind === "masked" ? "masked" : "alias";
  const refused: { error?: DomainError } = {};
  const created = await mutation(
    deps,
    actor,
    req,
    { action: ACTIONS[kind].created, permission: "alias.manage.own", accountId, target: { type: "alias" } },
    async (repos): Promise<MutationOutcome<AliasView | null>> => {
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

      const plan = await planOf(repos, accountId);
      const max = planMax(plan, kind);
      if (max !== null && (await repos.aliases.count(accountId, kind)) >= max) {
        throw new PlanLimitError(`This account can have up to ${String(max)} ${KIND_LABEL[kind]} at a time.`);
      }
      if ((await repos.aliases.countForMailbox(accountId, mailbox.id)) >= ALIASES_PER_MAILBOX) {
        refused.error = new AliasMailboxLimitError(
          `A mailbox can have at most ${String(ALIASES_PER_MAILBOX)} addresses (aliases and masked aliases together). Delete one, or point the new one at another mailbox.`,
        );
        return {
          result: null,
          meta: { kind, perMailbox: ALIASES_PER_MAILBOX, mailbox: mailbox.address },
          denied: { code: "alias_mailbox_limit" },
        };
      }
      const day = utcDay(deps.clock.now());
      const perYear = perYearFor(plan, kind);
      if (perYear !== null) {
        const year = yearlyUse(await repos.aliases.creationsSince(accountId, kind, yearStart(day)), perYear);
        if (year.nextSlot !== null) {
          refused.error = new AliasYearlyLimitError(
            `You can create ${String(perYear)} new ${KIND_LABEL[kind]} a year on ${PLANS[plan].name}; you can add more on ${showDay(year.nextSlot)}.`,
          );
          return {
            result: null,
            meta: { kind, perYear, nextSlot: year.nextSlot },
            denied: { code: "alias_yearly_limit" },
          };
        }
      }
      const perDay = PLANS[plan].aliasCreationsPerDay[kind];
      if ((await repos.aliases.creationsOn(accountId, kind, day)) >= perDay) {
        refused.error = new AliasDailyLimitError(
          `This account has created ${String(perDay)} ${KIND_LABEL[kind]} today, the most it can in one day. You can create more after midnight UTC.`,
        );
        return { result: null, meta: { kind, perDay }, denied: { code: "alias_daily_limit" } };
      }

      let address = "";
      for (let attempt = 0; attempt < 3 && address === ""; attempt++) {
        const candidate = next();
        await repos.mailboxes.lockAddress(candidate);
        // On the platform domain a name retired from another account is never handed out again (ADR-0021).
        // …and a random name that happens to read as a reserved one is skipped there too.
        const onPlatform = onPlatformDomain(candidate, deps.platform);
        const local = candidate.slice(0, candidate.lastIndexOf("@"));
        const free = onPlatform
          ? !isReservedPlatformLocalPart(local) && (await platformAddressFree(repos, candidate, accountId))
          : !(await repos.mailboxes.addressTaken(candidate));
        if (free) address = candidate;
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
        adminLocked: false,
        description,
        createdAt: deps.clock.now(),
      };
      await repos.aliases.insert(alias);
      await repos.aliases.recordCreation(accountId, kind, day);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      return {
        result: view(alias, mailbox),
        target: { id: alias.id, label: address },
        meta: { mailbox: mailbox.address },
      };
    },
  );
  if (created === null) throw refused.error ?? new ConflictError("That alias can't be created right now.");
  return created;
}

/** Picks the audit action by the alias's kind; the lookup is scoped to the account and reveals nothing. */
async function kindOf(deps: Deps, accountId: string, id: string): Promise<AliasKind> {
  const a = isId(id) ? await deps.uow.run((r) => r.aliases.get(accountId, id)) : null;
  return a?.kind ?? "alias";
}

/**
 * Whether this actor manages the alias as an administrator: `alias.manage.any` on a mailbox that isn't their own. Only
 * such a change sets or lifts the admin lock.
 */
const asAdmin = (actor: Actor, accountId: string, mailbox: Mailbox): boolean =>
  can(actor, "alias.manage.any", accountId) && !(actor.kind === "user" && mailbox.userId === actor.userId);

/** Refused for the alias's own person while an administrator holds it off (lifting it takes `alias.manage.any`). */
const lockedFor = (actor: Actor, accountId: string, alias: MailAlias): boolean =>
  alias.adminLocked && !can(actor, "alias.manage.any", accountId);

/**
 * Turns an alias on or off. Off: mail to it is refused and it can't be sent from; the address stays reserved. An
 * administrator turning off someone else's alias locks it off: its person can't turn it back on (403
 * `alias_admin_locked`, audited as denied) until an administrator does, which lifts the lock.
 */
export async function setAliasEnabled(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  input: { enabled?: unknown },
  req: RequestMeta,
): Promise<AliasView> {
  const kind = await kindOf(deps, accountId, id);
  const out = await mutation(
    deps,
    actor,
    req,
    { action: ACTIONS[kind].toggled, permission: "alias.manage.own", accountId, target: { type: "alias", id } },
    async (repos): Promise<MutationOutcome<AliasView | null>> => {
      // Serialised per account, so an administrator's lock and its person's turn-on can't race past each other.
      await repos.accounts.lock(accountId);
      const { alias, mailbox } = await scopedAlias(repos, actor, accountId, id);
      if (typeof input.enabled !== "boolean") throw new ValidationError("Say whether the alias is on or off.");
      if (input.enabled && lockedFor(actor, accountId, alias)) {
        return {
          result: null,
          target: { label: alias.address },
          meta: { enabled: true },
          denied: { code: "alias_admin_locked" },
        };
      }
      if (mailbox.status === "deleting") {
        throw new ConflictError("This alias's mailbox is being deleted. Restore the mailbox first.");
      }
      // Off by an administrator: locked. On: never locked. Off by its own person: the lock (if any) stays.
      const adminLocked = input.enabled ? false : asAdmin(actor, accountId, mailbox) || alias.adminLocked;
      await repos.aliases.setEnabled(alias.id, input.enabled, adminLocked);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      return {
        result: view({ ...alias, enabled: input.enabled, adminLocked }, mailbox),
        target: { label: alias.address },
        meta: {
          enabled: input.enabled,
          ...(adminLocked && !alias.adminLocked ? { adminLocked: true } : {}),
          ...(alias.adminLocked && !adminLocked ? { adminLockLifted: true } : {}),
        },
      };
    },
  );
  if (out === null) throw new AliasAdminLockedError();
  return out;
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
  const out = await mutation(
    deps,
    actor,
    req,
    { action: ACTIONS[kind].deleted, permission: "alias.manage.own", accountId, target: { type: "alias", id } },
    async (repos): Promise<MutationOutcome<{ id: string } | null>> => {
      await repos.accounts.lock(accountId); // the admin lock is read and acted on atomically (see setAliasEnabled)
      const { alias, mailbox } = await scopedAlias(repos, actor, accountId, id);
      // Deleting would free the address to be added again, around the administrator's lock.
      if (lockedFor(actor, accountId, alias)) {
        return { result: null, target: { label: alias.address }, denied: { code: "alias_admin_locked" } };
      }
      await repos.aliases.delete(alias.id);
      // A deleted platform-domain address (a masked alias there) is never handed to another account (ADR-0021).
      if (onPlatformDomain(alias.address, deps.platform)) {
        await repos.platformAddresses.retire(alias.address, accountId, deps.clock.now());
      }
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      return { result: { id: alias.id }, target: { label: alias.address }, meta: { mailbox: mailbox.address } };
    },
  );
  if (out === null) throw new AliasAdminLockedError();
  return out;
}
