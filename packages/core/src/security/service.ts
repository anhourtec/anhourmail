// SPDX-License-Identifier: AGPL-3.0-only
import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";
import { isSignInPolicy, type SignInMethod, type SignInPolicy } from "@anhourmail/shared/security";

import { type Actor, authorize, can, type UserActor } from "../actor";
import type { AuditAction } from "../audit/catalogue";
import { actionLabel, describeActor, partialIp } from "../audit/labels";
import { maskEmail } from "../audit/record";
import type { AuditResult } from "../audit/types";
import { ConflictError, NotFoundError, StepUpRequiredError, ValidationError } from "../errors";
import { type MutationOutcome, mutation } from "../mutation";
import type { Deps, Repositories, RequestMeta } from "../ports";
import type { MissingFactor, PasskeyRecord, SecurityFactors, SessionRecord } from "./entity";
import {
  describeDevice,
  missingAfterRemoving,
  missingFactor,
  passkeyName,
  PASSWORDLESS_ENDED,
  sessionRefusal,
  strictestPolicy,
} from "./rules";

/**
 * Who a security event is about and how it was raised:
 * - `self`: the signed-in person did it (turned on two-factor sign-in, added a passkey, signed in);
 * - `identity`: the identity layer recorded it before anyone was signed in (a failed sign-in, a reset request).
 */
export type SecurityEventInput = {
  action: AuditAction;
  /** The person it concerns; null when unknown (e.g. a sign-in for an address with no login). */
  userId: string | null;
  email: string | null;
  by?: "self" | "identity";
  /** A refusal (wrong code, locked out) is recorded as `denied` with this code. */
  denied?: string;
  meta?: Record<string, unknown>;
};

/**
 * Audits a security event raised by the identity adapter (sign-ins, second steps, factor changes, resets). Goes
 * through `mutation()` like every write, in the platform scope with the person as the target, so their own Security
 * page can list it; the email is stored masked. Never codes, secrets or passkey material (rule 48).
 */
export async function recordSecurityEvent(deps: Deps, input: SecurityEventInput, req: RequestMeta): Promise<void> {
  const self = input.by === "self" && input.userId !== null && input.email !== null;
  const actor: Actor = self
    ? {
        kind: "user",
        userId: input.userId ?? "",
        email: input.email ?? "",
        platformRoles: [],
        memberships: [],
        suspended: false,
      }
    : { kind: "system", name: "identity" };
  await mutation(
    deps,
    actor,
    req,
    {
      action: input.action,
      permission: "self.profile.read",
      accountId: null,
      target: { type: "user", id: input.userId, label: input.email ? maskEmail(input.email) : null },
    },
    async () => ({
      result: undefined,
      meta: input.meta ?? {},
      ...(input.denied ? { denied: { code: input.denied } } : {}),
    }),
  );
}

export type SecurityActivityItem = {
  id: string;
  at: Date;
  action: string;
  label: string;
  result: AuditResult;
  /** "Firefox on Linux" — never the full user agent. */
  device: string;
  /** Network part of the address only (`203.0.113.x`). */
  network: string | null;
  /** How they signed in (`password`, `password+totp`, `passkey`, …) when the event says. */
  method: string | null;
  /** Done by Anhourtec staff (always shown as such, rule 49). */
  byStaff: boolean;
};

/** A session as the Security page shows it: a device summary and the network part only, never the full address. */
export type SessionView = Omit<SessionRecord, "ip" | "userAgent"> & {
  current: boolean;
  device: string;
  network: string | null;
};

export type PolicyView = { id: string; name: string; policy: SignInPolicy };

export type SecurityOverview = {
  factors: SecurityFactors;
  passkeys: PasskeyRecord[];
  sessions: SessionView[];
  activity: SecurityActivityItem[];
  /** What the person's accounts require of them, and what (if anything) they still have to set up. */
  requirement: { policy: SignInPolicy; accounts: PolicyView[]; missing: MissingFactor | null };
  /** Accounts whose requirement this person may change (Owners; `account.security.manage`). */
  manageable: PolicyView[];
  /** A password reset in the last two weeks: the page asks them to check their passkeys (they survive a reset). */
  passwordResetAt: Date | null;
};

const RESET_NOTICE_MS = 14 * 24 * 3600_000;

const ACTIVITY_LIMIT = 30;

const userOf = (actor: Actor): UserActor => {
  if (actor.kind !== "user") throw new ValidationError("Only a signed-in person has security settings.");
  return actor;
};

/** The person's Security page: factors, sessions, recent sign-in and security activity, account requirements. */
export async function getSecurityOverview(
  deps: Deps,
  actor: Actor,
  opts: { currentSessionId: string | null },
): Promise<SecurityOverview> {
  authorize(actor, "self.security.manage");
  const me = userOf(actor);
  return deps.uow.run(async (r) => {
    const factors = await r.security.factors(me.userId);
    const passkeys = await r.security.passkeys(me.userId);
    const sessions = await r.security.sessions(me.userId, deps.clock.now());
    const entries = await r.audit.list({ scope: "platform", targetId: me.userId, area: "auth", limit: ACTIVITY_LIMIT });
    const policies = await r.security.policies(me.userId);
    const names = await r.access.accountNames(policies.map((p) => p.accountId));
    const view = (p: { accountId: string; policy: SignInPolicy }): PolicyView => ({
      id: p.accountId,
      name: names[p.accountId] ?? "Account",
      policy: p.policy,
    });
    const policy = strictestPolicy(policies);
    return {
      factors,
      passkeys,
      sessions: sessions
        .map(({ ip, userAgent, ...s }) => ({
          ...s,
          current: s.id === opts.currentSessionId,
          device: describeDevice(userAgent),
          network: partialIp(ip),
        }))
        .sort((a, b) => Number(b.current) - Number(a.current)),
      activity: entries.map((e) => ({
        id: e.id,
        at: new Date(e.at),
        action: e.action,
        label: actionLabel(e.action),
        result: e.result,
        device: describeDevice(e.userAgent),
        network: partialIp(e.ip),
        method: typeof e.meta.method === "string" ? e.meta.method : null,
        byStaff: describeActor(e).kind === "staff",
      })),
      requirement: {
        policy,
        accounts: policies.filter((p) => p.policy !== "none").map(view),
        missing: missingFactor(policy, factors),
      },
      manageable: policies.filter((p) => can(me, "account.security.manage", p.accountId)).map(view),
      passwordResetAt: (() => {
        const reset = entries.find((e) => e.action === "auth.password_reset" && e.result === "success");
        const at = reset ? new Date(reset.at) : null;
        return at && deps.clock.now().getTime() - at.getTime() < RESET_NOTICE_MS ? at : null;
      })(),
    };
  });
}

/**
 * The factor the person must still set up before using the console (null = none), from the strictest policy of
 * their accounts. Used when building the actor for each request.
 */
export async function requiredEnrolment(repos: Repositories, userId: string): Promise<MissingFactor | null> {
  const policy = strictestPolicy(await repos.security.policies(userId));
  if (policy === "none") return null;
  return missingFactor(policy, await repos.security.factors(userId));
}

/** Shown when Anhourtec staff suspended the person's console sign-in (`platform.account.suspend`). */
export const PERSON_SUSPENDED_MESSAGE = `Your AnhourMail sign-in is suspended. Your mail is kept. If you think this is a mistake, email ${SUPPORT_EMAIL}.`;

/**
 * The refusal for a session signed in with `method` (null = ok): a staff suspension of the person first, then their
 * strictest account requirement. The identity layer refuses such a sign-in, and an open session ends on its next use.
 */
export async function sessionRefusalFor(
  repos: Repositories,
  userId: string,
  method: SignInMethod | null,
): Promise<string | null> {
  if (await repos.access.isSuspended(userId)) return PERSON_SUSPENDED_MESSAGE;
  // Passwordless passkey sessions from before ADR-0028 end under every policy.
  if (method === "passkey") return PASSWORDLESS_ENDED;
  const policy = strictestPolicy(await repos.security.policies(userId));
  if (policy === "none") return null;
  return sessionRefusal(policy, await repos.security.factors(userId), method);
}

/**
 * Ends a session that no longer meets an account requirement (e.g. the requirement changed after it signed in).
 * Audited as the identity layer.
 */
export async function endSessionForRequirement(
  deps: Deps,
  input: { userId: string; email: string; sessionId: string; method: SignInMethod | null },
  req: RequestMeta,
): Promise<void> {
  await mutation(
    deps,
    { kind: "system", name: "identity" },
    req,
    {
      action: "auth.session_revoked",
      permission: "self.profile.read",
      accountId: null,
      target: { type: "user", id: input.userId, label: maskEmail(input.email) },
    },
    async (r) => {
      await r.security.revokeSession(input.userId, input.sessionId);
      return { result: undefined, meta: { reason: "sign_in_requirement", method: input.method ?? "password" } };
    },
  );
}

/** Removes every passkey of the person; returns how many. */
async function removeAllPasskeys(r: Repositories, userId: string): Promise<number> {
  const keys = await r.security.passkeys(userId);
  for (const k of keys) await r.security.removePasskey(userId, k.id);
  return keys.length;
}

/**
 * Whether the person may remove a factor without breaking an account requirement (checked before the identity layer
 * turns off two-factor sign-in or removes a passkey). Returns the refusal message, or null.
 */
export async function factorRemovalRefusal(
  repos: Repositories,
  userId: string,
  removing: "totp" | "passkey" | "all_passkeys",
): Promise<string | null> {
  const policy = strictestPolicy(await repos.security.policies(userId));
  const f = await repos.security.factors(userId);
  if (removing === "all_passkeys") {
    return missingFactor(policy, { ...f, passkeys: 0 }) && f.passkeys > 0
      ? "Your account requires a passkey or a second step, so your passkeys can't be removed here. Ask an Owner of the account for help."
      : null;
  }
  const missing = missingAfterRemoving(policy, f, removing);
  if (!missing) return null;
  return missing === "passkey"
    ? "Your account requires a passkey. Add another passkey before removing this one."
    : "Your account requires two-factor sign-in. Add a passkey or keep your authenticator app.";
}

/** The person as the audit target (before authorization, so a signed-out caller still gets their 401). */
const selfTarget = (actor: Actor) =>
  actor.kind === "user"
    ? { type: "user", id: actor.userId, label: maskEmail(actor.email) }
    : { type: "user", id: null, label: null };

/** Signs out one of the person's other sessions. The current one signs out with "Sign out". 404 if not theirs. */
export async function revokeSession(
  deps: Deps,
  actor: Actor,
  input: { sessionId: string; currentSessionId: string | null },
  req: RequestMeta,
): Promise<void> {
  await mutation(
    deps,
    actor,
    req,
    { action: "auth.session_revoked", permission: "self.security.manage", accountId: null, target: selfTarget(actor) },
    async (r) => {
      const me = userOf(actor);
      if (input.sessionId === input.currentSessionId) {
        throw new ValidationError("This is the session you're using. Use Sign out to end it.");
      }
      const gone = await r.security.revokeSession(me.userId, input.sessionId);
      if (!gone) throw new NotFoundError("Session not found.");
      return { result: undefined, meta: { device: describeDevice(gone.userAgent), network: partialIp(gone.ip) } };
    },
  );
}

/** Signs out every other session and forgets trusted devices (they ask for the second step again). */
export async function revokeOtherSessions(
  deps: Deps,
  actor: Actor,
  input: { currentSessionId: string; removePasskeys?: boolean },
  req: RequestMeta,
): Promise<{ sessions: number; trustedDevices: number; passkeysRemoved: number }> {
  const out = await mutation(
    deps,
    actor,
    req,
    {
      action: "auth.sessions_revoked_all",
      permission: "self.security.manage",
      accountId: null,
      target: selfTarget(actor),
    },
    async (
      r,
    ): Promise<
      MutationOutcome<{ sessions: number; trustedDevices: number; passkeysRemoved: number } | "step_up_required">
    > => {
      const me = userOf(actor);
      let passkeysRemoved = 0;
      if (input.removePasskeys === true) {
        const policy = strictestPolicy(await r.security.policies(me.userId));
        const f = await r.security.factors(me.userId);
        if (missingFactor(policy, { ...f, passkeys: 0 })) {
          throw new ConflictError("Your account requires a passkey or second step: keep at least one way to meet it.");
        }
        // Removing every passkey needs a fresh step-up (the console password, ADR-0028), like removing one.
        if (!(await r.security.stepUpFresh(me.userId, input.currentSessionId, deps.clock.now()))) {
          return { result: "step_up_required" as const, denied: { code: "step_up_required" } };
        }
        passkeysRemoved = await removeAllPasskeys(r, me.userId);
      }
      const sessions = await r.security.revokeOtherSessions(me.userId, input.currentSessionId);
      const trustedDevices = await r.security.forgetTrustedDevices(me.userId);
      return {
        result: { sessions, trustedDevices, passkeysRemoved },
        meta: { sessions, trustedDevices, passkeysRemoved },
      };
    },
  );
  if (out === "step_up_required") throw new StepUpRequiredError();
  return out;
}

/** Renames one of the person's passkeys. 404 if it isn't theirs. */
export async function renamePasskey(
  deps: Deps,
  actor: Actor,
  input: { passkeyId: string; name: unknown },
  req: RequestMeta,
): Promise<PasskeyRecord> {
  return mutation(
    deps,
    actor,
    req,
    { action: "auth.passkey_renamed", permission: "self.security.manage", accountId: null, target: selfTarget(actor) },
    async (r) => {
      const me = userOf(actor);
      const name = passkeyName(input.name);
      const before = (await r.security.passkeys(me.userId)).find((p) => p.id === input.passkeyId);
      if (!before) throw new NotFoundError("Passkey not found.");
      const after = await r.security.renamePasskey(me.userId, input.passkeyId, name);
      if (!after) throw new NotFoundError("Passkey not found.");
      return { result: after, meta: { passkeyId: after.id, previousName: before.name, newName: name } };
    },
  );
}

/**
 * Removes one of the person's passkeys. Refused (409) when an account requires a passkey (or two-factor sign-in) and
 * this is the last factor that meets it. 404 if it isn't theirs. Needs a fresh step-up of this console session (the
 * console password, ADR-0028; 403 `step_up_required`, audited), like adding one or turning the authenticator off.
 */
export async function removePasskey(
  deps: Deps,
  actor: Actor,
  input: { passkeyId: string; sessionId: string | null },
  req: RequestMeta,
): Promise<{ passkeysLeft: number }> {
  const out = await mutation(
    deps,
    actor,
    req,
    { action: "auth.passkey_removed", permission: "self.security.manage", accountId: null, target: selfTarget(actor) },
    async (r): Promise<MutationOutcome<{ passkeysLeft: number } | "step_up_required">> => {
      const me = userOf(actor);
      const existing = (await r.security.passkeys(me.userId)).find((p) => p.id === input.passkeyId);
      if (!existing) throw new NotFoundError("Passkey not found.");
      const refusal = await factorRemovalRefusal(r, me.userId, "passkey");
      if (refusal) throw new ConflictError(refusal);
      if (!input.sessionId || !(await r.security.stepUpFresh(me.userId, input.sessionId, deps.clock.now()))) {
        return { result: "step_up_required" as const, denied: { code: "step_up_required" } };
      }
      await r.security.removePasskey(me.userId, input.passkeyId);
      // With no second factor left, a trusted browser would skip nothing tomorrow but still skip a factor added later:
      // forget them all, as turning the authenticator off does.
      const left = await r.security.factors(me.userId);
      const trustedDevicesForgotten =
        !left.totp && left.passkeys === 0 ? await r.security.forgetTrustedDevices(me.userId) : 0;
      return {
        result: { passkeysLeft: left.passkeys },
        meta: {
          passkeyId: existing.id,
          passkeyName: existing.name,
          ...(trustedDevicesForgotten > 0 ? { trustedDevicesForgotten } : {}),
        },
      };
    },
  );
  if (out === "step_up_required") throw new StepUpRequiredError();
  return out;
}

/**
 * Sets what everyone in the account must use to sign in (Owners: `account.security.manage`, critical). The Owner
 * must meet the requirement themselves first, so nobody locks themselves out of the page that changes it.
 */
export async function setSignInPolicy(
  deps: Deps,
  actor: Actor,
  input: { accountId: string; policy: unknown },
  req: RequestMeta,
): Promise<{ policy: SignInPolicy }> {
  return mutation(
    deps,
    actor,
    req,
    {
      action: "account.sign_in_policy_changed",
      permission: "account.security.manage",
      accountId: input.accountId,
      target: { type: "account", id: input.accountId },
    },
    async (r) => {
      const me = userOf(actor);
      if (!isSignInPolicy(input.policy)) throw new ValidationError("Choose a sign-in requirement.");
      const previous = await r.security.accountPolicy(input.accountId);
      if (previous === null) throw new NotFoundError();
      const ownFactors = await r.security.factors(me.userId);
      const missing = missingFactor(input.policy, ownFactors);
      if (!missing && sessionRefusal(input.policy, ownFactors, me.signInMethod ?? null)) {
        throw new ConflictError(
          input.policy === "passkey"
            ? "Sign in again using your passkey on the second step, then require one for everyone."
            : "Sign in again with a second step (passkey or authenticator app), then require it for everyone.",
        );
      }
      if (missing) {
        throw new ConflictError(
          missing === "passkey"
            ? "Add a passkey to your own sign-in first, then require one for everyone."
            : "Turn on two-factor sign-in or add a passkey for yourself first, then require it for everyone.",
        );
      }
      await r.security.setAccountPolicy(input.accountId, input.policy);
      const names = await r.access.accountNames([input.accountId]);
      return {
        result: { policy: input.policy },
        target: { label: names[input.accountId] ?? null },
        meta: { previousPolicy: previous, newPolicy: input.policy },
      };
    },
  );
}

/**
 * After a password reset or change: every other session is signed out and every trusted browser forgotten, in one unit
 * of work with the audit entry (`auth.password_reset`, recorded by the identity layer; `auth.password_changed`, by the
 * person). `keepSessionId` is the session that made the change (null for a reset: nobody stays signed in).
 */
export async function afterPasswordChange(
  deps: Deps,
  input: {
    userId: string;
    email: string;
    via: "reset" | "change";
    keepSessionId: string | null;
    /** The person asked to remove every passkey too (a reset after losing control of the account). */
    removePasskeys?: boolean;
  },
  req: RequestMeta,
): Promise<{ sessions: number; trustedDevices: number; passkeysRemoved: number }> {
  const actor: Actor =
    input.via === "change"
      ? { kind: "user", userId: input.userId, email: input.email, platformRoles: [], memberships: [], suspended: false }
      : { kind: "system", name: "identity" };
  return mutation(
    deps,
    actor,
    req,
    {
      action: input.via === "reset" ? "auth.password_reset" : "auth.password_changed",
      permission: "self.profile.read",
      accountId: null,
      target: { type: "user", id: input.userId, label: maskEmail(input.email) },
    },
    async (r) => {
      // No session id is ever empty, so a reset signs out every session.
      const sessions = await r.security.revokeOtherSessions(input.userId, input.keepSessionId ?? "");
      const trustedDevices = await r.security.forgetTrustedDevices(input.userId);
      // A password chosen by an admin ("Add a user") is replaced now: the first-sign-in gate lifts.
      const wasRequired = await r.people.passwordChangeRequired(input.userId);
      if (wasRequired) await r.people.setPasswordChangeRequired(input.userId, false);
      let passkeysRemoved = 0;
      let passkeysRemovalRefused = false;
      if (input.removePasskeys === true) {
        // Same rule as everywhere: never strip the factor an account requirement depends on. The password has
        // already changed by now, so never throw: keep the passkeys, still sign out and forget trusted browsers.
        if (await factorRemovalRefusal(r, input.userId, "all_passkeys")) passkeysRemovalRefused = true;
        else passkeysRemoved = await removeAllPasskeys(r, input.userId);
      }
      return {
        result: { sessions, trustedDevices, passkeysRemoved },
        meta: {
          otherSessionsRevoked: true,
          sessions,
          trustedDevices,
          passkeysRemoved,
          ...(passkeysRemovalRefused ? { passkeysRemovalRefused: true } : {}),
          ...(wasRequired ? { firstPasswordReplaced: true } : {}),
        },
      };
    },
  );
}

/**
 * After a factor is added: when it is the person's first and some of their accounts require one, record it in each
 * such account's log (visible to its Owners) and return who to tell — the person and those Owners — so a takeover
 * that enrols through a password-only session is visible. Returns no one otherwise.
 */
export async function noteFactorAdded(
  deps: Deps,
  input: {
    userId: string;
    email: string;
    factor: "totp" | "passkey";
    /**
     * The person had no second factor before this addition (captured by the caller before the write), so two
     * concurrent additions both count as first rather than neither.
     */
    firstFactor: boolean;
  },
  req: RequestMeta,
): Promise<{ notify: { email: string; accountName: string | null; owner: boolean }[] }> {
  if (!input.firstFactor) return { notify: [] };
  const { accounts } = await deps.uow.run(async (r) => {
    const requiring = (await r.security.policies(input.userId)).filter((p) => p.policy !== "none");
    const names = await r.access.accountNames(requiring.map((p) => p.accountId));
    const out: { accountId: string; name: string | null; owners: string[] }[] = [];
    for (const p of requiring) {
      const owners = (await r.access.members(p.accountId))
        .filter((m) => m.role === "owner" && m.userId !== input.userId)
        .map((m) => m.email);
      out.push({ accountId: p.accountId, name: names[p.accountId] ?? null, owners });
    }
    return { accounts: out };
  });
  if (accounts.length === 0) return { notify: [] };
  const notify: { email: string; accountName: string | null; owner: boolean }[] = [
    { email: input.email, accountName: accounts[0]?.name ?? null, owner: false },
  ];
  for (const a of accounts) {
    await mutation(
      deps,
      { kind: "system", name: "identity" },
      req,
      {
        action: "account.sign_in_factor_added",
        permission: "self.profile.read",
        accountId: a.accountId,
        target: { type: "user", id: input.userId, label: maskEmail(input.email) },
      },
      async () => ({ result: undefined, meta: { factor: input.factor, firstFactor: true } }),
    );
    for (const o of a.owners)
      if (!notify.some((n) => n.email === o)) notify.push({ email: o, accountName: a.name, owner: true });
  }
  return { notify };
}

/**
 * After someone's passkeys were all removed (a password reset with "also remove all passkeys", "sign out everywhere
 * else" with it, or removing their last one): record it in each account they belong to (visible to its admins, rule 49) and return who to tell —
 * the person and those accounts' Owners — so a takeover that strips the second factor is visible.
 */
export async function notePasskeysRemoved(
  deps: Deps,
  input: {
    userId: string;
    email: string;
    passkeysRemoved: number;
    /** A password reset or "sign out everywhere else" with "also remove all passkeys", or removing the last one. */
    via: "password_reset" | "sign_out_everywhere" | "single";
  },
  req: RequestMeta,
): Promise<{ notify: { email: string; accountName: string | null; owner: boolean }[] }> {
  if (input.passkeysRemoved <= 0) return { notify: [] };
  const accounts = await deps.uow.run(async (r) => {
    const memberships = await r.access.memberships(input.userId);
    const names = await r.access.accountNames(memberships.map((m) => m.accountId));
    const out: { accountId: string; name: string | null; owners: string[] }[] = [];
    for (const m of memberships) {
      const owners = (await r.access.members(m.accountId))
        .filter((x) => x.role === "owner" && x.userId !== input.userId)
        .map((x) => x.email);
      out.push({ accountId: m.accountId, name: names[m.accountId] ?? null, owners });
    }
    return out;
  });
  const notify: { email: string; accountName: string | null; owner: boolean }[] = [
    { email: input.email, accountName: null, owner: false },
  ];
  for (const a of accounts) {
    await mutation(
      deps,
      { kind: "system", name: "identity" },
      req,
      {
        action: "account.sign_in_factor_removed",
        permission: "self.profile.read",
        accountId: a.accountId,
        target: { type: "user", id: input.userId, label: maskEmail(input.email) },
      },
      async () => ({
        result: undefined,
        meta: { factor: "passkey", passkeysRemoved: input.passkeysRemoved, via: input.via },
      }),
    );
    for (const o of a.owners)
      if (!notify.some((n) => n.email === o)) notify.push({ email: o, accountName: a.name, owner: true });
  }
  return { notify };
}
