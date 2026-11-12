// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trust tier changes (ADR-0034 §2, §6). Every change writes the account row (or the mailbox restriction), its audit
 * entries and a `mailbox.ensure` job for each mailbox it affects in one unit of work (rules 26, 46), so the mail server
 * follows (`mailboxSendAccess`). The webmail reads the tier uncached, so its enforcement is immediate.
 *
 * - **Staff** (`platform.trust.manage`: Global and Trust & Safety Administrators) set an account's tier to `new`,
 *   `standard` or `restricted`, and restrict or lift one mailbox's sending. A fresh step-up is needed, and never while
 *   acting as someone (403). A reason category is needed to restrict and to move off `restricted`; a note (1–2,000
 *   characters) always. `trusted` is reserved (422 `tier_unavailable`) until the mail server can hold per-tier numbers.
 *   Unknown accounts and mailboxes of another account are 404. `automatic: true` (only `new` or `standard`) leaves the
 *   job and billing free to move the account again; otherwise the staff source freezes it.
 * - **The system** promotes `new` → `standard`: the hourly job for established accounts in good standing (source
 *   `automatic`), and billing when an `active` account pays real money for its plan (source `billing`). Neither touches a staff-set
 *   tier, a `restricted` account or an account ever restricted. Billing takes its own promotion back on a refund, a
 *   dispute, or a plan that ends inside the refund window (`revokeBillingPromotion`).
 *
 * The staff note is staff-only: never in an audit entry, a log line or anything a customer reads (`accountSending`).
 * Every entry is in the account's own log (rule 49) with a copy in the platform log; the reason is shown in plain words.
 */
import { isSuspensionReason, SUSPENSION_REASONS, type SuspensionReason } from "@anhourmail/shared/platform";
import type { AccountRole } from "@anhourmail/shared/rbac";
import {
  isStaffSettableTrustTier,
  type SendLimits,
  type StaffSettableTrustTier,
  TRUST_TIERS,
  type TrustTier,
  type TrustTierSource,
} from "@anhourmail/shared/sending";

import { type Actor, authorize, can } from "../actor";
import type { AuditAction } from "../audit/catalogue";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
  ValidationError,
} from "../errors";
import type { MailboxStatus } from "../mailboxes/entity";
import { type AuditAlso, authorizeAudited, mutation, type MutationOutcome, type SystemChange } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";

import type { AccountTrust, MailboxSendingRestriction, PromotionCriteria } from "./entity";

/** Longest staff note kept (characters). */
export const TRUST_NOTE_MAX = 2000;

/** The tier staff asked for isn't one they may set (`trusted`, ADR-0034 §2): HTTP 422. */
export class TierUnavailableError extends DomainError {
  constructor() {
    super("That tier isn't available yet.", "tier_unavailable");
  }
}

/** Mailbox states whose access on the mail server follows the tier now (suspended and deleting ones are off). */
const USABLE: readonly MailboxStatus[] = ["active", "provisioning", "failed"];

/** Account roles told about a restriction (Owners and the administrators), as for a suspension. */
const NOTIFIED_ROLES: readonly AccountRole[] = ["owner", "domain_admin", "user_admin", "billing_admin"];

const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

type Session = { sessionId: string | null };
type Refusal = "act_as" | "step_up_required" | "tier_unavailable";

function throwRefusal(r: Refusal): never {
  switch (r) {
    case "act_as":
      throw new ForbiddenError("Trust tiers can't be changed while acting as someone.");
    case "step_up_required":
      throw new StepUpRequiredError();
    case "tier_unavailable":
      throw new TierUnavailableError();
  }
}

/** Act-as and step-up checks shared by every staff change (refusals are audited as denied). */
async function staffChecks(deps: Deps, repos: Repositories, actor: Actor, session: Session): Promise<Refusal | null> {
  if (actor.kind !== "user") throw new ForbiddenError();
  if (actor.actingAs) return "act_as";
  if (!session.sessionId || !(await repos.security.stepUpFresh(actor.userId, session.sessionId, deps.clock.now()))) {
    return "step_up_required";
  }
  return null;
}

/** The trimmed note (required, 1–2,000 characters), or a 400. */
export function parseTrustNote(note: unknown): string {
  if (typeof note !== "string" || note.trim() === "") throw new ValidationError("Add an internal note.");
  const trimmed = note.trim();
  if (trimmed.length > TRUST_NOTE_MAX) {
    throw new ValidationError(`Keep the internal note under ${String(TRUST_NOTE_MAX)} characters.`);
  }
  return trimmed;
}

/** The reason category when given (a 400 for an unknown one), else null; `required` makes it a 400 when missing. */
function parseReason(reason: unknown, required: boolean): SuspensionReason | null {
  if (reason === undefined || reason === null || reason === "") {
    if (required) throw new ValidationError("Choose a reason.");
    return null;
  }
  if (!isSuspensionReason(reason)) throw new ValidationError("Choose a reason.");
  return reason;
}

/** Queues `mailbox.ensure` for the account's usable mailboxes; returns how many. */
async function ensureMailboxes(deps: Deps, r: Repositories, accountId: string): Promise<number> {
  let queued = 0;
  for (const m of await r.mailboxes.listByAccount(accountId)) {
    if (!USABLE.includes(m.status)) continue;
    await r.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: m.id, runAfter: deps.clock.now() });
    queued += 1;
  }
  return queued;
}

async function notifyList(r: Repositories, accountId: string): Promise<{ email: string }[]> {
  return (await r.access.members(accountId))
    .filter((m) => NOTIFIED_ROLES.includes(m.role))
    .map((m) => ({ email: m.email }));
}

/** How often an account's owners get a restriction notice, at most (ADR-0034 §5, build slice 19). */
export const RESTRICTION_NOTICE_EVERY_MS = 86_400_000;

/**
 * Who to email about a restriction made now, and the `trust.restriction_notice_sent` entry to record with it, inside
 * the restriction's unit of work under the account lock: nobody (and no entry) when the account already had a notice in
 * the last day, or has nobody to tell. The entry carries what was restricted, the reason category and how many people
 * are told (`notified`) — never an address or the staff note (rules 24, 48; not `subject` or `recipients`, which the
 * redaction list hides as mail headers). The route sends the email after the commit.
 */
async function restrictionNotice(
  deps: Deps,
  r: Repositories,
  accountId: string,
  what: "account" | "mailbox",
  reason: SuspensionReason,
  target: { type: "account" | "mailbox"; id: string },
): Promise<{ notify: { email: string }[]; also: AuditAlso[] }> {
  const since = new Date(deps.clock.now().getTime() - RESTRICTION_NOTICE_EVERY_MS);
  const recent = await r.audit.list({
    scope: `account:${accountId}`,
    action: "trust.restriction_notice_sent",
    from: since,
    limit: 1,
  });
  if (recent.length > 0) return { notify: [], also: [] };
  const notify = await notifyList(r, accountId);
  if (notify.length === 0) return { notify, also: [] };
  return {
    notify,
    also: [
      {
        action: "trust.restriction_notice_sent",
        target,
        meta: { restricted: what, reason: SUSPENSION_REASONS[reason], reasonCategory: reason, notified: notify.length },
      },
    ],
  };
}

/** The audit action for a move between tiers (ADR-0034 §2 "Audit"). */
export function tierChangeAction(from: TrustTier, to: TrustTier): AuditAction {
  if (to === "restricted" && from !== "restricted") return "trust.restricted";
  if (from === "restricted" && to !== "restricted") return "trust.unrestricted";
  return "trust.tier_changed";
}

/**
 * The meta each action carries (never the note). `fromTier` / `toTier`, not `from` / `to`: those are redacted
 * everywhere as mail headers.
 */
function tierChangeMeta(from: TrustTier, to: TrustTier, source: TrustTierSource, reason: SuspensionReason | null) {
  const why = reason ? { reason: SUSPENSION_REASONS[reason], reasonCategory: reason } : {};
  switch (tierChangeAction(from, to)) {
    case "trust.restricted":
      return { fromTier: from, source, ...why };
    case "trust.unrestricted":
      return { toTier: to, source, ...why };
    default:
      return { fromTier: from, toTier: to, source, ...why };
  }
}

/** Refusals before the subject is known: audited in the platform log, then 403 / 404. */
async function knownOr404<T>(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: { action: AuditAction; target: { type: string } },
  load: (r: Repositories) => Promise<T | null>,
  valid: boolean,
): Promise<T> {
  const platformSpec = { ...spec, permission: "platform.trust.manage", accountId: null } as const;
  await authorizeAudited(deps, actor, req, platformSpec);
  const found = valid ? await deps.uow.run(load) : null;
  if (found === null) {
    await mutation(deps, actor, req, platformSpec, async () => ({ result: undefined, denied: { code: "not_found" } }));
    throw new NotFoundError();
  }
  return found;
}

export type SetTierInput = { tier?: unknown; reason?: unknown; note?: unknown; automatic?: unknown };

export type SetTierResult = {
  accountName: string;
  from: TrustTier;
  to: StaffSettableTrustTier;
  source: TrustTierSource;
  reason: SuspensionReason | null;
  mailboxesQueued: number;
  /**
   * Owners and administrators to email when the account was restricted now (empty otherwise, and when the account had
   * a restriction notice in the last day: `RESTRICTION_NOTICE_EVERY_MS`).
   */
  notify: { email: string }[];
};

/** Staff set an account's tier (see the module comment). 409 when it already has that tier from that source. */
export async function setAccountTier(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: SetTierInput,
  session: Session,
  req: RequestMeta,
): Promise<SetTierResult> {
  const known = await knownOr404(
    deps,
    actor,
    req,
    { action: "trust.tier_changed", target: { type: "account" } },
    async (r) => {
      const account = await r.accounts.get(accountId);
      const trust = account ? await r.trust.get(accountId) : null;
      return account && trust ? { account, trust } : null;
    },
    isId(accountId),
  );
  const asked = isStaffSettableTrustTier(input.tier) ? input.tier : null;
  // The action follows the move as read now; a move that changes kind (into or out of restricted) while we work is a 409.
  const action = asked ? tierChangeAction(known.trust.tier, asked) : "trust.tier_changed";
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action,
      permission: "platform.trust.manage",
      accountId,
      target: { type: "account", id: accountId, label: known.account.name },
      staffPath: true,
    },
    async (repos): Promise<MutationOutcome<SetTierResult | Refusal>> => {
      const refusal = await staffChecks(deps, repos, actor, session);
      if (refusal) return { result: refusal, denied: { code: refusal } };
      if (input.tier === "trusted") return { result: "tier_unavailable", denied: { code: "tier_unavailable" } };
      if (!asked) throw new ValidationError("Choose a tier: new, standard or restricted.");
      if (input.automatic !== undefined && typeof input.automatic !== "boolean") {
        throw new ValidationError("automatic must be true or false.");
      }
      const automatic = input.automatic === true;
      if (automatic && asked === "restricted") {
        throw new ValidationError("A restricted tier is always set by staff, never automatic.");
      }
      const note = parseTrustNote(input.note);
      await repos.accounts.lock(accountId);
      const current = await repos.trust.get(accountId);
      if (!current) throw new NotFoundError();
      if (tierChangeAction(current.tier, asked) !== action) {
        throw new ConflictError("This account's tier changed meanwhile. Reload and try again.");
      }
      const leaving = current.tier === "restricted" && asked !== "restricted";
      const reason = parseReason(input.reason, asked === "restricted" || leaving);
      const source: TrustTierSource = automatic ? "automatic" : "staff";
      if (current.tier === asked && current.source === source) {
        throw new ConflictError("This account already has that tier.");
      }
      const now = deps.clock.now();
      const userId = actor.kind === "user" ? actor.userId : null;
      await repos.trust.setTier(accountId, { tier: asked, since: now, source, reason, note, setBy: userId });
      if (asked === "restricted") await repos.trust.markRestricted(accountId, now);
      const mailboxesQueued = await ensureMailboxes(deps, repos, accountId);
      const meta = { ...tierChangeMeta(current.tier, asked, source, reason), mailboxesQueued };
      const restrictedNow = asked === "restricted" && current.tier !== "restricted";
      const notice =
        restrictedNow && reason
          ? await restrictionNotice(deps, repos, accountId, "account", reason, { type: "account", id: accountId })
          : { notify: [], also: [] };
      return {
        result: {
          accountName: known.account.name,
          from: current.tier,
          to: asked,
          source,
          reason,
          mailboxesQueued,
          notify: notice.notify,
        },
        meta,
        // Staff see every trust change in the platform log too; neither entry carries the note.
        copies: [{ accountId: null, meta: { ...meta, accountId } }],
        also: notice.also,
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

export type MailboxRestrictionInput = { restricted?: unknown; reason?: unknown; note?: unknown };

export type MailboxRestrictionResult = {
  accountName: string;
  address: string;
  restricted: boolean;
  reason: SuspensionReason;
  /**
   * Owners and administrators to email when the mailbox was restricted now (empty when lifted, and when the account had
   * a restriction notice in the last day).
   */
  notify: { email: string }[];
};

/**
 * Staff restrict or lift one mailbox's sending (ADR-0034 §6). The account's `last_restricted_at` moves either way the
 * mailbox is restricted, so the account is never promoted automatically afterwards. 409 when already in that state.
 */
export async function setMailboxRestriction(
  deps: Deps,
  actor: Actor,
  accountId: string,
  mailboxId: string,
  input: MailboxRestrictionInput,
  session: Session,
  req: RequestMeta,
): Promise<MailboxRestrictionResult> {
  const action: AuditAction = input.restricted === false ? "trust.mailbox_unrestricted" : "trust.mailbox_restricted";
  const known = await knownOr404(
    deps,
    actor,
    req,
    { action, target: { type: "mailbox" } },
    async (r) => {
      const account = await r.accounts.get(accountId);
      const mailbox = account ? await r.trust.mailbox(accountId, mailboxId) : null;
      return account && mailbox ? { account, mailbox } : null;
    },
    isId(accountId) && isId(mailboxId),
  );
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action,
      permission: "platform.trust.manage",
      accountId,
      target: { type: "mailbox", id: mailboxId, label: known.mailbox.address },
      staffPath: true,
    },
    async (repos): Promise<MutationOutcome<MailboxRestrictionResult | Refusal>> => {
      const refusal = await staffChecks(deps, repos, actor, session);
      if (refusal) return { result: refusal, denied: { code: refusal } };
      if (typeof input.restricted !== "boolean") throw new ValidationError("restricted must be true or false.");
      const restricted = input.restricted;
      const reason = parseReason(input.reason, true);
      if (!reason) throw new ValidationError("Choose a reason.");
      const note = parseTrustNote(input.note);
      await repos.accounts.lock(accountId);
      const current = await repos.trust.mailbox(accountId, mailboxId);
      if (!current) throw new NotFoundError();
      if ((current.restriction !== null) === restricted) {
        throw new ConflictError(
          restricted ? "This mailbox's sending is already restricted." : "This mailbox's sending isn't restricted.",
        );
      }
      const now = deps.clock.now();
      const record: MailboxSendingRestriction | null = restricted
        ? { at: now, reason, note, byUserId: actor.kind === "user" ? actor.userId : null }
        : null;
      if (!(await repos.trust.setMailboxRestriction(accountId, mailboxId, record))) throw new NotFoundError();
      if (restricted) await repos.trust.markRestricted(accountId, now);
      await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: mailboxId, runAfter: now });
      const meta = { reason: SUSPENSION_REASONS[reason], reasonCategory: reason };
      const notice = restricted
        ? await restrictionNotice(deps, repos, accountId, "mailbox", reason, { type: "mailbox", id: mailboxId })
        : { notify: [], also: [] };
      return {
        result: {
          accountName: known.account.name,
          address: current.address,
          restricted,
          reason,
          notify: notice.notify,
        },
        meta,
        copies: [{ accountId: null, meta: { ...meta, accountId } }],
        also: notice.also,
      };
    },
  );
  if (typeof out === "string") throwRefusal(out);
  return out;
}

/** Whether an account's tier may be moved by the system now (the job or billing): never a staff-set or restricted one. */
const systemMayPromote = (t: AccountTrust): boolean =>
  t.tier === "new" && t.source !== "staff" && t.lastRestrictedAt === null;

/**
 * Billing's promotion (ADR-0034 §2): inside the billing sync's unit of work, under the account lock it holds, a `new`
 * account whose billing state is `active` and that paid real money for its plan (`tierAfterBilling` in
 * `billing/sync.ts`: a charged, non-zero first or renewal invoice, `realChargePaid`) becomes `standard` with source
 * `billing`, and its mailboxes are queued so the mail server follows. The sync is the only caller: a comp, a staff
 * grant, a 100 %-off code, a credit-paid invoice, an add-on or a trial never promotes (staff give `standard` with
 * `platform.trust.manage` instead). Only an `active` (not suspended) account; nothing here lowers a tier. Returns the
 * `trust.tier_changed` entry for the sync to record as the system (`recordSystemChanges`); none when nothing changed.
 */
export async function promoteForPayment(deps: Deps, r: Repositories, accountId: string): Promise<SystemChange[]> {
  const account = await r.accounts.get(accountId);
  const current = account ? await r.trust.get(accountId) : null;
  // A suspended account isn't promoted by paying while suspended.
  if (account?.status !== "active" || !current || !systemMayPromote(current)) return [];
  return promote(deps, r, current, "billing");
}

/** Why billing takes its promotion back (audit meta `cause`). */
export type BillingTierLoss = "refund" | "dispute" | "plan_ended";

/**
 * Takes billing's promotion back (security review of ADR-0034 slices 1–11, finding 2): inside the caller's unit of
 * work, under the account lock it holds, an account whose tier came from billing (`standard`, source `billing`) goes
 * back to `new` with source `default`, and its mailboxes are queued so the mail server follows. A staff-set, automatic
 * or restricted tier is never touched. `withinMs` limits it to a promotion at most that old (a plan that ended inside
 * the refund window). Returns the `trust.tier_changed` entry for the caller to record as the system; none when nothing
 * changed. The caller schedules the managed-script pause (the web app) or signals it (the worker).
 */
export async function revokeBillingPromotion(
  deps: Deps,
  r: Repositories,
  accountId: string,
  cause: BillingTierLoss,
  opts: { withinMs?: number } = {},
): Promise<SystemChange[]> {
  const current = await r.trust.get(accountId);
  if (current?.source !== "billing" || current.tier === "restricted" || current.tier === "new") return [];
  const now = deps.clock.now();
  if (opts.withinMs !== undefined && now.getTime() - current.since.getTime() > opts.withinMs) return [];
  await r.trust.setTier(accountId, {
    tier: "new",
    since: now,
    source: "default",
    reason: null,
    note: null,
    setBy: null,
  });
  const mailboxesQueued = await ensureMailboxes(deps, r, accountId);
  return [
    {
      action: "trust.tier_changed",
      accountId,
      target: { type: "account", id: accountId },
      meta: { fromTier: current.tier, toTier: "new", source: "default", cause, mailboxesQueued },
    },
  ];
}

async function promote(
  deps: Deps,
  r: Repositories,
  current: AccountTrust,
  source: "billing" | "automatic",
): Promise<SystemChange[]> {
  const { accountId } = current;
  const now = deps.clock.now();
  await r.trust.setTier(accountId, { tier: "standard", since: now, source, reason: null, note: null, setBy: null });
  const mailboxesQueued = await ensureMailboxes(deps, r, accountId);
  return [
    {
      action: "trust.tier_changed",
      accountId,
      target: { type: "account", id: accountId },
      meta: { fromTier: current.tier, toTier: "standard", source, mailboxesQueued },
    },
  ];
}

/**
 * The promotion job's step for one candidate (`promotionCandidates`), in the caller's unit of work: takes the account
 * lock, then checks again every condition the candidates were listed by (`qualifiesForPromotion`: a staff tier, a
 * restriction, the account's or a member's suspension, billing restricted or lapsed, an owner's unconfirmed email, the
 * held sends) before promoting it to `standard` with source `automatic`. A person's suspension locks every account of
 * theirs first, so it is either seen here or made after this commits (security review of ADR-0034 slices 1–11,
 * finding 5). Returns the audit entry to record as the system; none when the account no longer qualifies.
 */
export async function promoteEstablished(
  deps: Deps,
  r: Repositories,
  accountId: string,
  criteria: Omit<PromotionCriteria, "limit">,
): Promise<SystemChange[]> {
  await r.accounts.lock(accountId);
  const account = await r.accounts.get(accountId);
  const current = await r.trust.get(accountId);
  if (!account || !current || account.status !== "active" || !systemMayPromote(current)) return [];
  if (!(await r.trust.qualifiesForPromotion(accountId, criteria))) return [];
  return promote(deps, r, current, "automatic");
}

export type AccountSending = {
  tier: TrustTier;
  label: string;
  description: string;
  limits: SendLimits;
  /** Sending to addresses we don't host is held (a `new` account, ADR-0034 §3). */
  externalHeld: boolean;
  /** Mail apps may send over SMTP (`standard` and `trusted`). */
  mailAppsCanSend: boolean;
  /** Why the account is restricted, in plain words, when staff gave a reason. */
  reason?: { category: SuspensionReason; label: string };
};

/**
 * What an account's people see about its sending (`account.read`: every account role but Member, and staff acting
 * as; a Member sees their own mailbox's tier in the webmail, ADR-0034 update 2026-11-11). The
 * published facts for its tier only: never the staff note, who set it, when it was last restricted or what promotes
 * it (rule 33). Not audited (a read). Another account's id is 404.
 */
export async function accountSending(deps: Deps, actor: Actor, accountId: string): Promise<AccountSending> {
  authorize(actor, "account.read", accountId);
  const trust = await deps.uow.run((r) => r.trust.get(accountId));
  if (!trust) throw new NotFoundError();
  const info = TRUST_TIERS[trust.tier];
  return {
    tier: trust.tier,
    label: info.label,
    description: info.description,
    limits: info.limits,
    externalHeld: trust.tier === "new",
    mailAppsCanSend: trust.tier === "standard" || trust.tier === "trusted",
    ...(trust.tier === "restricted" && trust.reason
      ? { reason: { category: trust.reason, label: SUSPENSION_REASONS[trust.reason] } }
      : {}),
  };
}

export type StaffTrustView = {
  tier: TrustTier;
  source: TrustTierSource;
  since: Date;
  reason: SuspensionReason | null;
  /** Only with `platform.suspensionNotes.read`. */
  note?: string | null;
  setBy: string | null;
  lastRestrictedAt: Date | null;
  mailboxes: {
    mailboxId: string;
    address: string;
    restriction: { at: Date; reason: SuspensionReason; byUserId: string | null; note?: string | null } | null;
  }[];
};

/**
 * The staff Trust card (`platform.accounts.read`): the tier with its source, reason and dates, and each mailbox's
 * restriction. Notes only for readers with `platform.suspensionNotes.read`. Unknown account → 404. Not audited (a read).
 */
export async function staffAccountTrust(deps: Deps, actor: Actor, accountId: string): Promise<StaffTrustView> {
  authorize(actor, "platform.accounts.read");
  if (!isId(accountId)) throw new NotFoundError();
  const notes = can(actor, "platform.suspensionNotes.read");
  const found = await deps.uow.run(async (r) => {
    const trust = await r.trust.get(accountId);
    return trust ? { trust, mailboxes: await r.trust.mailboxes(accountId) } : null;
  });
  if (!found) throw new NotFoundError();
  const { trust } = found;
  return {
    tier: trust.tier,
    source: trust.source,
    since: trust.since,
    reason: trust.reason,
    ...(notes ? { note: trust.note } : {}),
    setBy: trust.setBy,
    lastRestrictedAt: trust.lastRestrictedAt,
    mailboxes: found.mailboxes.map((m) => ({
      mailboxId: m.mailboxId,
      address: m.address,
      restriction: m.restriction
        ? {
            at: m.restriction.at,
            reason: m.restriction.reason,
            byUserId: m.restriction.byUserId,
            ...(notes ? { note: m.restriction.note } : {}),
          }
        : null,
    })),
  };
}
