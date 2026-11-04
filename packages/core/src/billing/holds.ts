// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan holds after a downgrade to Free (ADR-0029 §6): what stays on and what is held, as a pure function. Holding never
 * deletes anything: a held mailbox keeps sign-in, reading and export for good and receives for
 * `BILLING.heldReceiveDays`; held domains stay on the mail server; held aliases are refused like disabled ones.
 */
import { BILLING, PLANS } from "@anhourmail/shared/plans";

import { ValidationError } from "../errors";

import type { PlanHoldInput } from "./entity";

const DAY_MS = 86_400_000;

export type HoldMailbox = {
  id: string;
  /** Its person, or null for a mailbox with no person (shared or unassigned). */
  userId: string | null;
  /** On the platform domain (`name@anhourmail.com`), not a custom domain. */
  platform: boolean;
  status: "provisioning" | "active" | "failed" | "suspended" | "deleting";
  createdAt: Date;
};

export type HoldAlias = {
  id: string;
  mailboxId: string;
  kind: "alias" | "masked";
  enabled: boolean;
  /** Its address is on the platform domain (an alias on a custom domain goes with the domain). */
  platform: boolean;
  createdAt: Date;
};

export type HoldResources = {
  /** The account's Owners (their own platform mailbox is the one kept by default). */
  ownerUserIds: readonly string[];
  mailboxes: readonly HoldMailbox[];
  /** Custom domains (every one is held on Free, which has none). */
  domainIds: readonly string[];
  aliases: readonly HoldAlias[];
};

/** The Owner's "Choose what stays on": a platform mailbox to keep, and which of its aliases (within Free's limits). */
export type HoldChoice = { mailboxId?: string; aliasIds?: readonly string[] };

export type HoldPlan = {
  keptMailboxId: string | null;
  keptAliasIds: string[];
  holds: PlanHoldInput[];
};

const oldestFirst = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** A mailbox in its deletion grace period is going away: it is neither kept nor held. */
const counts = (m: HoldMailbox) => m.status !== "deleting";

function defaultKept(r: HoldResources): HoldMailbox | null {
  const platform = r.mailboxes.filter((m) => counts(m) && m.platform).sort(oldestFirst);
  const owners = new Set(r.ownerUserIds);
  return platform.find((m) => m.userId !== null && owners.has(m.userId)) ?? platform[0] ?? null;
}

function defaultAliases(aliases: readonly HoldAlias[]): string[] {
  const free = PLANS.free;
  const pick = (kind: HoldAlias["kind"], limit: number | null) =>
    aliases
      .filter((a) => a.kind === kind)
      .sort(oldestFirst)
      .slice(0, limit ?? Number.MAX_SAFE_INTEGER)
      .map((a) => a.id);
  return [...pick("alias", free.aliases), ...pick("masked", free.maskedAliases)];
}

/**
 * The holds for an account that is dropping to (or already on) Free. Default, deterministic choice: keep the Owner's
 * own platform-domain mailbox (else the oldest platform-domain mailbox) and, on it, the oldest enabled aliases and
 * masked aliases up to Free's at-a-time limits. Everything else is held: every other mailbox (custom domains, other
 * people's, shared) with a receive window, every custom domain, every alias on a held mailbox or a custom domain, and
 * the kept mailbox's surplus aliases. Disabled aliases on the kept mailbox aren't held: they don't count and stay off.
 *
 * `choice` is the Owner's swap; it must fit Free (a platform mailbox in the account, its own enabled platform aliases,
 * within the limits) or a `ValidationError` names what doesn't.
 */
export function computeHolds(r: HoldResources, now: Date, choice: HoldChoice = {}): HoldPlan {
  const free = PLANS.free;
  let kept: HoldMailbox | null;
  if (choice.mailboxId !== undefined) {
    kept = r.mailboxes.find((m) => m.id === choice.mailboxId && counts(m)) ?? null;
    if (!kept) throw new ValidationError("Choose a mailbox in this account to keep.");
    if (!kept.platform)
      throw new ValidationError("Free keeps one mailbox on the platform domain, not a custom domain.");
  } else {
    kept = defaultKept(r);
  }

  const eligible = r.aliases.filter((a) => kept !== null && a.mailboxId === kept.id && a.platform && a.enabled);
  let keptAliasIds: string[];
  if (choice.aliasIds !== undefined) {
    const wanted = [...new Set(choice.aliasIds)];
    const byId = new Map(eligible.map((a) => [a.id, a]));
    const chosen = wanted.map((id) => byId.get(id));
    if (chosen.some((a) => a === undefined)) {
      throw new ValidationError("Only enabled aliases of the mailbox you keep, on the platform domain, can stay on.");
    }
    const n = (kind: HoldAlias["kind"]) => chosen.filter((a) => a?.kind === kind).length;
    if (free.aliases !== null && n("alias") > free.aliases) {
      throw new ValidationError(`Free keeps up to ${String(free.aliases)} aliases on.`);
    }
    if (free.maskedAliases !== null && n("masked") > free.maskedAliases) {
      throw new ValidationError(`Free keeps up to ${String(free.maskedAliases)} masked aliases on.`);
    }
    keptAliasIds = wanted;
  } else {
    keptAliasIds = defaultAliases(eligible);
  }

  const receiveUntil = new Date(now.getTime() + BILLING.heldReceiveDays * DAY_MS);
  const keptAliases = new Set(keptAliasIds);
  const holds: PlanHoldInput[] = [
    ...r.mailboxes
      .filter((m) => counts(m) && m.id !== kept?.id)
      .sort(oldestFirst)
      .map((m) => ({ subjectType: "mailbox" as const, subjectId: m.id, receiveUntil })),
    ...[...r.domainIds].sort().map((id) => ({ subjectType: "domain" as const, subjectId: id, receiveUntil: null })),
    ...r.aliases
      .filter((a) => {
        if (keptAliases.has(a.id)) return false;
        const onKept = kept !== null && a.mailboxId === kept.id;
        // A disabled platform alias on the kept mailbox stays as it is (off, not held).
        return !(onKept && a.platform && !a.enabled);
      })
      .filter((a) => r.mailboxes.some((m) => m.id === a.mailboxId && counts(m)))
      .sort(oldestFirst)
      .map((a) => ({ subjectType: "alias" as const, subjectId: a.id, receiveUntil: null })),
  ];
  return { keptMailboxId: kept?.id ?? null, keptAliasIds: [...keptAliases], holds };
}

/**
 * The Owner's swap keeps the receive windows already running: a mailbox that was held before keeps its date (a swap
 * can't restart the window), one newly held starts a fresh one.
 */
export function carryReceiveWindows(
  next: readonly PlanHoldInput[],
  current: readonly Pick<PlanHoldInput, "subjectType" | "subjectId" | "receiveUntil">[],
): PlanHoldInput[] {
  const was = new Map(current.map((h) => [`${h.subjectType}:${h.subjectId}`, h.receiveUntil]));
  return next.map((h) => {
    const prior = was.get(`${h.subjectType}:${h.subjectId}`);
    return prior !== undefined && h.subjectType === "mailbox" ? { ...h, receiveUntil: prior } : h;
  });
}
