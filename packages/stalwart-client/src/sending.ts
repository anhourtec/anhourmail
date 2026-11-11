// SPDX-License-Identifier: MIT
/**
 * One sending ceiling for every authenticated sender on the mail server (defence in depth behind the control plane's
 * own per-tier limits): two `x:MtaInboundThrottle` objects keyed by the authenticated account — so far per hour and per
 * day, counting MAIL transactions (465, 587 and JMAP submission share one allowance) — and `x:MtaStageRcpt`
 * `maxRecipients` for an authenticated session. The deployment's own system accounts (its transactional sender, the
 * RFC 2142 addresses) are left out, so transactional mail is never throttled by it. Verified on v0.16.27: the throttle
 * answers `452 4.4.5` at MAIL FROM, the RCPT cap `455 4.5.3`.
 *
 * It also writes `x:MtaStageRcpt.allowRelaying` with the relay hold first (`relay-hold.ts`): accounts on the hold list
 * may send only to addresses the server hosts, on every authenticated path.
 *
 * Numbers and names come from the caller (the deployment's facts); this module only writes and reads them. Idempotent:
 * objects are found again by their description, changed only when they differ, and settings are reloaded only then.
 */
import type { StalwartManagement } from "./management";
import { desiredRelaying, isDesiredRelaying } from "./relay-hold";

export type SendingPolicy = {
  messagesPerHour: number;
  messagesPerDay: number;
  /** Recipients per message for an authenticated (covered) session. */
  recipientsPerMessage: number;
  /** Recipients per message for every other session (port 25, the exempt accounts). */
  otherRecipientsPerMessage: number;
  /** Accounts the ceiling doesn't cover: these local parts on this domain. */
  exempt: { domain: string; localParts: readonly string[] };
};

export const SENDING_THROTTLE_DESCRIPTIONS = {
  hour: "AnhourMail sending ceiling: messages per hour per authenticated sender",
  day: "AnhourMail sending ceiling: messages per day per authenticated sender",
} as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Expression = { match: Record<string, { if: string; then: string }>; else: string };
type Throttle = {
  id: string;
  description?: string;
  enable?: boolean;
  key?: Record<string, boolean>;
  match?: Expression;
  rate?: { count?: number; period?: number };
};

/** A throttle as this module writes it. */
type DesiredThrottle = {
  description: string;
  enable: true;
  key: { authenticatedAs: true };
  match: Expression;
  rate: { count: number; period: number };
};

const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function checkPolicy(p: SendingPolicy): void {
  for (const n of [p.messagesPerHour, p.messagesPerDay, p.recipientsPerMessage, p.otherRecipientsPerMessage]) {
    if (!Number.isInteger(n) || n < 1) throw new Error("sending policy numbers must be positive integers");
  }
  if (!DOMAIN.test(p.exempt.domain)) throw new Error("sending policy exempt domain is not a plain domain");
  if (p.exempt.localParts.some((l) => !LOCAL.test(l))) {
    throw new Error("sending policy exempt local parts must be plain names");
  }
}

/**
 * The expression that is true for a session the ceiling covers: authenticated, and not one of the exempt accounts.
 * Every value is checked to be a plain name first, so nothing can close the quoted string.
 */
export function coveredSender(p: SendingPolicy): string {
  checkPolicy(p);
  const exempt = p.exempt.localParts.map((l) => `authenticated_as == '${l}@${p.exempt.domain}'`);
  return exempt.length === 0
    ? "!is_empty(authenticated_as)"
    : `!is_empty(authenticated_as) && !(${exempt.join(" || ")})`;
}

/** The two throttles as they should be (without ids). */
export function desiredThrottles(p: SendingPolicy): DesiredThrottle[] {
  const match: Expression = { match: {}, else: coveredSender(p) };
  return [
    {
      description: SENDING_THROTTLE_DESCRIPTIONS.hour,
      enable: true,
      key: { authenticatedAs: true },
      match,
      rate: { count: p.messagesPerHour, period: HOUR_MS },
    },
    {
      description: SENDING_THROTTLE_DESCRIPTIONS.day,
      enable: true,
      key: { authenticatedAs: true },
      match,
      rate: { count: p.messagesPerDay, period: DAY_MS },
    },
  ];
}

/** `x:MtaStageRcpt.maxRecipients` as it should be. */
export function desiredMaxRecipients(p: SendingPolicy): Expression {
  return {
    match: { "0": { if: coveredSender(p), then: String(p.recipientsPerMessage) } },
    else: String(p.otherRecipientsPerMessage),
  };
}

const sameExpression = (a: Expression | undefined, b: Expression): boolean => {
  if (a?.else !== b.else) return false;
  const ka = Object.keys(a.match);
  const kb = Object.keys(b.match);
  return (
    ka.length === kb.length &&
    kb.every((k) => a.match[k]?.if === b.match[k]?.if && a.match[k]?.then === b.match[k]?.then)
  );
};

const sameThrottle = (have: Throttle, want: DesiredThrottle): boolean =>
  have.enable === true &&
  Object.keys(have.key ?? {})
    .filter((k) => have.key?.[k] === true)
    .join() === "authenticatedAs" &&
  sameExpression(have.match, want.match) &&
  have.rate?.count === want.rate.count &&
  have.rate.period === want.rate.period;

const THROTTLE_FIELDS = ["description", "enable", "key", "match", "rate"];

async function read(
  mgmt: StalwartManagement,
): Promise<{ throttles: Throttle[]; maxRecipients?: Expression; allowRelaying?: unknown }> {
  const [throttles, stages] = await Promise.all([
    mgmt.transport.getAll<Throttle>("x:MtaInboundThrottle", THROTTLE_FIELDS),
    mgmt.transport.getAll<{ id: string; maxRecipients?: Expression; allowRelaying?: unknown }>(
      "x:MtaStageRcpt",
      ["maxRecipients", "allowRelaying"],
      ["singleton"],
    ),
  ]);
  const stage = stages[0];
  return {
    throttles,
    ...(stage?.maxRecipients === undefined ? {} : { maxRecipients: stage.maxRecipients }),
    ...(stage?.allowRelaying === undefined ? {} : { allowRelaying: stage.allowRelaying }),
  };
}

export type SendingPolicyResult = {
  created: number;
  updated: number;
  removed: number;
  recipientsChanged: boolean;
  /** `allowRelaying` was written (the relay hold wasn't in place as `desiredRelaying` has it). */
  relayingChanged: boolean;
};

/**
 * Writes the ceiling: creates or corrects the two throttles (a duplicate of ours is removed), sets the RCPT cap, then
 * reloads settings if anything changed. Never touches another throttle.
 */
export async function applySendingPolicy(mgmt: StalwartManagement, p: SendingPolicy): Promise<SendingPolicyResult> {
  const want = desiredThrottles(p);
  const have = await read(mgmt);
  const out: SendingPolicyResult = {
    created: 0,
    updated: 0,
    removed: 0,
    recipientsChanged: false,
    relayingChanged: false,
  };
  const create: Record<string, DesiredThrottle> = {};
  const destroy: string[] = [];
  want.forEach((w, i) => {
    const [first, ...extra] = have.throttles.filter((t) => t.description === w.description);
    if (!first) {
      create[`t${String(i)}`] = w;
      out.created += 1;
    } else if (!sameThrottle(first, w)) {
      // A throttle's description can't be changed and a partial update leaves other fields as they were (verified on
      // v0.16.27), so a changed one is replaced whole.
      destroy.push(first.id);
      create[`t${String(i)}`] = w;
      out.updated += 1;
    }
    for (const x of extra) {
      destroy.push(x.id);
      out.removed += 1;
    }
  });
  if (destroy.length > 0) await mgmt.transport.set("x:MtaInboundThrottle", { destroy });
  if (Object.keys(create).length > 0) await mgmt.transport.set("x:MtaInboundThrottle", { create });
  const cap = desiredMaxRecipients(p);
  if (!sameExpression(have.maxRecipients, cap)) {
    await mgmt.updateSingleton("x:MtaStageRcpt", { maxRecipients: cap });
    out.recipientsChanged = true;
  }
  if (!isDesiredRelaying(have.allowRelaying)) {
    await mgmt.updateSingleton("x:MtaStageRcpt", { allowRelaying: desiredRelaying() });
    out.relayingChanged = true;
  }
  if (out.created + out.updated + out.removed > 0 || out.recipientsChanged || out.relayingChanged) {
    await mgmt.reloadSettings();
  }
  return out;
}

/**
 * What differs from the ceiling on the mail server, by name (`throttle-hour-missing`, `throttle-day-changed`,
 * `throttle-duplicate`, `max-recipients-changed`, `relaying-changed`); empty when it is in place. Read only (the
 * reconciler).
 */
export async function sendingPolicyDrift(mgmt: StalwartManagement, p: SendingPolicy): Promise<string[]> {
  const have = await read(mgmt);
  const out: string[] = [];
  const names = ["hour", "day"] as const;
  desiredThrottles(p).forEach((w, i) => {
    const ours = have.throttles.filter((t) => t.description === w.description);
    const name = names[i] ?? "throttle";
    if (ours[0] === undefined) out.push(`throttle-${name}-missing`);
    else if (!sameThrottle(ours[0], w)) out.push(`throttle-${name}-changed`);
    if (ours.length > 1) out.push(`throttle-${name}-duplicate`);
  });
  if (!sameExpression(have.maxRecipients, desiredMaxRecipients(p))) out.push("max-recipients-changed");
  if (!isDesiredRelaying(have.allowRelaying)) out.push("relaying-changed");
  return out;
}
