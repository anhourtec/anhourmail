// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Invite codes as services (ADR-0029 §8; slice 12): staff create, list and revoke them; customers redeem a comp code on
 * the Billing page; sign-up redeems a code after the account exists. The code is shown once at creation and stored as
 * its sha256 only; it never appears in audit entries or logs. Every way a code can be wrong (unknown, used, expired,
 * revoked, bound to another email, or not the kind this place accepts) gets the same answer: 404
 * `invite_code_invalid`, so nothing can be learned by guessing.
 *
 * Permissions: a sign-up-only code needs `platform.invites.manage` (Global and Support Administrators); any code that
 * comps a plan needs `platform.billing.manage` ★ (Global and Billing Administrators) and a fresh step-up. No customer
 * issues codes in v1.
 */
import type { PaidPlanId } from "@anhourmail/shared/plans";

import { type Actor, can } from "../actor";
import { ConflictError, EmailUnverifiedError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { authorizeAudited, mutation, type MutationOutcome, type MutationSpec } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import type { InviteCode, InviteCodeStatus } from "./entity";
import { BillingError } from "./entitlements";
import { applyCompInUnit } from "./grants";
import { type BillingSession, billingTarget, refuse, refuseActAs, requireStepUp } from "./guards";
import {
  hashInviteCode,
  INVITE_CODE_LABEL_MAX,
  INVITE_CODE_MAX_DAYS,
  inviteCodePermission,
  inviteCodeSpecProblem,
  type InviteCodeSpec,
  inviteCodeStatus,
  newInviteCode,
  normaliseCodeEmail,
  normaliseInviteCode,
} from "./invite-codes";

const DAY_MS = 86_400_000;
const isId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** The one answer for a code that can't be used here. */
export const invalidInviteCode = (): BillingError => {
  const e = new BillingError("invite_code_invalid", "That code isn't valid. Check it, or ask whoever sent it.");
  e.auditDenied = true;
  return e;
};

export type InviteCodeInput = {
  label?: unknown;
  grantsSignup?: unknown;
  compPlan?: unknown;
  compDays?: unknown;
  email?: unknown;
  /** Days until it expires (1–90). */
  expiresInDays?: unknown;
};

/** The code to create, from the request (400 with what's wrong). */
export function parseInviteCodeInput(input: InviteCodeInput, now: Date): InviteCodeSpec {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (input.label !== undefined && typeof input.label !== "string")
    throw new ValidationError("Write the note as text.");
  if (label.length > INVITE_CODE_LABEL_MAX || /[\p{Cc}]/u.test(label)) {
    throw new ValidationError(`Keep the note under ${String(INVITE_CODE_LABEL_MAX)} characters, on one line.`);
  }
  const compPlan = input.compPlan === "" ? null : (input.compPlan ?? null);
  if (compPlan !== null && compPlan !== "plus" && compPlan !== "supporter") {
    throw new ValidationError("Comp Plus or Supporter.");
  }
  const compDays = input.compDays ?? null;
  if (compDays !== null && typeof compDays !== "number") throw new ValidationError("Give the comp's days as a number.");
  const days = input.expiresInDays;
  if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > INVITE_CODE_MAX_DAYS) {
    throw new ValidationError(`A code expires within 1 to ${String(INVITE_CODE_MAX_DAYS)} days.`);
  }
  const rawEmail = input.email ?? "";
  if (typeof rawEmail !== "string" || rawEmail.length > 320)
    throw new ValidationError("Bind the code to an email address.");
  const email = rawEmail.trim() === "" ? null : normaliseCodeEmail(rawEmail);
  const spec: InviteCodeSpec = {
    label,
    grantsSignup: input.grantsSignup === true,
    compPlan,
    compDays,
    email,
    expiresAt: new Date(now.getTime() + days * DAY_MS),
  };
  const problem = inviteCodeSpecProblem(spec, now);
  if (problem) throw new ValidationError(problem);
  // A bound code's plan starts only on a confirmed email (run-67 N2), so it can't come with sign-up itself.
  if (spec.email !== null && spec.grantsSignup && spec.compPlan !== null) {
    throw new ValidationError(
      "A code bound to an email can't both open sign-up and give a plan: make a sign-up code and a plan code, or leave it unbound.",
    );
  }
  return spec;
}

/** An invite code as staff see it: never its hash. */
export type InviteCodeView = Omit<InviteCode, "codeHash"> & { status: InviteCodeStatus };

const view = (c: InviteCode, now: Date): InviteCodeView => {
  const { codeHash: _hash, ...rest } = c;
  return { ...rest, status: inviteCodeStatus(c, now) };
};

/** Staff who may see codes at all: either permission. */
const seesCodes = (actor: Actor) => can(actor, "platform.invites.manage") || can(actor, "platform.billing.manage");

/**
 * Staff: create a code. Every staff role passes the route's outer gate (`platform.accounts.read`); the code's kind then
 * picks the permission it needs (403 otherwise, audited in the platform log). Comp codes need a fresh step-up. Returns
 * the code once — it can't be shown again. Audited `platform.invite_code_created` (what it grants, its expiry, whether
 * it is bound; never the code or the bound address).
 */
export async function createInviteCode(
  deps: Deps,
  actor: Actor,
  input: InviteCodeInput,
  session: BillingSession,
  req: RequestMeta,
): Promise<{ code: string; invite: InviteCodeView }> {
  const outer: MutationSpec = {
    action: "platform.invite_code_created",
    permission: "platform.accounts.read",
    accountId: null,
    target: { type: "invite_code" },
  };
  await authorizeAudited(deps, actor, req, outer);
  const now = deps.clock.now();
  const spec = parseInviteCodeInput(input, now);
  const ms: MutationSpec = { ...outer, permission: inviteCodePermission(spec) };
  await authorizeAudited(deps, actor, req, ms);
  if (actor.kind !== "user") throw new ForbiddenError();
  if (spec.compPlan !== null) await requireStepUp(deps, actor, req, ms, session);
  const { code, codeHash } = newInviteCode();
  return mutation(deps, actor, req, ms, async (r) => {
    const created = await r.inviteCodes.create({
      codeHash,
      label: spec.label,
      grantsSignup: spec.grantsSignup,
      compPlan: spec.compPlan,
      compDays: spec.compDays,
      email: spec.email,
      createdBy: actor.userId,
      expiresAt: spec.expiresAt,
      at: now,
    });
    return {
      result: { code, invite: view(created, now) },
      target: { id: created.id, label: spec.label || null },
      meta: {
        grantsSignup: spec.grantsSignup,
        compPlan: spec.compPlan,
        compDays: spec.compDays,
        expiresAt: spec.expiresAt.toISOString(),
        bound: spec.email !== null,
      },
    };
  });
}

/** Staff with `platform.invites.manage` or `platform.billing.manage`: the codes, newest first (403 for others). */
export async function listInviteCodes(deps: Deps, actor: Actor, limit = 200): Promise<InviteCodeView[]> {
  if (actor.kind !== "user") throw new ForbiddenError();
  if (!seesCodes(actor) || actor.actingAs) throw new ForbiddenError();
  const now = deps.clock.now();
  return (await deps.uow.run((r) => r.inviteCodes.list(Math.min(Math.max(1, limit), 500)))).map((c) => view(c, now));
}

/**
 * Staff: revoke an unused code (permission by its kind, as at creation). Unknown → 404; already used or revoked → 409.
 * Audited `platform.invite_code_revoked`.
 */
export async function revokeInviteCode(
  deps: Deps,
  actor: Actor,
  codeId: string,
  req: RequestMeta,
): Promise<{ revoked: true }> {
  const outer: MutationSpec = {
    action: "platform.invite_code_revoked",
    permission: "platform.accounts.read",
    accountId: null,
    target: { type: "invite_code", id: isId(codeId) ? codeId : null },
  };
  await authorizeAudited(deps, actor, req, outer);
  const code = isId(codeId) ? await deps.uow.run((r) => r.inviteCodes.get(codeId)) : null;
  if (!code) {
    await mutation(deps, actor, req, outer, async () => ({ result: undefined, denied: { code: "not_found" } }));
    throw new NotFoundError();
  }
  const ms: MutationSpec = { ...outer, permission: inviteCodePermission(code) };
  if (actor.kind !== "user") throw new ForbiddenError();
  const out = await mutation(deps, actor, req, ms, async (r): Promise<MutationOutcome<boolean>> => {
    const ok = await r.inviteCodes.revoke(code.id, actor.userId, deps.clock.now());
    return ok
      ? { result: true, target: { label: code.label || null } }
      : { result: false, denied: { code: "already_used" } };
  });
  if (!out) throw new ConflictError("That code was already used or revoked.");
  return { revoked: true };
}

/**
 * `POST /api/accounts/:id/billing/redeem` (`billing.manage` ★: Owner, Billing Administrator; ADR-0029 §8): redeem a comp
 * code on an account that is on Free or lapsed (409 `already_subscribed` otherwise), with a confirmed console email that
 * matches the code's when it is bound. Any wrong code → 404 `invite_code_invalid`. The account gets the plan for the
 * code's days at once. Audited `billing.comp_redeemed` in the account's log and `platform.invite_code_redeemed` in the
 * platform log (never the code).
 */
export async function redeemInviteCode(
  deps: Deps,
  actor: Actor,
  accountId: string,
  input: { code?: unknown },
  req: RequestMeta,
): Promise<{ plan: PaidPlanId; until: Date }> {
  const spec: MutationSpec = {
    action: "billing.comp_redeemed",
    permission: "billing.manage",
    accountId,
    target: billingTarget(accountId),
  };
  await authorizeAudited(deps, actor, req, spec);
  await refuseActAs(deps, actor, req, spec);
  if (actor.kind !== "user") throw new ForbiddenError();
  const canonical = normaliseInviteCode(input.code);
  if (canonical === null) return refuse(deps, actor, req, spec, "invite_code_invalid", invalidInviteCode());
  const verified = await deps.uow.run((r) => r.access.emailVerified(actor.userId));
  if (!verified) return refuse(deps, actor, req, spec, "email_unverified", new EmailUnverifiedError());
  const codeHash = hashInviteCode(canonical);
  const email = normaliseCodeEmail(actor.email);
  type Out = { refused: "already_subscribed" | "invite_code_invalid" } | { plan: PaidPlanId; until: Date };
  const out = await mutation(deps, actor, req, spec, async (r): Promise<MutationOutcome<Out>> => {
    await r.accounts.lock(accountId);
    const now = deps.clock.now();
    const b = await r.billing.get(accountId);
    const account = await r.accounts.get(accountId);
    if (!account) throw new NotFoundError();
    const state = b?.state ?? (account.plan === "free" ? "free" : "active");
    if (state !== "free" && state !== "lapsed") {
      return { result: { refused: "already_subscribed" }, denied: { code: "already_subscribed" } };
    }
    // Only comp codes are redeemed here; a sign-up-only code is "not valid here" (the same answer as any other).
    const found = await r.inviteCodes.findRedeemable(codeHash, email, now);
    if (found?.compPlan == null || found.compDays === null) {
      return { result: { refused: "invite_code_invalid" }, denied: { code: "invite_code_invalid" } };
    }
    const claimed = await r.inviteCodes.claim({ codeHash, email, userId: actor.userId, accountId, now });
    if (claimed?.compPlan == null || claimed.compDays === null) {
      return { result: { refused: "invite_code_invalid" }, denied: { code: "invite_code_invalid" } };
    }
    const comp = await applyCompInUnit(deps, r, accountId, { plan: claimed.compPlan, days: claimed.compDays });
    if (!comp) throw new BillingError("invalid_change", "The account's plan changed meanwhile. Try again.");
    return {
      result: { plan: claimed.compPlan, until: comp.until },
      meta: { codeId: claimed.id, plan: claimed.compPlan, days: claimed.compDays, until: comp.until.toISOString() },
      also: [
        ...comp.also,
        {
          action: "platform.invite_code_redeemed",
          accountId: null,
          target: { type: "invite_code", id: claimed.id },
          meta: { accountId, plan: claimed.compPlan, days: claimed.compDays, at: "billing" },
        },
      ],
    };
  });
  if ("refused" in out) {
    if (out.refused === "already_subscribed") {
      throw new BillingError(
        "already_subscribed",
        "This account already has a paid plan: codes are for Free accounts.",
      );
    }
    throw invalidInviteCode();
  }
  return out;
}

/** A code claimed for a sign-up in progress: attach it once the person exists, or give it back. */
export type SignUpClaim = { codeId: string };

const SIGN_UP: Actor = { kind: "system", name: "sign-up" };

const signUpSpec = (action: "platform.invite_code_redeemed" | "platform.invite_code_released"): MutationSpec => ({
  action,
  permission: "self.profile.read",
  accountId: null,
  target: { type: "invite_code" },
});

/**
 * Sign-up (ADR-0029 §8, ADR-0031; run-67 N1, N2): the code's atomic claim **is** the admission. Called after the
 * proof-of-work and the sign-up limits, before the identity layer creates anyone: the code is claimed as pending for
 * this sign-up (redeemed, nobody attached yet), so a concurrent Billing redemption, a revocation or an expiry can't let
 * a second account in. With sign-up closed only a code that grants sign-up admits; with it open any redeemable code is
 * accepted (a sign-up-only one adds nothing). A code bound to an email that also gives a plan is refused here: its
 * plan must not start on an email nobody has confirmed yet (N2; redeem it on Billing once the email is confirmed).
 * Null is the one "not valid" answer. Audited `platform.invite_code_redeemed` (`stage: claimed`; denied
 * `invite_code_invalid`), never the code.
 */
export async function claimSignUpCode(
  deps: Deps,
  input: { code: unknown; email: string },
  opts: { signUpOpen: boolean },
  req: RequestMeta,
): Promise<SignUpClaim | null> {
  const canonical = normaliseInviteCode(input.code);
  if (canonical === null) return null;
  const codeHash = hashInviteCode(canonical);
  const email = normaliseCodeEmail(input.email);
  return mutation(deps, SIGN_UP, req, signUpSpec("platform.invite_code_redeemed"), async (r) => {
    const now = deps.clock.now();
    const found = await r.inviteCodes.findRedeemable(codeHash, email, now);
    const fits =
      found !== null &&
      (opts.signUpOpen || found.grantsSignup) &&
      // N2: a bound code's plan never starts on an unconfirmed email.
      !(found.email !== null && found.compPlan !== null);
    const claimed = fits ? await r.inviteCodes.claim({ codeHash, email, userId: null, accountId: null, now }) : null;
    if (!claimed) return { result: null, denied: { code: "invite_code_invalid" } };
    return {
      result: { codeId: claimed.id },
      target: { id: claimed.id },
      meta: { at: "sign-up", stage: "claimed", grantsSignup: claimed.grantsSignup, plan: claimed.compPlan },
    };
  });
}

/**
 * The sign-up a code was claimed for created no one (refused password, address in use, an error): the claim is given
 * back and the code is redeemable again until it expires. Audited `platform.invite_code_released`.
 */
export async function releaseSignUpCode(deps: Deps, claim: SignUpClaim, req: RequestMeta): Promise<boolean> {
  return mutation(deps, SIGN_UP, req, signUpSpec("platform.invite_code_released"), async (r) => {
    const ok = await r.inviteCodes.releaseClaim(claim.codeId);
    return ok
      ? { result: true, target: { id: claim.codeId }, meta: { at: "sign-up" } }
      : { result: false, target: { id: claim.codeId }, denied: { code: "not_pending" } };
  });
}

/**
 * After the sign-up a code was claimed for created its person (and account): attaches them to the claim and, for an
 * unbound comp code, gives the new account the plan for the code's days. Run outside account provisioning's own error
 * handling, so a failed provisioning still records who used the code (no account, no comp). Audited
 * `platform.invite_code_redeemed` (`stage: attached`) with `billing.comp_redeemed` in the new account's log.
 */
export async function completeSignUpCode(
  deps: Deps,
  input: SignUpClaim & { userId: string; accountId: string | null },
  req: RequestMeta,
): Promise<{ attached: boolean; comp: { plan: PaidPlanId; until: Date } | null }> {
  return mutation(
    deps,
    SIGN_UP,
    req,
    signUpSpec("platform.invite_code_redeemed"),
    async (r): Promise<MutationOutcome<{ attached: boolean; comp: { plan: PaidPlanId; until: Date } | null }>> => {
      const attached = await r.inviteCodes.attachClaim({
        id: input.codeId,
        userId: input.userId,
        accountId: input.accountId,
      });
      const code = attached ? await r.inviteCodes.get(input.codeId) : null;
      if (!code) {
        return {
          result: { attached: false, comp: null },
          target: { id: input.codeId },
          denied: { code: "not_pending" },
        };
      }
      const accountId = input.accountId;
      const comp =
        code.compPlan !== null && code.compDays !== null && code.email === null && accountId !== null
          ? await applyCompInUnit(deps, r, accountId, { plan: code.compPlan, days: code.compDays })
          : null;
      return {
        result: { attached: true, comp: comp && code.compPlan ? { plan: code.compPlan, until: comp.until } : null },
        target: { id: code.id },
        meta: {
          accountId,
          at: "sign-up",
          stage: "attached",
          grantsSignup: code.grantsSignup,
          plan: comp ? code.compPlan : null,
          days: comp ? code.compDays : null,
        },
        also:
          comp && accountId !== null
            ? [
                {
                  action: "billing.comp_redeemed",
                  accountId,
                  target: billingTarget(accountId),
                  meta: { codeId: code.id, plan: code.compPlan, days: code.compDays, until: comp.until.toISOString() },
                },
                ...comp.also,
              ]
            : [],
      };
    },
  );
}
