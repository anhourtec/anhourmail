// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { accountPoolBytes, MAILBOX_DELETE_GRACE_DAYS, MAX_MAILBOXES, PLANS } from "@anhourmail/shared/plans";
import {
  defaultShareBytes,
  formatBytes,
  minQuotaBytes,
  poolFullMessage,
  type StoragePool,
  storagePool,
} from "@anhourmail/shared/storage";

import { type Actor, authorize, can } from "../actor";
import { maskEmail } from "../audit/record";
import { turnOffCatchAllFor } from "../domains/catch-all";
import {
  ConflictError,
  EmailUnverifiedError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  ValidationError,
} from "../errors";
import { dropMailboxGrants } from "../delegation/cascade";
import { type AuditAlso, authorizeAudited, mutation, type MutationOutcome } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import { BreachedPasswordError, passwordBreached } from "../security/breached-passwords";
import type { MailServer } from "../provisioning/ports";
import { displayName } from "../people/entity";
import { mailboxSenderName, type NameSource } from "../people/names";
import { GB, type Mailbox, type MailboxStatus, normaliseLocalPart } from "./entity";
import { hashMailboxPassword, mailboxPassword, type PasswordHasher } from "./password-hash";
import {
  assertCustomerPlatform,
  assertPlatformAllowance,
  normalisePlatformLocalPart,
  onPlatformDomain,
  PLATFORM_DOMAIN_ID,
  platformAddressFree,
  platformAllowance,
} from "./platform";

/** What the console and API show; mail-server ids and errors stay server-side. */
export type MailboxView = {
  id: string;
  address: string;
  status: MailboxStatus;
  quotaBytes: number;
  /** The person it belongs to; `name` is their name (what the mailbox sends as unless it has a custom one). */
  owner: { userId: string; email: string; name: string } | null;
  /**
   * The custom display name an admin set; null when the mailbox follows its person's name (or, without a person, has
   * none). See `senderName` for what it sends as.
   */
  displayName: string | null;
  /** The sender name in "Name <address>": the custom display name, else the person's name, else none (null). */
  senderName: string | null;
  /** Where `senderName` comes from. */
  nameSource: NameSource;
  /** While `deleting`: when it is removed for good (it can be restored until then). */
  purgeAfter: Date | null;
  /**
   * The worker gave up applying the current state to the mail server (e.g. a suspension isn't in force yet). Only
   * whether it happened; the error text stays server-side. Suspend or delete again to retry.
   */
  applyFailed: boolean;
  createdAt: Date;
  /** Storage used at the last measurement (`job:storage-usage`, every ~10 minutes); null until measured once. */
  storageUsedBytes: number | null;
  /** When it was measured (null: never). */
  storageCheckedAt: Date | null;
};

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

async function scoped(repos: Repositories, accountId: string, id: string): Promise<Mailbox> {
  const m = isId(id) ? await repos.mailboxes.get(accountId, id) : null;
  if (!m) throw new NotFoundError();
  return m;
}

async function views(repos: Repositories, accountId: string, list: Mailbox[]): Promise<MailboxView[]> {
  const members = new Map((await repos.access.members(accountId)).map((m) => [m.userId, m.email] as const));
  const names = new Map((await repos.people.list(accountId)).map((p) => [p.userId, p.name] as const));
  const storage = new Map((await repos.mailboxStorage.byAccount(accountId)).map((x) => [x.mailboxId, x] as const));
  return list.map((m) => {
    const sender = mailboxSenderName(m.displayName, m.userId ? names.get(m.userId) : null);
    return {
      id: m.id,
      address: m.address,
      status: m.status,
      quotaBytes: m.quotaBytes,
      owner:
        m.userId && members.has(m.userId)
          ? { userId: m.userId, email: members.get(m.userId) ?? "", name: names.get(m.userId) ?? "" }
          : null,
      displayName: m.displayName ?? null,
      senderName: sender.name,
      nameSource: sender.source,
      purgeAfter: m.purgeAfter,
      applyFailed: m.lastError !== null,
      createdAt: m.createdAt,
      storageUsedBytes: storage.get(m.id)?.usedBytes ?? null,
      storageCheckedAt: storage.get(m.id)?.checkedAt ?? null,
    };
  });
}

/**
 * Suspending, deleting or restoring a mailbox that belongs to an owner or an admin of the account (any role but
 * Member) takes an Owner: a User Admin can't lock out the people above them or each other. Their own mailbox and
 * unassigned or members' mailboxes are fine.
 */
export function lifecycleLocked(
  actor: Actor,
  accountId: string,
  m: Mailbox,
  members: readonly { userId: string; role: string }[],
): boolean {
  if (actor.kind !== "user") return false;
  if (actor.memberships.find((x) => x.accountId === accountId)?.role === "owner") return false;
  if (m.userId === null || m.userId === actor.userId) return false;
  const role = members.find((x) => x.userId === m.userId)?.role;
  return role !== undefined && role !== "member";
}

const LOCKED_MESSAGE = "Only an owner can suspend, delete or restore a mailbox that belongs to an owner or an admin.";

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

/**
 * The account's storage pool as it stands (plan storage plus purchased blocks; blocks are 0 until billing opens): what
 * its mailboxes are given, what is left, and what each holds. Every mailbox counts, suspended or being deleted too —
 * they still hold their mail.
 */
async function poolOf(repos: Repositories, accountId: string) {
  const account = await repos.accounts.get(accountId);
  if (!account) throw new NotFoundError();
  const mailboxes = await repos.mailboxes.listByAccount(accountId);
  const used = new Map((await repos.mailboxStorage.byAccount(accountId)).map((x) => [x.mailboxId, x.usedBytes]));
  const pool = storagePool(
    accountPoolBytes(account.plan),
    mailboxes.map((m) => ({ quotaBytes: m.quotaBytes, storageUsedBytes: used.get(m.id) ?? null })),
  );
  return { plan: PLANS[account.plan], pool, count: mailboxes.length, used };
}

/** A new mailbox's storage: the default share of the pool, or the amount asked for (1 GB … the unassigned pool). */
function newMailboxQuota(p: Awaited<ReturnType<typeof poolOf>>, input: unknown): number {
  const { pool } = p;
  if (pool.unassignedBytes < GB) throw new PlanLimitError(poolFullMessage(pool.poolBytes));
  if (input === undefined || input === null || input === "") {
    return defaultShareBytes(pool.unassignedBytes, p.count, p.plan.includedMailboxes);
  }
  return parseQuota(input, GB, Math.floor(pool.unassignedBytes / GB) * GB);
}

async function planIncludesDomains(repos: Repositories, accountId: string): Promise<boolean> {
  const account = await repos.accounts.get(accountId);
  return account !== null && PLANS[account.plan].customDomains;
}

/** A whole number of GB from `min` to `max` (bytes, whole GB). */
function parseQuota(input: unknown, min: number, max: number): number {
  const gb = typeof input === "number" ? input : Number(input);
  if (!Number.isInteger(gb) || gb * GB < min || gb * GB > max) {
    throw new ValidationError(`Choose a whole number of GB from ${String(min / GB)} to ${String(max / GB)}.`);
  }
  return gb * GB;
}

/** The storage a mailbox can be given: at least what it holds (rounded up), at most its quota plus the unassigned pool. */
function quotaRange(m: Mailbox, pool: StoragePool, usedBytes: number | null) {
  return { min: minQuotaBytes(usedBytes), max: Math.floor((m.quotaBytes + pool.unassignedBytes) / GB) * GB };
}

/** The account's storage pool (`mailbox.read`): the Mailboxes page header. */
export async function mailboxStoragePool(deps: Deps, actor: Actor, accountId: string): Promise<StoragePool> {
  authorize(actor, "mailbox.read", accountId);
  return deps.uow.run(async (r) => (await poolOf(r, accountId)).pool);
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
): Promise<
  MailboxView & {
    maxQuotaBytes: number;
    minQuotaBytes: number;
    pool: StoragePool;
    lifecycleLocked: boolean;
    passwordPending: boolean;
    passwordApplyFailed: boolean;
    canSetPassword: boolean;
  }
> {
  authorize(actor, "mailbox.read", accountId);
  return deps.uow.run(async (r) => {
    const m = await scoped(r, accountId, id);
    const [v] = await views(r, accountId, [m]);
    if (!v) throw new NotFoundError();
    const locked = lifecycleLocked(actor, accountId, m, await r.access.members(accountId));
    const p = await poolOf(r, accountId);
    const range = quotaRange(m, p.pool, v.storageUsedBytes);
    // A waiting password whose job gave up: an administrator's, kept until they set one again (`runNextJob`).
    const waiting = await r.mailboxPasswords.pending(m.id);
    const applyFailed = waiting && (await r.provisioning.latest("mailbox.password", m.id))?.status === "failed";
    return {
      ...v,
      /** Storage it can be given: its own plus the account's unassigned pool. */
      maxQuotaBytes: range.max,
      /** What it holds, rounded up (at least 1 GB): it can't be lowered below this. */
      minQuotaBytes: range.min,
      pool: p.pool,
      /** True when this person may not suspend, delete or restore it (the console hides those actions). */
      lifecycleLocked: locked,
      /** A new password is waiting for the mail server (set a moment ago). */
      passwordPending: waiting && !applyFailed,
      /**
       * The password an administrator set never reached the mail server (the worker gave up): the old one still works,
       * the mailbox can't change its own until a new one is set, and the console asks for it again.
       */
      passwordApplyFailed: applyFailed,
      /** This person may set its password (`mailbox.password.reset`, not locked, not acting as someone). */
      canSetPassword:
        can(actor, "mailbox.password.reset", accountId) &&
        !locked &&
        !(actor.kind === "user" && actor.actingAs !== undefined),
    };
  });
}

/**
 * What the create form needs (`mailbox.manage`): the account's active domains, the platform domain's free-address
 * allowance, its members and the quota bounds. `platform.allowed` is false when the plan's free addresses are used up
 * (or the mailbox ceiling is reached); `emailVerified` is whether this person may claim one.
 */
export async function mailboxOptions(deps: Deps, actor: Actor, accountId: string) {
  authorize(actor, "mailbox.manage", accountId);
  return deps.uow.run(async (r) => {
    const allowance = await platformAllowance(r, deps.platform, accountId);
    const p = await poolOf(r, accountId);
    return {
      domains: (await r.domains.listByAccount(accountId))
        .filter((d) => d.status === "active")
        .map((d) => ({ id: d.id, name: d.name })),
      platform: {
        id: PLATFORM_DOMAIN_ID,
        domain: deps.platform.freeAddressDomain,
        used: allowance.used,
        max: allowance.max,
        allowed: allowance.remaining > 0,
        emailVerified: actor.kind === "user" && (await r.access.emailVerified(actor.userId)),
      },
      members: (await r.access.members(accountId)).map((m) => ({ userId: m.userId, email: m.email })),
      /** The plan includes custom domains (where more mailboxes can live). */
      customDomains: await planIncludesDomains(r, accountId),
      /** The unassigned pool in whole GB (0: full, a new mailbox is refused) and the default share. */
      maxQuotaGb: Math.floor(p.pool.unassignedBytes / GB),
      defaultQuotaGb: defaultShareBytes(p.pool.unassignedBytes, p.count, p.plan.includedMailboxes) / GB,
      pool: p.pool,
      remaining: MAX_MAILBOXES - p.count,
    };
  });
}

/**
 * Creates a mailbox on one of the account's active domains, or on the platform domain (`domainId: "platform"`: a free
 * address, ADR-0021), optionally for one of its members, with the password its person signs in with (checked against
 * the mailbox password rules and hashed here to argon2id; only the hash goes to the worker, which sets it when it
 * creates the account on the mail server — the password is never stored, queued, logged or audited). Refused during a
 * staff act-as session: staff never choose a customer's password. A platform address also needs the person's email
 * confirmed, a name by the platform rules that no account holds or held, and room in the plan's allowance.
 */
export async function createMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { localPart?: unknown; domainId?: unknown; ownerUserId?: unknown; quotaGb?: unknown; password?: unknown },
  req: RequestMeta,
  hasher: PasswordHasher,
): Promise<MailboxView> {
  // The breached-password lookup runs before the unit of work (never while holding the account lock), only for someone
  // who may create mailboxes here; its answer is used once the password has passed the rules.
  const breached = can(actor, "mailbox.manage", accountId) && (await passwordBreached(hasher.breaches, input.password));
  const out = await mutation(
    deps,
    actor,
    req,
    { action: "mailbox.created", permission: "mailbox.manage", accountId, target: { type: "mailbox" } },
    async (repos): Promise<MutationOutcome<MailboxView | "act_as" | "email_unverified">> => {
      if (actor.kind === "user" && actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      await repos.accounts.lock(accountId); // the mailbox ceiling holds under concurrent creates
      const target = await newMailboxAddress(deps, actor, repos, accountId, input);
      if (target === "email_unverified") return { result: "email_unverified", denied: { code: "email_unverified" } };
      const { onPlatform, address } = target;
      let userId: string | null = null;
      if (input.ownerUserId !== undefined && input.ownerUserId !== null && input.ownerUserId !== "") {
        const members = await repos.access.members(accountId);
        const owner = members.find((m) => m.userId === input.ownerUserId);
        if (!owner) throw new ValidationError("Choose someone in this account.");
        userId = owner.userId;
      }
      const quotaBytes = await assertRoomForMailbox(deps, repos, accountId, onPlatform, input.quotaGb);
      const password = mailboxPassword(input.password, address);
      if (breached) throw new BreachedPasswordError();
      await assertAddressFree(repos, accountId, address, onPlatform);
      const mailbox = newMailbox(deps, accountId, userId, address, quotaBytes);
      await repos.mailboxes.insert(mailbox);
      // The worker sets it when it creates the account (`MailServer.ensureMailbox` `initialPasswordHash`).
      await repos.mailboxPasswords.setPending(mailbox.id, await hashMailboxPassword(hasher, password), null);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      const v = await viewOf(repos, accountId, mailbox);
      return {
        result: v,
        target: { id: mailbox.id, label: address },
        meta: {
          quotaGb: quotaBytes / GB,
          owner: v.owner ? maskEmail(v.owner.email) : null,
          ...(onPlatform ? { platformAddress: true } : {}),
        },
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Mailboxes can't be created while acting as someone.");
  if (out === "email_unverified") throw new EmailUnverifiedError();
  return out;
}

/**
 * The address for a new mailbox: a local part on one of the account's active domains, or on the platform domain
 * (`domainId: "platform"`, a free address; needs the actor's email confirmed — "email_unverified" otherwise).
 */
export async function newMailboxAddress(
  deps: Deps,
  actor: Actor,
  repos: Repositories,
  accountId: string,
  input: { localPart?: unknown; domainId?: unknown },
): Promise<{ address: string; onPlatform: boolean } | "email_unverified"> {
  if (input.domainId === PLATFORM_DOMAIN_ID) {
    assertCustomerPlatform(deps.platform);
    if (actor.kind === "user" && !(await repos.access.emailVerified(actor.userId))) return "email_unverified";
    return { address: `${normalisePlatformLocalPart(input.localPart)}@${deps.platform.domain}`, onPlatform: true };
  }
  const local = normaliseLocalPart(input.localPart);
  const domainId = typeof input.domainId === "string" ? input.domainId : "";
  const domain = isId(domainId) ? await repos.domains.get(accountId, domainId) : null;
  if (domain?.status !== "active") throw new ValidationError("Choose one of your active domains.");
  return { address: `${local}@${domain.name}`, onPlatform: false };
}

/**
 * Room for one more mailbox (call under the account lock): the platform allowance, the mailbox ceiling and the storage
 * pool. Returns the new mailbox's storage (the default share, or `quotaGb`).
 */
export async function assertRoomForMailbox(
  deps: Deps,
  repos: Repositories,
  accountId: string,
  onPlatform: boolean,
  quotaGb: unknown,
): Promise<number> {
  if (onPlatform) await assertPlatformAllowance(repos, deps.platform, accountId);
  if ((await repos.mailboxes.count(accountId)) >= MAX_MAILBOXES) {
    throw new PlanLimitError(
      `Your plan includes ${String(MAX_MAILBOXES)} mailboxes. More mailboxes come with billing, which isn't open yet.`,
    );
  }
  return newMailboxQuota(await poolOf(repos, accountId), quotaGb);
}

/** Holds the address for this transaction and refuses one in use (or, on the platform domain, ever held elsewhere). */
export async function assertAddressFree(
  repos: Repositories,
  accountId: string,
  address: string,
  onPlatform: boolean,
): Promise<void> {
  await repos.mailboxes.lockAddress(address); // mailboxes and aliases share one address space
  const free = onPlatform
    ? await platformAddressFree(repos, address, accountId)
    : !(await repos.mailboxes.addressTaken(address));
  if (!free) throw new ConflictError("That address is already in use.");
}

export function newMailbox(deps: Deps, accountId: string, userId: string | null, address: string, quotaBytes: number) {
  const mailbox: Mailbox = {
    id: randomUUID(),
    accountId,
    userId,
    address,
    status: "provisioning",
    quotaBytes,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: deps.clock.now(),
  };
  return mailbox;
}

const STAFF_CREATE = { action: "mailbox.created", permission: "platform.mailbox.create" } as const;

/**
 * Staff (Global Administrator, `platform.mailbox.create`): creates a free platform-domain address in a customer
 * account, optionally for one of its people, from the Platform → account page. Same name rules, allowance and
 * no-reuse check as the customer's own path; no email-confirmation requirement (staff vouch for it). It is created
 * **without a usable password** — staff never choose a customer's mailbox password — and the account's Owner or User
 * Administrator sets one from the mailbox panel. Audited as `mailbox.created` by staff in the account's own log, so
 * its admins see it (rule 49). Refused while acting as someone (act-as is a customer's view, not a staff tool).
 * Missing permission → 403 (audited in the platform log, never in the account's); unknown account → 404.
 */
export async function staffCreatePlatformMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { localPart?: unknown; ownerUserId?: unknown },
  req: RequestMeta,
): Promise<MailboxView> {
  // Refusals before the account is known go to the platform log: a probe can't write into an account's log.
  const platformSpec = { ...STAFF_CREATE, accountId: null, target: { type: "mailbox" } };
  await authorizeAudited(deps, actor, req, platformSpec);
  const account = isId(accountId) ? await deps.uow.run((r) => r.accounts.get(accountId)) : null;
  if (!account) {
    await mutation(deps, actor, req, platformSpec, async () => ({
      result: undefined,
      denied: { code: "not_found" },
    }));
    throw new NotFoundError();
  }
  const out = await mutation(
    deps,
    actor,
    req,
    { ...STAFF_CREATE, accountId, target: { type: "mailbox" }, staffPath: true },
    async (repos): Promise<MutationOutcome<MailboxView | "act_as">> => {
      if (actor.kind === "user" && actor.actingAs) return { result: "act_as", denied: { code: "act_as" } };
      assertCustomerPlatform(deps.platform);
      await repos.accounts.lock(accountId);
      // Nothing new lands in an account on its way out (ADR-0025); its Owner can cancel the deletion first.
      if (await repos.dataLifecycle.getDeletion(accountId)) {
        throw new ConflictError("This account is waiting to be deleted, so it can't get new mailboxes.");
      }
      const local = normalisePlatformLocalPart(input.localPart);
      let userId: string | null = null;
      if (input.ownerUserId !== undefined && input.ownerUserId !== null && input.ownerUserId !== "") {
        const owner = (await repos.access.members(accountId)).find((m) => m.userId === input.ownerUserId);
        if (!owner) throw new ValidationError("Choose someone in this account.");
        userId = owner.userId;
      }
      await assertPlatformAllowance(repos, deps.platform, accountId);
      const address = `${local}@${deps.platform.domain}`;
      await repos.mailboxes.lockAddress(address);
      if (!(await platformAddressFree(repos, address, accountId))) {
        throw new ConflictError("That address is already in use.");
      }
      const mailbox = newMailbox(
        deps,
        accountId,
        userId,
        address,
        newMailboxQuota(await poolOf(repos, accountId), null),
      );
      await repos.mailboxes.insert(mailbox);
      // No password waiting: the worker gives the account a random one nobody knows until the account sets its own.
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailbox.id, runAfter: deps.clock.now() });
      const v = await viewOf(repos, accountId, mailbox);
      return {
        result: v,
        target: { id: mailbox.id, label: address },
        meta: {
          quotaGb: mailbox.quotaBytes / GB,
          owner: v.owner ? maskEmail(v.owner.email) : null,
          platformAddress: true,
          passwordSetBy: "account",
        },
      };
    },
  );
  if (out === "act_as") throw new ForbiddenError("Staff can't create mailboxes while acting as someone.");
  return out;
}

const BEING_DELETED = "This mailbox is being deleted. Restore it first.";

/**
 * Changes a mailbox's quota within the account's pool: from what it holds (rounded up to the next GB, at least 1 GB)
 * to its current quota plus the unassigned pool. The worker applies it to the mail server.
 */
/**
 * "Display name" (`mailbox.manage`): a custom sender name for the mailbox ("Name <address>"), or empty to clear it —
 * then a person's mailbox follows their name again ("Use the person's name") and a mailbox without a person has none
 * (people/names.ts). The worker writes the resulting sender name to the mail server as the account description
 * (`mailbox.ensure`); the webmail renames the mailbox's sending identities to it on its next request. Like suspending or
 * setting a password, renaming an Owner's or an admin's mailbox takes an Owner (403, audited as denied). The name itself
 * is personal data: the audit entry records only that it changed (and whether it was cleared).
 */
export async function renameMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  input: { displayName?: unknown },
  req: RequestMeta,
): Promise<MailboxView> {
  const out = await mutation<MailboxView | null>(
    deps,
    actor,
    req,
    { action: "mailbox.renamed", permission: "mailbox.manage", accountId, target: { type: "mailbox", id } },
    async (repos) => {
      const m = await scoped(repos, accountId, id);
      if (lifecycleLocked(actor, accountId, m, await repos.access.members(accountId))) {
        return { result: null, target: { label: m.address }, denied: { code: "forbidden" } };
      }
      if (m.status === "deleting") throw new ConflictError(BEING_DELETED);
      const raw = typeof input.displayName === "string" ? input.displayName.trim() : "";
      const name = raw === "" ? null : displayName(raw);
      await repos.mailboxes.setDisplayName(m.id, name);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
      return {
        result: await viewOf(repos, accountId, { ...m, displayName: name }),
        target: { label: m.address },
        meta: { cleared: name === null },
      };
    },
  );
  if (out === null) {
    throw new ForbiddenError("Only an owner can rename a mailbox that belongs to an owner or an admin.");
  }
  return out;
}

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
      if (m.status === "deleting") throw new ConflictError(BEING_DELETED);
      await assertDomainHeld(repos, accountId, m.address);
      if (input.quotaGb === undefined || input.quotaGb === null || input.quotaGb === "") {
        throw new ValidationError("Choose a quota in GB.");
      }
      await repos.accounts.lock(accountId); // the pool holds under concurrent changes
      const p = await poolOf(repos, accountId);
      const usedBytes = p.used.get(m.id) ?? null;
      const range = quotaRange(m, p.pool, usedBytes);
      const gb = typeof input.quotaGb === "number" ? input.quotaGb : Number(input.quotaGb);
      if (Number.isInteger(gb) && gb * GB < range.min && gb * GB < m.quotaBytes) {
        throw new ValidationError(
          `This mailbox holds ${formatBytes(usedBytes ?? 0)}. Choose at least ${formatBytes(range.min)}, or delete some mail first.`,
        );
      }
      if (Number.isInteger(gb) && gb * GB > range.max && gb * GB > m.quotaBytes) {
        throw new ValidationError(
          p.pool.unassignedBytes < GB
            ? poolFullMessage(p.pool.poolBytes)
            : `Only ${formatBytes(p.pool.unassignedBytes)} of this account's storage is unassigned. Choose up to ${formatBytes(range.max)}.`,
        );
      }
      const quotaBytes = parseQuota(
        input.quotaGb,
        Math.min(range.min, m.quotaBytes),
        Math.max(range.max, m.quotaBytes),
      );
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

const DAY_MS = 24 * 3600_000;

/** One view of a mailbox after a lifecycle change, from inside the same unit of work. */
export async function viewOf(repos: Repositories, accountId: string, m: Mailbox): Promise<MailboxView> {
  const [v] = await views(repos, accountId, [m]);
  if (!v) throw new NotFoundError();
  return v;
}

/**
 * Applies a lifecycle change (status + purge date; clears the last error) and queues the worker, which brings the
 * mail server to it. The change is conditional on the status read, so a concurrent change makes this one a conflict
 * instead of a lost update. `to` may equal the current status: that re-queues a change whose job gave up.
 */
async function moveTo(
  deps: Deps,
  repos: Repositories,
  m: Mailbox,
  to: MailboxStatus,
  purgeAfter: Date | null,
): Promise<Mailbox> {
  if (!(await repos.mailboxes.transition(m.id, [m.status], to, purgeAfter))) {
    throw new ConflictError("This mailbox changed while you were working on it. Reload and try again.");
  }
  await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
  return { ...m, status: to, purgeAfter, lastError: null };
}

type LifecycleAction = "mailbox.suspended" | "mailbox.unsuspended" | "mailbox.deletion_scheduled" | "mailbox.restored";

/**
 * Shared shape of suspend / resume / delete / restore: `mailbox.manage`, scoped to the account (404), the
 * owner-or-admin guard (403, audited as denied), then `change` in one audited unit of work.
 */
async function lifecycle(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
  action: LifecycleAction,
  change: (
    repos: Repositories,
    m: Mailbox,
  ) => Promise<{ next: Mailbox; meta?: Record<string, unknown>; also?: AuditAlso[] }>,
): Promise<MailboxView> {
  const out = await mutation(
    deps,
    actor,
    req,
    { action, permission: "mailbox.manage", accountId, target: { type: "mailbox", id } },
    async (repos) => {
      const m = await scoped(repos, accountId, id);
      if (lifecycleLocked(actor, accountId, m, await repos.access.members(accountId))) {
        return { result: null, target: { label: m.address }, denied: { code: "forbidden" } };
      }
      const { next, meta, also } = await change(repos, m);
      return {
        result: await viewOf(repos, accountId, next),
        target: { label: m.address },
        meta: meta ?? {},
        ...(also && also.length > 0 ? { also } : {}),
      };
    },
  );
  if (out === null) throw new ForbiddenError(LOCKED_MESSAGE);
  return out;
}

/**
 * Suspends a mailbox: nobody can sign in to it over any protocol and its mail is refused, but nothing it holds is
 * deleted. The worker applies it to the mail server. Suspending a suspended mailbox whose job gave up retries it.
 */
export async function suspendMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.suspended", async (repos, m) => {
    if (m.status === "deleting") throw new ConflictError(BEING_DELETED);
    if (m.status === "suspended") {
      if (m.lastError === null) throw new ConflictError("This mailbox is already suspended.");
      return { next: await moveTo(deps, repos, m, "suspended", null), meta: { from: m.status, retry: true } };
    }
    const next = await moveTo(deps, repos, m, "suspended", null);
    const catchAllOff = await turnOffCatchAllFor(deps, repos, m.id);
    return { next, meta: { from: m.status, ...(catchAllOff.length > 0 ? { catchAllOff } : {}) } };
  });
}

/** Resumes a suspended mailbox: the worker restores access, then it shows as active again. */
export async function resumeMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
  hasher: PasswordHasher,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.unsuspended", async (repos, m) => {
    if (m.status !== "suspended") throw new ConflictError("This mailbox isn't suspended.");
    await assertNotHeld(repos, accountId, m.id, m.userId);
    await assertDomainHeld(repos, accountId, m.address);
    const next = await moveTo(deps, repos, m, "provisioning", null);
    await queueWaitingPassword(deps, repos, hasher, m);
    return { next };
  });
}

/**
 * Deletes a mailbox with a grace period: it is suspended at once (mail kept, its aliases off the mail server, its
 * address and theirs still reserved) and removed for good after `MAILBOX_DELETE_GRACE_DAYS`, unless restored.
 * Deleting a deleting mailbox whose job gave up retries it (the purge date stays). Everyone it was delegated to loses
 * their access at once (ADR-0026: one `delegation.revoked` entry each, reason `mailbox_deleted`); a restore doesn't
 * bring the grants back.
 */
export async function deleteMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.deletion_scheduled", async (repos, m) => {
    if (m.status === "deleting") {
      if (m.lastError === null) throw new ConflictError("This mailbox is already being deleted.");
      const next = await moveTo(deps, repos, m, "deleting", m.purgeAfter);
      const also = await dropMailboxGrants(repos, accountId, m);
      return { next, meta: { from: m.status, retry: true, purgeAfter: m.purgeAfter?.toISOString() ?? null }, also };
    }
    const purgeAfter = new Date(deps.clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY_MS);
    const next = await moveTo(deps, repos, m, "deleting", purgeAfter);
    const aliases = (await repos.aliases.listByAccount(accountId)).filter((a) => a.mailboxId === m.id).length;
    const catchAllOff = await turnOffCatchAllFor(deps, repos, m.id);
    const also = await dropMailboxGrants(repos, accountId, m);
    return {
      next,
      meta: {
        from: m.status,
        purgeAfter: purgeAfter.toISOString(),
        aliases,
        ...(catchAllOff.length > 0 ? { catchAllOff } : {}),
        ...(also.length > 0 ? { grantsRevoked: also.length } : {}),
      },
      also,
    };
  });
}

/**
 * Restores a mailbox during its grace period: the worker turns access and its aliases back on. Refused once the
 * grace period has ended, or when the mailbox's domain is no longer this account's.
 */
export async function restoreMailbox(
  deps: Deps,
  actor: Actor,
  accountId: string,
  id: string,
  req: RequestMeta,
  hasher: PasswordHasher,
): Promise<MailboxView> {
  return lifecycle(deps, actor, accountId, id, req, "mailbox.restored", async (repos, m) => {
    if (m.status !== "deleting") throw new ConflictError("This mailbox isn't being deleted.");
    if (m.purgeAfter !== null && m.purgeAfter <= deps.clock.now()) {
      throw new ConflictError("This mailbox's grace period has ended, so it can't be restored.");
    }
    await assertNotHeld(repos, accountId, m.id, m.userId);
    await assertDomainHeld(repos, accountId, m.address);
    const next = await moveTo(deps, repos, m, "provisioning", null);
    await queueWaitingPassword(deps, repos, hasher, m);
    return { next };
  });
}

/**
 * A resume or restore applies a password still waiting from while the mailbox was off (an administrator's, or the
 * one that cut a leaver's sign-in off, `removeMember`); the worker keeps the account off until it lands, so the old
 * password never works again. The management proxy's grant is signed again here: the one stored with the hash only
 * lasts a short while, and a restore can come weeks later.
 */
async function queueWaitingPassword(
  deps: Deps,
  repos: Repositories,
  hasher: PasswordHasher,
  m: Mailbox,
): Promise<void> {
  if (m.stalwartId === null) return;
  const waiting = await repos.directory.getMailbox(m.id);
  if (!waiting?.pendingPasswordHash) return;
  const grant = hasher.grant?.({ externalId: m.stalwartId, passwordHash: waiting.pendingPasswordHash }) ?? null;
  await repos.mailboxPasswords.setPending(m.id, waiting.pendingPasswordHash, grant, {
    byOwner: waiting.pendingPasswordByOwner,
  });
  await repos.provisioning.enqueue({ kind: "mailbox.password", subjectId: m.id, runAfter: deps.clock.now() });
}

/**
 * A mailbox Anhourtec staff suspended (with its account or its person) resumes only when staff lift it, nothing in
 * a suspended account resumes, and nothing assigned to a suspended person resumes — even a mailbox the account had
 * suspended itself before the person was (it carries no hold). The account row lock serialises this with a staff
 * account suspension (which takes it too), so a resume can't slip in while the suspension is being applied.
 */
async function assertNotHeld(
  repos: Repositories,
  accountId: string,
  mailboxId: string,
  userId: string | null,
): Promise<void> {
  await repos.accounts.lock(accountId);
  if (
    (await repos.suspensions.account(accountId)) !== null ||
    (await repos.suspensions.holds([mailboxId])).length > 0 ||
    (userId !== null && (await repos.suspensions.person(userId)) !== null)
  ) {
    throw new ConflictError("Anhourtec suspended this mailbox. It comes back when the suspension is lifted.");
  }
}

/**
 * Anhourtec staff hold this mailbox (an investigation's evidence): its account or its person is suspended, or a staff
 * hold (`account`, `person`) is on it. Such a mailbox is never purged — not by its own deletion, not by an account
 * deletion (ADR-0025) — until staff lift it. An account deletion's own `deletion` hold doesn't count.
 */
export async function staffHeld(
  repos: Repositories,
  m: Pick<Mailbox, "id" | "accountId" | "userId">,
): Promise<boolean> {
  if ((await repos.suspensions.account(m.accountId)) !== null) return true;
  if (m.userId !== null && (await repos.suspensions.person(m.userId)) !== null) return true;
  return (await repos.suspensions.holds([m.id])).some((h) => h.kind !== "deletion");
}

const PURGE = { kind: "system", name: "mailbox-purge" } as const;

/** Per scheduler run: at most this many mailboxes (the rest wait for the next run). */
export const PURGE_BATCH = 25;

/**
 * Scheduler: permanently removes mailboxes whose grace period has ended — the mail-server account (and its mail)
 * first, then the mailbox and alias rows, which frees their addresses. Each one is audited in its account's log as
 * `platform.mailbox_purged` by the system; a failure is audited as `failed` and retried on the next run. A mailbox
 * staff hold (`staffHeld`) is skipped (`held`, not audited: nothing changed) until they lift it.
 */
export async function purgeDueMailboxes(
  deps: Deps,
  mail: MailServer,
  limit = PURGE_BATCH,
): Promise<{ purged: number; failed: number; held: number }> {
  const due = await deps.uow.run((r) => r.mailboxes.dueForPurge(deps.clock.now(), limit));
  const out = { purged: 0, failed: 0, held: 0 };
  for (const m of due) {
    if (await deps.uow.run((r) => staffHeld(r, m))) {
      out.held += 1;
      continue;
    }
    try {
      await mutation(
        deps,
        PURGE,
        { requestId: `purge-${m.id}`, ip: null, userAgent: null },
        {
          action: "platform.mailbox_purged",
          permission: "mailbox.manage",
          accountId: m.accountId,
          target: { type: "mailbox", id: m.id, label: m.address },
        },
        async (repos) => {
          const current = await repos.mailboxes.get(m.accountId, m.id);
          const now = deps.clock.now();
          if (current?.status !== "deleting" || current.purgeAfter === null || current.purgeAfter > now) {
            throw new ConflictError("The mailbox changed before it could be removed."); // e.g. restored meanwhile
          }
          // Staff suspended its account or person since the check above: keep it. The account lock serialises this with
          // an account suspension (which takes it too).
          await repos.accounts.lock(m.accountId);
          if (await staffHeld(repos, current)) throw new ConflictError("Anhourtec holds this mailbox.");
          const own = (await repos.aliases.listByAccount(m.accountId)).filter((a) => a.mailboxId === m.id);
          const aliases = own.length;
          // Grants are dropped when the deletion is scheduled; any left (a backstop) go on record with the row.
          const also = await dropMailboxGrants(repos, m.accountId, current);
          // Delete the row first (conditional: still deleting and due), which also locks it until this unit of work
          // ends: a restore arriving now waits, then finds nothing to restore (409) instead of reporting success for
          // a mailbox whose mail is being destroyed. If the mail server refuses, everything rolls back.
          if (!(await repos.mailboxes.deleteIfDue(m.id, now))) {
            throw new ConflictError("The mailbox changed before it could be removed.");
          }
          await mail.destroyMailbox({ externalId: current.stalwartId, address: current.address });
          // Its platform-domain addresses (the mailbox and its masked aliases) never go to another account (ADR-0021).
          const retired = [current.address, ...own.map((a) => a.address)].filter((a) =>
            onPlatformDomain(a, deps.platform),
          );
          for (const a of retired) await repos.platformAddresses.retire(a, m.accountId, now);
          return {
            result: undefined,
            meta: {
              aliases,
              purgeAfter: current.purgeAfter.toISOString(),
              ...(retired.length > 0 ? { retiredPlatformAddresses: retired.length } : {}),
            },
            also,
          };
        },
      );
      out.purged += 1;
    } catch {
      out.failed += 1; // audited as `failed` by mutation(); retried on the next run
    }
  }
  return out;
}
