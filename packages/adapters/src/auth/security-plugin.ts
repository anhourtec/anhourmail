// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Our own better-auth plugin around the two-factor and passkey plugins (docs/internal/07-security.md "Sign-in
 * factors", ADR-0028). It is listed after them, so its after-hooks see their final answers.
 *
 * Sign-in is always the password first. After a correct password, anyone with a second factor gets a second step:
 * the two-factor plugin's challenge for an authenticator app, or the same challenge issued here for someone with only
 * passkeys. The answer lists the methods the person may use (`twoFactorMethods`). A passkey is only ever that second
 * step: the passkey endpoints need a pending challenge and accept only the challenged person's own credential.
 *
 * Before an endpoint runs it:
 * - refuses an authenticator code that was already accepted in the last two minutes (one-time use);
 * - hashes a typed recovery code, so the two-factor plugin only ever compares stored hashes;
 * - lets two-factor sign-in be turned off only with a current code (authenticator or recovery code) on top of the
 *   password, and never when an account requirement depends on it;
 * - refuses re-verifying an authenticator that is already on, and recovery codes outside sign-in (or anything that
 *   looks like a stored value);
 * - refuses a passkey sign-in without the password step, or with someone else's passkey, and counts wrong attempts;
 * - lets a passkey be added only after a recent step-up (a sign-in or `POST /step-up` with the console password in
 *   the last few minutes; the marker is used up by the registration), never with `createSession`.
 *
 * After it runs, it records how each new session signed in, refuses a sign-in whose method an account requirement
 * doesn't accept (the new session is deleted), strips session tokens and passkey material from responses, and
 * reports what happened (`onEvent`) so the app can audit it: the password step, sign-ins and failures with the
 * method, lockouts, factor changes. Never codes, secrets or passkey material.
 */
import { DomainError } from "@anhourmail/core";
import type { AuditAction } from "@anhourmail/core/audit";
import { passkeyName } from "@anhourmail/core/security";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  isSignInMethod,
  SECOND_STEP_LIMITS,
  type SecondStepMethod,
  type SignInMethod,
  STEP_UP_MINUTES,
  TRUSTED_DEVICE_DAYS,
} from "@anhourmail/shared/security";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
  sessionMiddleware,
} from "better-auth/api";
import { deleteSessionCookie, expireCookie } from "better-auth/cookies";
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

import { hashedBackupCodeStore, hashRecoveryCode, isRecoveryCodeInput, newRecoveryCodes } from "./recovery-codes";
import { claimTotp, type CodeClaim } from "./totp";

export type AuthSecurityEvent = {
  action: AuditAction;
  userId: string | null;
  email: string | null;
  /** `self`: the signed-in person (or the person completing their own sign-in); `identity`: nobody signed in yet. */
  by: "self" | "identity";
  /** Recorded as `denied` with this code. */
  denied?: string;
  meta?: Record<string, unknown>;
  userAgent: string | null;
};

export type SecurityHooks = {
  /** Audits an event. Must not throw (the caller logs its own failures). */
  onEvent(event: AuthSecurityEvent): Promise<void>;
  /** A refusal message when removing this factor would break one of the person's account requirements. */
  removalRefusal(userId: string, factor: "totp" | "passkey" | "all_passkeys"): Promise<string | null>;
  /** The person's second factors right now (no secrets); `recoveryCodesLeft` counts unused recovery codes. */
  factors(userId: string): Promise<{ totp: boolean; passkeys: number; recoveryCodesLeft?: number }>;
  /**
   * A factor was just added. When it is the person's first and one of their accounts requires one, the app tells the
   * person and that account's Owners (a takeover through a password reset would show). Must not throw.
   */
  factorAdded(event: {
    /** The person had no second factor before this request (captured before the write). */
    firstFactor: boolean;
    userId: string;
    email: string;
    factor: "totp" | "passkey";
    userAgent: string | null;
  }): Promise<void>;
  /** Authenticator codes are one-time: an atomic claim; only the request that wins it may accept the code. */
  codes: { claim: CodeClaim };
  /**
   * Atomic per-key strike counter (Redis `INCR` in production; `@anhourmail/server/one-time` `redisStrikes`): returns
   * the new count. Errors propagate, so a wrong password is refused even when the store is down (fail closed).
   */
  strikes: (key: string, ttlMs: number) => Promise<number>;
  /**
   * After a password reset (`keepSessionId` null) or change: sign out the person's other sessions, forget every
   * trusted browser, and audit it. Must not throw.
   */
  passwordChanged(event: {
    userId: string;
    email: string;
    via: "reset" | "change";
    keepSessionId: string | null;
    /** The person asked (on the reset page) to remove every passkey too. */
    removePasskeys: boolean;
    userAgent: string | null;
  }): Promise<void>;
  /** The refusal when the person's account requirements don't accept a sign-in with `method` (null = accepted). */
  sessionRefusal(userId: string, method: SignInMethod): Promise<string | null>;
};

type Person = {
  userId: string;
  email: string;
  signIn: boolean;
  twoFactorEnabled: boolean;
  /** The current session, when signed in. */
  sessionId?: string;
  sessionToken?: string;
  /** How the current session signed in (`auth_session.sign_in_method`). */
  method?: SignInMethod;
  removePasskeys?: boolean;
  /** Whether the person had any second factor when the request started (for first-factor notices). */
  hadFactor?: boolean;
  /** The pending second-step challenge a passkey step answers. */
  challenge?: Challenge;
  /** "Trust this browser" ticked on the passkey step. */
  trustDevice?: boolean;
  /** Recovery codes (stored hashes) to keep across an authenticator set-up or turning the authenticator off. */
  keepCodes?: string;
};

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const BEFORE = new Set([
  "/sign-out",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/recovery-codes/generate",
  "/step-up",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/change-password",
  "/reset-password",
]);

const AFTER = new Set([
  "/sign-in/email",
  "/passkey/generate-authenticate-options",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
  "/change-password",
  "/reset-password",
]);

/** The second-step challenge cookie (the two-factor plugin's; we issue the same one for passkey-only people). */
const TWO_FACTOR_COOKIE = "two_factor";

type Challenge = { id: string; userId: string; email: string; expiresAt: Date };

/** The browser's pending second-step challenge (set by a correct password), or null. */
async function pendingChallenge(ctx: Ctx): Promise<Challenge | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
  const id = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!id) return null;
  const v = await ctx.context.internalAdapter.findVerificationValue(id);
  if (!v || v.expiresAt < new Date()) return null;
  const user = await ctx.context.internalAdapter.findUserById(v.value);
  return user ? { id, userId: user.id, email: user.email, expiresAt: v.expiresAt } : null;
}

/**
 * Starts a second step exactly as the two-factor plugin does (verification value + attempt counter + signed cookie),
 * so the passkey step and the plugin's code steps read one challenge.
 */
async function issueChallenge(ctx: Ctx, userId: string): Promise<void> {
  const maxAge = SECOND_STEP_LIMITS.challengeMinutes * 60;
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge });
  const id = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + maxAge * 1000);
  await ctx.context.internalAdapter.createVerificationValue({ value: userId, identifier: id, expiresAt });
  await ctx.context.internalAdapter.createVerificationValue({ value: "0", identifier: attemptsId(id), expiresAt });
  await ctx.setSignedCookie(cookie.name, id, ctx.context.secret, cookie.attributes);
}

const attemptsId = (challengeId: string) => `2fa-attempts-${challengeId}`;

/** Wrong attempts on this challenge so far (null when the counter is gone: the challenge isn't usable). */
async function challengeAttempts(ctx: Ctx, challengeId: string): Promise<number | null> {
  const v = await ctx.context.internalAdapter.findVerificationValue(attemptsId(challengeId));
  if (!v) return null;
  const n = Number(v.value);
  return Number.isInteger(n) && n >= 0 ? n : SECOND_STEP_LIMITS.perChallenge;
}

/** One more wrong attempt on the challenge. */
async function countChallengeFailure(ctx: Ctx, c: Challenge): Promise<void> {
  const n = (await challengeAttempts(ctx, c.id)) ?? SECOND_STEP_LIMITS.perChallenge;
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(attemptsId(c.id)).catch(() => undefined);
  await ctx.context.internalAdapter
    .createVerificationValue({ value: String(n + 1), identifier: attemptsId(c.id), expiresAt: c.expiresAt })
    .catch(() => undefined);
}

/** Ends the challenge (used up, or too many wrong attempts) and its cookie. */
async function endChallenge(ctx: Ctx, challengeId: string): Promise<boolean> {
  const consumed = await ctx.context.internalAdapter.consumeVerificationValue(challengeId).catch(() => null);
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(attemptsId(challengeId)).catch(() => undefined);
  expireCookie(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE));
  return consumed !== null;
}

type LockRow = { id: string; failedVerificationCount?: number | null; lockedUntil?: Date | null };

/** The person's two-factor row, which carries the account lockout (people with an authenticator app). */
const lockRow = (ctx: Pick<Ctx, "context">, userId: string) =>
  ctx.context.adapter.findOne<LockRow>({ model: "twoFactor", where: [{ field: "userId", value: userId }] });

const isLocked = (row: LockRow | null) => !!row?.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now();

/** One more consecutive wrong second-step attempt; locks the second step after `SECOND_STEP_LIMITS.perAccount`. */
async function countAccountFailure(ctx: Pick<Ctx, "context">, row: LockRow | null): Promise<void> {
  if (!row) return;
  const counted = await ctx.context.adapter.incrementOne<{ failedVerificationCount?: number | null }>({
    model: "twoFactor",
    where: [{ field: "id", value: row.id }],
    increment: { failedVerificationCount: 1 },
  });
  if ((counted?.failedVerificationCount ?? 0) >= SECOND_STEP_LIMITS.perAccount) {
    await ctx.context.adapter.update({
      model: "twoFactor",
      where: [{ field: "id", value: row.id }],
      update: { lockedUntil: new Date(Date.now() + SECOND_STEP_LIMITS.lockMinutes * 60_000) },
    });
  }
}

/** "Trust this browser": the two-factor plugin's cookie and verification rows, so either side honours the other's. */
const TRUST_COOKIE = "trust_device";
const TRUST_MAX_AGE = TRUSTED_DEVICE_DAYS * 24 * 3600;

const trustToken = (secret: string, userId: string, id: string) =>
  createHmac("sha256", secret).update(`${userId}!${id}`).digest("base64url");

/** Trusts this browser for the person (after a second step) for `TRUSTED_DEVICE_DAYS`. */
async function trustBrowser(ctx: Ctx, userId: string): Promise<void> {
  const id = `trust-device-${generateRandomString(32)}`;
  await ctx.context.internalAdapter.createVerificationValue({
    value: userId,
    identifier: id,
    expiresAt: new Date(Date.now() + TRUST_MAX_AGE * 1000),
  });
  const cookie = ctx.context.createAuthCookie(TRUST_COOKIE, { maxAge: TRUST_MAX_AGE });
  await ctx.setSignedCookie(cookie.name, `${trustToken(ctx.context.secret, userId, id)}!${id}`, ctx.context.secret, {
    ...cookie.attributes,
  });
}

/**
 * Whether this browser is trusted for the person (signed cookie, matching token, live record); a trusted browser's
 * record is replaced on each use, as the two-factor plugin does.
 */
async function trustedBrowser(ctx: Ctx, userId: string): Promise<boolean> {
  const cookie = ctx.context.createAuthCookie(TRUST_COOKIE, { maxAge: TRUST_MAX_AGE });
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!value) return false;
  const [token = "", id = ""] = value.split("!");
  const expected = trustToken(ctx.context.secret, userId, id);
  if (!id || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return false;
  }
  const record = await ctx.context.internalAdapter.findVerificationValue(id);
  if (record?.value !== userId || record.expiresAt <= new Date()) return false;
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(id);
  await trustBrowser(ctx, userId);
  return true;
}

/**
 * Stores recovery codes for someone whose second factor is a passkey (no authenticator app): the two-factor row, not
 * verified (so it never accepts an authenticator code), with a sealed random secret nobody knows. `hashed` is the stored
 * form (`hashedBackupCodeStore`).
 */
async function storePasskeyCodes(ctx: Pick<Ctx, "context">, userId: string, hashed: string): Promise<void> {
  const row = await ctx.context.adapter.findOne<{ id: string }>({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  });
  if (row) {
    await ctx.context.adapter.update({
      model: "twoFactor",
      where: [{ field: "id", value: row.id }],
      update: { backupCodes: hashed },
    });
    return;
  }
  const secret = await symmetricEncrypt({ key: ctx.context.secretConfig, data: generateRandomString(32) });
  await ctx.context.adapter.create({
    model: "twoFactor",
    data: { userId, secret, backupCodes: hashed, verified: false },
  });
}

/** Fresh recovery codes for a passkey-only person: stored as hashes, returned once in the clear. */
async function newPasskeyCodes(ctx: Pick<Ctx, "context">, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await storePasskeyCodes(ctx, userId, await hashedBackupCodeStore.encrypt(JSON.stringify(codes)));
  return codes;
}

const pendingCodesId = (userId: string) => `recovery-codes-pending-${userId}`;

/** Who is acting, from a session or from a pending second-step challenge; null when neither. */
async function resolvePerson(ctx: Ctx): Promise<Person | null> {
  const session = await getSessionFromCtx(ctx).catch(() => null);
  if (session) {
    const user = session.user as { id: string; email: string; twoFactorEnabled?: unknown };
    return {
      userId: user.id,
      email: user.email,
      signIn: false,
      twoFactorEnabled: user.twoFactorEnabled === true,
      sessionId: session.session.id,
      sessionToken: session.session.token,
      method: sessionMethod(session.session),
    };
  }
  const c = await pendingChallenge(ctx);
  return c ? { userId: c.userId, email: c.email, signIn: true, twoFactorEnabled: true, challenge: c } : null;
}

/** The method recorded on a session row (null/unknown counts as the password alone). */
export function sessionMethod(session: unknown): SignInMethod {
  const m = (session as { signInMethod?: unknown } | null | undefined)?.signInMethod;
  return isSignInMethod(m) ? m : "password";
}

const bodyOf = (ctx: Ctx): Record<string, unknown> =>
  ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};

const errorCode = (e: unknown): string => {
  if (!isAPIError(e)) return "failed";
  const code = (e.body as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code.toLowerCase() : "failed";
};

const stepUpId = (sessionId: string) => `step-up-${sessionId}`;

/**
 * Wrong console passwords one signed-in session may type (step-up, new recovery codes, turning an authenticator on or
 * off, new authenticator codes, changing the password) before it is signed out.
 */
const SESSION_PASSWORD_STRIKES = 5;
/** How long a session's strikes are remembered (longer than any session lives). */
const STRIKE_WINDOW_MS = 30 * 24 * 3600 * 1000;
const strikeKey = (sessionId: string) => `am:auth:password-strikes:${sessionId}`;

/** Signed-in endpoints that check the console password; a wrong one is a strike. */
const PASSWORD_CHECKED = new Set([
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
]);

/** An authenticator set-up in progress (`/two-factor/enable` → first code): only then may a signed-in code be checked. */
const totpSetupId = (userId: string) => `totp-setup-${userId}`;
const TOTP_SETUP_MINUTES = 30;

/** Marks a session as having just confirmed it's the person (sign-in or step-up) for the next few minutes. */
async function markStepUp(ctx: Pick<Ctx, "context">, userId: string, sessionId: string): Promise<void> {
  await ctx.context.internalAdapter.deleteVerificationByIdentifier(stepUpId(sessionId)).catch(() => undefined);
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: stepUpId(sessionId),
    value: userId,
    expiresAt: new Date(Date.now() + STEP_UP_MINUTES * 60_000),
  });
}

const twoFactorRow = (ctx: Pick<Ctx, "context">, userId: string) =>
  ctx.context.adapter.findOne<{ secret: string; backupCodes: string }>({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  });

/** Checks an authenticator code and claims it atomically (`claimTotp`); `invalid` when there is no secret. */
async function checkTotp(ctx: Pick<Ctx, "context">, hooks: SecurityHooks, userId: string, code: string) {
  const row = await twoFactorRow(ctx, userId);
  if (!row) return "invalid" as const;
  const secret = await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.secret });
  return claimTotp(secret, userId, code, hooks.codes.claim);
}

/** A current authenticator code (claimed, so never used twice) or an unused recovery code (not used up here). */
async function secondFactorOk(
  ctx: Pick<Ctx, "context">,
  hooks: SecurityHooks,
  userId: string,
  code: string,
): Promise<boolean> {
  const row = await twoFactorRow(ctx, userId);
  if (!row) return false;
  if (/^\d{6}$/.test(code.trim())) return (await checkTotp(ctx, hooks, userId, code)) === "ok";
  if (!isRecoveryCodeInput(code)) return false;
  let hashes: unknown;
  try {
    hashes = JSON.parse(row.backupCodes);
  } catch {
    return false;
  }
  return Array.isArray(hashes) && hashes.includes(hashRecoveryCode(code));
}

/** Endpoints whose answers carry a session token or passkey material. */
const STRIP = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/passkey/verify-authentication",
  "/passkey/verify-registration",
  "/change-password",
]);

/** Response fields the browser never needs: session tokens and passkey material. */
const SECRET_FIELDS = ["token", "session", "publicKey", "credentialID", "counter"] as const;

export function securityPlugin(hooks: SecurityHooks): BetterAuthPlugin {
  // State from before → after a request (the same Request object travels through both hooks).
  const people = new WeakMap<object, Person | null>();
  const remember = (ctx: Ctx, p: Person | null) => {
    if (ctx.request) people.set(ctx.request, p);
  };
  const recall = (ctx: Ctx): Person | null => (ctx.request ? (people.get(ctx.request) ?? null) : null);
  const ua = (ctx: Ctx) => ctx.headers?.get("user-agent")?.slice(0, 300) ?? null;
  const emit = (ctx: Ctx, e: Omit<AuthSecurityEvent, "userAgent">) => hooks.onEvent({ ...e, userAgent: ua(ctx) });
  const fail = (status: "BAD_REQUEST" | "UNAUTHORIZED" | "CONFLICT", code: string, message: string) =>
    new APIError(status, { code, message });

  /**
   * A wrong console password in a signed-in session: it counts toward the account's second-step lockout (when there is
   * a two-factor row) and the session's strikes (atomic). The fifth strike signs the session out (audited) and answers
   * 401 `STEP_UP_SESSION_ENDED`, so a stolen session can't keep guessing.
   */
  const passwordStrike = async (
    ctx: Ctx,
    who: { userId: string; email: string; sessionId: string; sessionToken: string },
    where: string,
  ): Promise<void> => {
    await countAccountFailure(ctx, await lockRow(ctx, who.userId));
    const strikes = await hooks.strikes(strikeKey(who.sessionId), STRIKE_WINDOW_MS);
    if (strikes < SESSION_PASSWORD_STRIKES) return;
    await ctx.context.internalAdapter.deleteSession(who.sessionToken);
    await emit(ctx, {
      action: "auth.session_revoked",
      userId: who.userId,
      email: who.email,
      by: "identity",
      meta: { reason: "password_failures", failures: strikes, where },
    });
    throw new APIError("UNAUTHORIZED", {
      code: "STEP_UP_SESSION_ENDED",
      message: "Too many wrong attempts. You've been signed out; sign in again.",
    });
  };

  /** A wrong console password on a signed-in endpoint that checks it (`PASSWORD_CHECKED`) is a strike. */
  const strikeIfWrongPassword = async (ctx: Ctx, person: Person, code: string | null) => {
    if (code !== "invalid_password" || !PASSWORD_CHECKED.has(ctx.path)) return;
    if (person.signIn || !person.sessionId || !person.sessionToken) return;
    await passwordStrike(
      ctx,
      { userId: person.userId, email: person.email, sessionId: person.sessionId, sessionToken: person.sessionToken },
      ctx.path.replace(/^\//, ""),
    );
  };

  /** Signs the just-created session out again when a requirement refuses its method; audited. */
  const refuseIfRequired = async (ctx: Ctx, userId: string, email: string, method: SignInMethod) => {
    const refusal = await hooks.sessionRefusal(userId, method);
    const fresh = ctx.context.newSession;
    if (!refusal) {
      // Every sign-in proved the console password, which is what a step-up asks for (ADR-0028).
      if (fresh) await markStepUp(ctx, userId, fresh.session.id);
      return;
    }
    if (fresh) await ctx.context.internalAdapter.deleteSession(fresh.session.token);
    ctx.context.setNewSession(null);
    await emit(ctx, {
      action: "auth.sign_in_failed",
      userId,
      email,
      by: "identity",
      denied: "sign_in_requirement",
      meta: { method },
    });
    throw new APIError("FORBIDDEN", { code: "SIGN_IN_METHOD_REQUIRED", message: refusal });
  };

  const SECOND_STEP_SESSION: Record<SecondStepMethod, SignInMethod> = {
    passkey: "password+passkey",
    totp: "password+totp",
    recovery_code: "password+recovery_code",
  };

  /**
   * The second-step methods the person has, leaving out any their account requirements would refuse (a passkey
   * requirement leaves only the passkey). When a requirement would refuse them all, all are listed and the
   * requirement answers at the end.
   */
  const secondStepMethods = async (userId: string): Promise<SecondStepMethod[]> => {
    const f = await hooks.factors(userId);
    const have: SecondStepMethod[] = [
      ...(f.passkeys > 0 ? (["passkey"] as const) : []),
      ...(f.totp ? (["totp"] as const) : []),
      // With an authenticator app, recovery codes are always offered (the page says when they run out).
      ...(f.totp || (f.recoveryCodesLeft ?? 0) > 0 ? (["recovery_code"] as const) : []),
    ];
    const allowed: SecondStepMethod[] = [];
    for (const m of have) if ((await hooks.sessionRefusal(userId, SECOND_STEP_SESSION[m])) === null) allowed.push(m);
    return allowed.length > 0 ? allowed : have;
  };

  /** The password was right and a second step follows: recorded, and the methods are listed for the page. */
  const secondStep = async (ctx: Ctx, userId: string, email: string | null) => {
    const methods = await secondStepMethods(userId);
    await emit(ctx, { action: "auth.second_step_started", userId, email, by: "identity", meta: { methods } });
    return ctx.json({ twoFactorRedirect: true, twoFactorMethods: methods });
  };

  return {
    id: "anhourmail-security",
    endpoints: {
      /**
       * `POST /recovery-codes/generate` (signed in): new recovery codes for someone whose second factor is a passkey
       * (ADR-0028), with the console password; the old ones stop working. People with an authenticator app use the
       * two-factor plugin's `generate-backup-codes`. Shown once; audited, refusals too.
       */
      passkeyRecoveryCodes: createAuthEndpoint(
        "/recovery-codes/generate",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { user, session } = ctx.context.session;
          const body = (ctx.body && typeof ctx.body === "object" ? ctx.body : {}) as Record<string, unknown>;
          const password = typeof body.password === "string" ? body.password : "";
          const userAgent = ctx.headers?.get("user-agent")?.slice(0, 300) ?? null;
          const base = { action: "auth.recovery_codes_regenerated" as const, userId: user.id, email: user.email };
          const refuse = async (status: "BAD_REQUEST" | "CONFLICT", code: string, message: string) => {
            await hooks.onEvent({
              ...base,
              by: "self",
              denied: code.toLowerCase(),
              meta: { with: "passkey" },
              userAgent,
            });
            return new APIError(status, { code, message });
          };
          const f = await hooks.factors(user.id);
          if (f.totp) {
            throw await refuse(
              "BAD_REQUEST",
              "USE_AUTHENTICATOR_CODES",
              "Create new recovery codes under Authenticator app.",
            );
          }
          if (f.passkeys === 0) {
            throw await refuse("BAD_REQUEST", "NO_SECOND_FACTOR", "Add a passkey or an authenticator app first.");
          }
          // An authenticator set-up in progress would replace these codes when it finishes.
          const setup = await ctx.context.internalAdapter.findVerificationValue(totpSetupId(user.id));
          if (setup && setup.expiresAt > new Date()) {
            throw await refuse(
              "CONFLICT",
              "AUTHENTICATOR_SETUP_PENDING",
              `Finish setting up your authenticator app first, or try again in ${String(TOTP_SETUP_MINUTES)} minutes.`,
            );
          }
          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          const ok =
            password !== "" && account?.password
              ? await ctx.context.password.verify({ hash: account.password, password })
              : false;
          if (!ok) {
            await hooks.onEvent({ ...base, by: "self", denied: "invalid_password", userAgent });
            await passwordStrike(
              ctx,
              { userId: user.id, email: user.email, sessionId: session.id, sessionToken: session.token },
              "recovery_codes",
            );
            throw new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "That password isn't right." });
          }
          const codes = await newPasskeyCodes(ctx, user.id);
          await hooks.onEvent({ ...base, by: "self", meta: { with: "passkey" }, userAgent });
          return ctx.json({ backupCodes: codes });
        },
      ),
      /**
       * `POST /step-up` (signed in): confirm it's you with your console password (ADR-0028: the password only, for
       * every session type and factor). Lets this session do sensitive things in the next few minutes. Audited,
       * refusals too. A session that fails 5 times is signed out.
       */
      stepUp: createAuthEndpoint("/step-up", { method: "POST", use: [sessionMiddleware] }, async (ctx) => {
        const { user, session } = ctx.context.session;
        const body = (ctx.body && typeof ctx.body === "object" ? ctx.body : {}) as Record<string, unknown>;
        const userAgent = ctx.headers?.get("user-agent")?.slice(0, 300) ?? null;
        const confirmed = (extra: { denied?: string }) =>
          hooks.onEvent({
            action: "auth.identity_confirmed",
            userId: user.id,
            email: user.email,
            by: "self",
            ...extra,
            meta: { method: "password" },
            userAgent,
          });
        if (body.code !== undefined) {
          await confirmed({ denied: "password_only" });
          throw new APIError("BAD_REQUEST", {
            code: "STEP_UP_PASSWORD_ONLY",
            message: "Enter your console password.",
          });
        }
        const password = typeof body.password === "string" ? body.password : "";
        // A second step under attack (locked) stops step-ups too; wrong passwords here count toward that lockout.
        // A right one doesn't clear it: only a second step does.
        if (isLocked(await lockRow(ctx, user.id))) {
          await confirmed({ denied: "account_temporarily_locked" });
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "ACCOUNT_TEMPORARILY_LOCKED",
            message: "Too many wrong attempts. Try again later.",
          });
        }
        let ok = false;
        if (password !== "") {
          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          ok = account?.password ? await ctx.context.password.verify({ hash: account.password, password }) : false;
        }
        await confirmed(ok ? {} : { denied: "invalid_credentials" });
        if (!ok) {
          await passwordStrike(
            ctx,
            { userId: user.id, email: user.email, sessionId: session.id, sessionToken: session.token },
            "step_up",
          );
          throw new APIError("BAD_REQUEST", {
            code: "STEP_UP_FAILED",
            message: "That password isn't right. Try again.",
          });
        }
        await markStepUp(ctx, user.id, session.id);
        return ctx.json({ status: true });
      }),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => BEFORE.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/sign-out") {
              const s = await getSessionFromCtx(ctx).catch(() => null);
              if (s) await emit(ctx, { action: "auth.sign_out", userId: s.user.id, email: s.user.email, by: "self" });
              return;
            }
            if (
              ctx.path === "/passkey/generate-authenticate-options" ||
              ctx.path === "/passkey/verify-authentication"
            ) {
              // A passkey is only ever the second step (ADR-0028): the password step must have set a challenge.
              const c = await pendingChallenge(ctx);
              if (!c) {
                if (ctx.path === "/passkey/verify-authentication") {
                  await emit(ctx, {
                    action: "auth.sign_in_failed",
                    userId: null,
                    email: null,
                    by: "identity",
                    denied: "password_first",
                    meta: { method: "passkey" },
                  });
                }
                throw fail("UNAUTHORIZED", "PASSWORD_FIRST", "Sign in with your email and password first.");
              }
              remember(ctx, {
                userId: c.userId,
                email: c.email,
                signIn: true,
                twoFactorEnabled: false,
                challenge: c,
                trustDevice: bodyOf(ctx).trustDevice === true,
              });
              if (ctx.path === "/passkey/generate-authenticate-options") return;
              const base = { userId: c.userId, email: c.email, by: "identity" as const, meta: { method: "passkey" } };
              const row = await lockRow(ctx, c.userId);
              if (isLocked(row)) {
                await emit(ctx, { ...base, action: "auth.locked_out", denied: "account_temporarily_locked" });
                throw new APIError("TOO_MANY_REQUESTS", {
                  code: "ACCOUNT_TEMPORARILY_LOCKED",
                  message: "Too many wrong attempts. Sign-in is locked for a while; try again later.",
                });
              }
              const attempts = await challengeAttempts(ctx, c.id);
              if (attempts === null || attempts >= SECOND_STEP_LIMITS.perChallenge) {
                await endChallenge(ctx, c.id);
                await emit(ctx, { ...base, action: "auth.sign_in_failed", denied: "too_many_attempts" });
                throw fail(
                  "BAD_REQUEST",
                  "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
                  "This sign-in had too many wrong attempts. Start again.",
                );
              }
              // Only the challenged person's own passkey: someone else's is refused before it is verified.
              const response = bodyOf(ctx).response as { id?: unknown } | null | undefined;
              const credentialID = typeof response?.id === "string" ? response.id : "";
              const key = credentialID
                ? await ctx.context.adapter.findOne<{ userId: string }>({
                    model: "passkey",
                    where: [{ field: "credentialID", value: credentialID }],
                  })
                : null;
              if (key?.userId !== c.userId) {
                await countChallengeFailure(ctx, c);
                await countAccountFailure(ctx, row);
                await emit(ctx, { ...base, action: "auth.sign_in_failed", denied: "passkey_not_found" });
                throw fail("UNAUTHORIZED", "PASSKEY_NOT_FOUND", "That passkey isn't one of yours on this login.");
              }
              return;
            }
            if (ctx.path === "/reset-password") {
              // The emailed token names the person; remember them for the after-hook.
              const token = typeof bodyOf(ctx).token === "string" ? String(bodyOf(ctx).token) : "";
              const v = token
                ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`)
                : null;
              const user = v ? await ctx.context.internalAdapter.findUserById(v.value) : null;
              if (user && bodyOf(ctx).removePasskeys === true) {
                // Someone holding only the mailbox mustn't be able to strip the factor a requirement depends on.
                const refusal = await hooks.removalRefusal(user.id, "all_passkeys");
                if (refusal) {
                  await emit(ctx, {
                    action: "auth.passkey_removed",
                    userId: user.id,
                    email: user.email,
                    by: "identity",
                    denied: "factor_required",
                    meta: { via: "password_reset" },
                  });
                  throw fail("BAD_REQUEST", "FACTOR_REQUIRED", refusal);
                }
              }
              remember(
                ctx,
                user
                  ? {
                      userId: user.id,
                      email: user.email,
                      signIn: false,
                      twoFactorEnabled: false,
                      removePasskeys: bodyOf(ctx).removePasskeys === true,
                    }
                  : null,
              );
              return;
            }
            const person = await resolvePerson(ctx);
            if (person && !person.signIn && person.sessionToken) {
              // A session an account requirement refuses can't change anything here either (set up factors, step up,
              // add passkeys): it is ended.
              const refusal = await hooks.sessionRefusal(person.userId, person.method ?? "password");
              if (refusal) {
                await ctx.context.internalAdapter.deleteSession(person.sessionToken);
                await emit(ctx, {
                  action: "auth.session_revoked",
                  userId: person.userId,
                  email: person.email,
                  by: "identity",
                  meta: { reason: "sign_in_requirement", method: person.method ?? "password" },
                });
                throw new APIError("UNAUTHORIZED", { code: "SIGN_IN_METHOD_REQUIRED", message: refusal });
              }
            }
            if (
              person &&
              !person.signIn &&
              (ctx.path === "/two-factor/verify-totp" || ctx.path === "/passkey/verify-registration")
            ) {
              const f = await hooks.factors(person.userId);
              person.hadFactor = f.totp || f.passkeys > 0;
            }
            remember(ctx, person);
            const body = bodyOf(ctx);
            const code = typeof body.code === "string" ? body.code : "";
            switch (ctx.path) {
              case "/two-factor/verify-totp": {
                if (!person) return;
                if (!person.signIn && person.twoFactorEnabled) {
                  throw fail("BAD_REQUEST", "TWO_FACTOR_ALREADY_ON", "Two-factor sign-in is already on.");
                }
                if (!person.signIn) {
                  // Signed in, a code is only ever the end of an authenticator set-up this session started with the
                  // password (`/two-factor/enable`): never a guess against a row whose secret nobody was shown (a
                  // passkey-only person's recovery codes). Locked accounts wait; wrong codes count toward the lockout.
                  const setup = await ctx.context.internalAdapter.findVerificationValue(totpSetupId(person.userId));
                  if (!setup || setup.value !== person.sessionId || setup.expiresAt < new Date()) {
                    await emit(ctx, {
                      action: "auth.two_factor_enabled",
                      userId: person.userId,
                      email: person.email,
                      by: "self",
                      denied: "no_setup_pending",
                    });
                    throw fail(
                      "BAD_REQUEST",
                      "NO_SETUP_PENDING",
                      "This set-up expired or wasn't started here. Start setting up your authenticator app again.",
                    );
                  }
                  if (isLocked(await lockRow(ctx, person.userId))) {
                    throw new APIError("TOO_MANY_REQUESTS", {
                      code: "ACCOUNT_TEMPORARILY_LOCKED",
                      message: "Too many wrong codes. Try again later.",
                    });
                  }
                }
                // A valid code is claimed here, before the plugin accepts it: of two requests racing with the same
                // code, only the one that wins the claim gets through.
                if ((await checkTotp(ctx, hooks, person.userId, code)) === "reused") {
                  await emit(ctx, {
                    action: person.signIn ? "auth.sign_in_failed" : "auth.two_factor_enabled",
                    userId: person.userId,
                    email: person.email,
                    by: person.signIn ? "identity" : "self",
                    denied: "code_reused",
                    meta: { method: "totp" },
                  });
                  throw fail("UNAUTHORIZED", "INVALID_CODE", "That code was already used. Wait for the next one.");
                }
                return;
              }
              case "/two-factor/verify-backup-code": {
                if (person && !person.signIn) {
                  throw fail("BAD_REQUEST", "RECOVERY_CODE_SIGN_IN_ONLY", "Recovery codes are for signing in.");
                }
                if (body.disableSession !== undefined) {
                  throw fail("BAD_REQUEST", "NOT_ALLOWED", "A recovery code always signs you in.");
                }
                if (!isRecoveryCodeInput(code)) {
                  if (person) {
                    await emit(ctx, {
                      action: "auth.sign_in_failed",
                      userId: person.userId,
                      email: person.email,
                      by: "identity",
                      denied: "invalid_backup_code",
                      meta: { method: "recovery_code" },
                    });
                  }
                  throw fail("UNAUTHORIZED", "INVALID_BACKUP_CODE", "That recovery code isn't right.");
                }
                return { context: { body: { ...body, code: hashRecoveryCode(code) } } };
              }
              case "/two-factor/disable": {
                if (!person || person.signIn) return;
                // Nothing to turn off: someone whose second factor is a passkey (their recovery codes stay).
                if (!person.twoFactorEnabled) {
                  throw fail("BAD_REQUEST", "TWO_FACTOR_NOT_ENABLED", "Two-factor sign-in with an app isn't on.");
                }
                if (!(await secondFactorOk(ctx, hooks, person.userId, code))) {
                  await emit(ctx, {
                    action: "auth.two_factor_disabled",
                    userId: person.userId,
                    email: person.email,
                    by: "self",
                    denied: "invalid_code",
                  });
                  throw fail(
                    "BAD_REQUEST",
                    "INVALID_CODE",
                    "That code isn't right. Use a current code from your authenticator app or a recovery code.",
                  );
                }
                const refusal = await hooks.removalRefusal(person.userId, "totp");
                if (refusal) {
                  await emit(ctx, {
                    action: "auth.two_factor_disabled",
                    userId: person.userId,
                    email: person.email,
                    by: "self",
                    denied: "factor_required",
                  });
                  throw fail("CONFLICT", "FACTOR_REQUIRED", refusal);
                }
                // Turning the authenticator off deletes the row; someone who keeps a passkey keeps their recovery codes.
                if ((await hooks.factors(person.userId)).passkeys > 0) {
                  const row = await twoFactorRow(ctx, person.userId);
                  if (row) person.keepCodes = row.backupCodes;
                }
                return;
              }
              case "/two-factor/enable": {
                // Setting up an authenticator replaces the codes of a passkey-only person only once it's finished (the
                // first code verified): until then the codes they saved keep working.
                if (!person || person.signIn) return;
                const row = await ctx.context.adapter.findOne<{ backupCodes: string; verified?: boolean | null }>({
                  model: "twoFactor",
                  where: [{ field: "userId", value: person.userId }],
                });
                if (row?.verified === false) person.keepCodes = row.backupCodes;
                return;
              }
              case "/passkey/generate-register-options":
              case "/passkey/verify-registration": {
                if (!person?.sessionId) return; // the plugin answers 401
                if (body.createSession !== undefined) {
                  throw fail("BAD_REQUEST", "NOT_ALLOWED", "Adding a passkey never starts a new session.");
                }
                // A recent step-up is needed; registering uses it up.
                const marker =
                  ctx.path === "/passkey/verify-registration"
                    ? await ctx.context.internalAdapter.consumeVerificationValue(stepUpId(person.sessionId))
                    : await ctx.context.internalAdapter.findVerificationValue(stepUpId(person.sessionId));
                if (marker?.value !== person.userId || marker.expiresAt < new Date()) {
                  throw new APIError("FORBIDDEN", {
                    code: "STEP_UP_REQUIRED",
                    message: "Confirm it's you first: enter your console password.",
                  });
                }
                if (ctx.path === "/passkey/generate-register-options") return;
                if (body.name === undefined || body.name === "") return;
                try {
                  return { context: { body: { ...body, name: passkeyName(body.name) } } };
                } catch (err) {
                  if (err instanceof DomainError) throw fail("BAD_REQUEST", "INVALID_NAME", err.message);
                  throw err;
                }
              }
              default:
                return;
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => AFTER.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            const failed = isAPIError(returned);
            const code = failed ? errorCode(returned) : null;
            const ok = (returned ?? {}) as { user?: { id?: string; email?: string }; twoFactorRedirect?: boolean };
            const person = recall(ctx);
            const body = bodyOf(ctx);
            switch (ctx.path) {
              case "/sign-in/email": {
                const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
                if (failed) {
                  const found = email ? await ctx.context.internalAdapter.findUserByEmail(email) : null;
                  await emit(ctx, {
                    action: "auth.sign_in_failed",
                    userId: found?.user.id ?? null,
                    email,
                    by: "identity",
                    denied: code ?? "failed",
                    meta: { method: "password" },
                  });
                  return;
                }
                if (ok.twoFactorRedirect === true) {
                  // The two-factor plugin set a challenge (authenticator app; its answer names nobody): the password
                  // was right for this address. List every method the person may use.
                  const found = email ? await ctx.context.internalAdapter.findUserByEmail(email) : null;
                  return found ? secondStep(ctx, found.user.id, found.user.email) : undefined;
                }
                if (!ok.user?.id) return;
                const userId = ok.user.id;
                const userEmail = ok.user.email ?? email;
                // The password created a session before any of this: if deciding about the second step fails, end it
                // (fail closed), so nobody with a second factor is left signed in with the password alone.
                let trusted: boolean | undefined;
                try {
                  // Signed in with the password alone: no second factor, or a trusted browser skipped the code step.
                  const f = await hooks.factors(userId);
                  // With an authenticator app the two-factor plugin already honoured a trusted browser; for someone whose
                  // second factor is a passkey, we check the same cookie here.
                  trusted =
                    (ok.user as { twoFactorEnabled?: unknown }).twoFactorEnabled === true ||
                    (f.passkeys > 0 && (await trustedBrowser(ctx, userId)));
                  const method: SignInMethod = trusted ? "password+trusted_device" : "password";
                  const fresh = ctx.context.newSession;
                  // Someone with passkeys gets the passkey step (ADR-0028); a trusted browser still skips it, unless an
                  // account requirement wouldn't accept the trusted browser (a passkey requirement).
                  if (f.passkeys > 0 && (!trusted || (await hooks.sessionRefusal(userId, method)) !== null)) {
                    deleteSessionCookie(ctx, true);
                    if (fresh) await ctx.context.internalAdapter.deleteSession(fresh.session.token);
                    ctx.context.setNewSession(null);
                    await issueChallenge(ctx, userId);
                    return await secondStep(ctx, userId, userEmail);
                  }
                  if (trusted && fresh) {
                    await ctx.context.adapter.update({
                      model: "session",
                      where: [{ field: "id", value: fresh.session.id }],
                      update: { signInMethod: "password+trusted_device" },
                    });
                  }
                  await refuseIfRequired(ctx, userId, userEmail ?? "", method);
                } catch (err) {
                  // Whatever went wrong (a refusal or a failure), the password-only session goes first.
                  deleteSessionCookie(ctx, true);
                  const fresh = ctx.context.newSession;
                  if (fresh)
                    await ctx.context.internalAdapter.deleteSession(fresh.session.token).catch(() => undefined);
                  ctx.context.setNewSession(null);
                  if (isAPIError(err)) throw err;
                  throw new APIError("SERVICE_UNAVAILABLE", {
                    code: "SIGN_IN_UNAVAILABLE",
                    message: "Signing in isn't working right now. Try again in a minute.",
                  });
                }
                await emit(ctx, {
                  action: "auth.sign_in",
                  userId,
                  email: userEmail,
                  by: "self",
                  meta: { method: "password", ...(trusted ? { trustedDevice: true } : {}) },
                });
                return;
              }
              case "/two-factor/verify-totp":
              case "/two-factor/verify-backup-code": {
                if (!person) return;
                const recovery = ctx.path === "/two-factor/verify-backup-code";
                const method = recovery ? "password+recovery_code" : "password+totp";
                const base = { userId: person.userId, email: person.email };
                if (failed) {
                  const locked = code === "account_temporarily_locked";
                  await emit(ctx, {
                    ...base,
                    action: locked
                      ? "auth.locked_out"
                      : person.signIn
                        ? "auth.sign_in_failed"
                        : "auth.two_factor_enabled",
                    by: person.signIn ? "identity" : "self",
                    denied: code ?? "failed",
                    meta: { method: recovery ? "recovery_code" : "totp" },
                  });
                  // Wrong codes finishing a set-up count toward the lockout too (the plugin counts only sign-ins).
                  if (!person.signIn && !recovery) await countAccountFailure(ctx, await lockRow(ctx, person.userId));
                  return;
                }
                if (!person.signIn) {
                  // Turning it on starts a new session (signed in with the password and this code).
                  await ctx.context.internalAdapter
                    .deleteVerificationByIdentifier(totpSetupId(person.userId))
                    .catch(() => undefined);
                  const fresh = ctx.context.newSession;
                  if (fresh) await markStepUp(ctx, person.userId, fresh.session.id);
                  // The set-up is finished: the codes shown with it replace a passkey-only person's old ones.
                  const pending = await ctx.context.internalAdapter
                    .consumeVerificationValue(pendingCodesId(person.userId))
                    .catch(() => null);
                  if (pending) await storePasskeyCodes(ctx, person.userId, pending.value);
                  await emit(ctx, { ...base, action: "auth.two_factor_enabled", by: "self", meta: { method: "totp" } });
                  await hooks.factorAdded({
                    ...base,
                    factor: "totp",
                    firstFactor: person.hadFactor === false,
                    userAgent: ua(ctx),
                  });
                  return;
                }
                await refuseIfRequired(ctx, person.userId, person.email, method);
                const trustDevice = body.trustDevice === true;
                await emit(ctx, {
                  ...base,
                  action: "auth.sign_in",
                  by: "self",
                  meta: { method, ...(trustDevice ? { trustDevice: true } : {}) },
                });
                if (recovery) {
                  const row = await ctx.context.adapter.findOne<{ backupCodes: string }>({
                    model: "twoFactor",
                    where: [{ field: "userId", value: person.userId }],
                  });
                  const left = row ? (JSON.parse(row.backupCodes) as unknown[]).length : 0;
                  await emit(ctx, { ...base, action: "auth.backup_code_used", by: "self", meta: { codesLeft: left } });
                }
                return;
              }
              case "/two-factor/disable":
              case "/two-factor/enable":
              case "/two-factor/generate-backup-codes":
              case "/passkey/verify-registration": {
                if (!person || person.signIn) return;
                const action: AuditAction =
                  ctx.path === "/two-factor/disable"
                    ? "auth.two_factor_disabled"
                    : ctx.path === "/two-factor/generate-backup-codes"
                      ? "auth.recovery_codes_regenerated"
                      : ctx.path === "/passkey/verify-registration"
                        ? "auth.passkey_added"
                        : "auth.two_factor_enabled";
                const base = { action, userId: person.userId, email: person.email, by: "self" as const };
                if (failed) {
                  await emit(ctx, { ...base, denied: code ?? "failed" });
                  await strikeIfWrongPassword(ctx, person, code);
                  return;
                }
                // Starting setup changes nothing yet: "turned on" is recorded when the first code is verified.
                if (ctx.path === "/two-factor/enable") {
                  // The set-up this session may finish with a code (and nothing else may: `verify-totp` above).
                  if (person.sessionId) {
                    await ctx.context.internalAdapter
                      .deleteVerificationByIdentifier(totpSetupId(person.userId))
                      .catch(() => undefined);
                    await ctx.context.internalAdapter.createVerificationValue({
                      identifier: totpSetupId(person.userId),
                      value: person.sessionId,
                      expiresAt: new Date(Date.now() + TOTP_SETUP_MINUTES * 60_000),
                    });
                  }
                  if (person.keepCodes === undefined) return;
                  // A passkey-only person's saved codes keep working until the set-up is finished; the new ones wait.
                  const row = await twoFactorRow(ctx, person.userId);
                  if (row) {
                    await ctx.context.internalAdapter
                      .deleteVerificationByIdentifier(pendingCodesId(person.userId))
                      .catch(() => undefined);
                    await ctx.context.internalAdapter.createVerificationValue({
                      identifier: pendingCodesId(person.userId),
                      value: row.backupCodes,
                      // Outlives the set-up window, so a set-up can never finish without its codes taking over
                      // (finishing after the window is refused: the set-up starts again).
                      expiresAt: new Date(Date.now() + (TOTP_SETUP_MINUTES + 5) * 60_000),
                    });
                  }
                  await storePasskeyCodes(ctx, person.userId, person.keepCodes);
                  return;
                }
                if (ctx.path === "/two-factor/disable") {
                  // Every trusted browser asks again if two-factor sign-in is ever turned back on.
                  await ctx.context.adapter.deleteMany({
                    model: "verification",
                    where: [
                      { field: "value", value: person.userId },
                      { field: "identifier", operator: "starts_with", value: "trust-device-" },
                    ],
                  });
                  // Someone who keeps a passkey keeps their recovery codes for it.
                  if (person.keepCodes !== undefined) await storePasskeyCodes(ctx, person.userId, person.keepCodes);
                  await emit(ctx, {
                    ...base,
                    meta: {
                      withCode: /^\d{6}$/.test((typeof body.code === "string" ? body.code : "").trim())
                        ? "totp"
                        : "recovery_code",
                      ...(person.keepCodes !== undefined ? { recoveryCodesKept: true } : {}),
                    },
                  });
                  return;
                }
                if (ctx.path === "/passkey/verify-registration") {
                  const p = returned as { id?: string; name?: string | null };
                  // A verified passkey (with user verification) added in this password-signed session upgrades it, as
                  // if the passkey had been the second step: requirements then accept it.
                  if (person.sessionId) {
                    await ctx.context.adapter.update({
                      model: "session",
                      where: [{ field: "id", value: person.sessionId }],
                      update: { signInMethod: "password+passkey" },
                    });
                  }
                  await emit(ctx, { ...base, meta: { passkeyId: p.id ?? null, passkeyName: p.name ?? null } });
                  await hooks.factorAdded({
                    userId: person.userId,
                    email: person.email,
                    factor: "passkey",
                    firstFactor: person.hadFactor === false,
                    userAgent: ua(ctx),
                  });
                  // A first second factor comes with recovery codes, shown once (ADR-0028).
                  if (person.hadFactor === false) {
                    const recoveryCodes = await newPasskeyCodes(ctx, person.userId);
                    await emit(ctx, {
                      action: "auth.recovery_codes_regenerated",
                      userId: person.userId,
                      email: person.email,
                      by: "self",
                      meta: { with: "passkey", firstFactor: true },
                    });
                    return ctx.json({ ...(returned as Record<string, unknown>), recoveryCodes });
                  }
                  return;
                }
                await emit(ctx, base);
                return;
              }
              case "/change-password":
              case "/reset-password": {
                if (failed && ctx.path === "/change-password" && person) await strikeIfWrongPassword(ctx, person, code);
                if (failed || !person || person.signIn) return;
                const via = ctx.path === "/reset-password" ? "reset" : "change";
                let keepSessionId: string | null = null;
                if (via === "change") {
                  // With `revokeOtherSessions` the endpoint replaced the session: keep the new one.
                  const token = (returned as { token?: string | null } | null)?.token ?? null;
                  const fresh = token ? await ctx.context.internalAdapter.findSession(token) : null;
                  keepSessionId = fresh?.session.id ?? person.sessionId ?? null;
                }
                await hooks.passwordChanged({
                  userId: person.userId,
                  email: person.email,
                  via,
                  keepSessionId,
                  removePasskeys: via === "reset" && person.removePasskeys === true,
                  userAgent: ua(ctx),
                });
                return;
              }
              case "/passkey/generate-authenticate-options": {
                // Ask for the challenged person's own passkeys, with the PIN, fingerprint or face check.
                if (failed || !person || !returned || typeof returned !== "object") return;
                const keys = await ctx.context.adapter.findMany<{ credentialID: string; transports?: string | null }>({
                  model: "passkey",
                  where: [{ field: "userId", value: person.userId }],
                });
                return ctx.json({
                  ...(returned as Record<string, unknown>),
                  userVerification: "required",
                  allowCredentials: keys.map((k) => ({
                    id: k.credentialID,
                    type: "public-key",
                    ...(k.transports ? { transports: k.transports.split(",") } : {}),
                  })),
                });
              }
              case "/passkey/verify-authentication": {
                const challenge = person?.challenge;
                if (!person || !challenge) return;
                const base = { userId: person.userId, email: person.email };
                const row = await lockRow(ctx, person.userId);
                if (failed) {
                  await countChallengeFailure(ctx, challenge);
                  await countAccountFailure(ctx, row);
                  await emit(ctx, {
                    ...base,
                    action: "auth.sign_in_failed",
                    by: "identity",
                    denied: code ?? "failed",
                    meta: { method: "passkey" },
                  });
                  return;
                }
                const fresh = ctx.context.newSession;
                // The plugin signed in the passkey's owner: it must be the challenged person, and the challenge is used
                // up here (of two racing requests, one wins).
                const used = await endChallenge(ctx, challenge.id);
                if (!used || fresh?.user.id !== person.userId) {
                  deleteSessionCookie(ctx, true);
                  if (fresh) await ctx.context.internalAdapter.deleteSession(fresh.session.token);
                  ctx.context.setNewSession(null);
                  await emit(ctx, {
                    ...base,
                    action: "auth.sign_in_failed",
                    by: "identity",
                    denied: "invalid_two_factor_cookie",
                    meta: { method: "passkey" },
                  });
                  throw fail("UNAUTHORIZED", "INVALID_TWO_FACTOR_COOKIE", "This sign-in expired. Start again.");
                }
                if (row) {
                  await ctx.context.adapter.update({
                    model: "twoFactor",
                    where: [{ field: "id", value: row.id }],
                    update: { failedVerificationCount: 0, lockedUntil: null },
                  });
                }
                await refuseIfRequired(ctx, person.userId, person.email, "password+passkey");
                if (person.trustDevice === true) await trustBrowser(ctx, person.userId);
                await emit(ctx, {
                  ...base,
                  action: "auth.sign_in",
                  by: "self",
                  meta: { method: "password+passkey", ...(person.trustDevice === true ? { trustDevice: true } : {}) },
                });
                return;
              }
              default:
                return;
            }
          }),
        },
        {
          // Last: the browser never needs a session token (it has the cookie) or passkey material. Only for HTTP
          // requests to these endpoints: server-side calls (e.g. `getSession`) keep their full answers.
          matcher: (ctx) => ctx.request !== undefined && STRIP.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!returned || typeof returned !== "object" || isAPIError(returned) || returned instanceof Response)
              return;
            if (Array.isArray(returned)) return;
            const r = returned as Record<string, unknown>;
            if (!SECRET_FIELDS.some((k) => k in r)) return;
            const clean = Object.fromEntries(
              Object.entries(r).filter(([k]) => !(SECRET_FIELDS as readonly string[]).includes(k)),
            );
            return ctx.json(clean);
          }),
        },
      ],
    },
  };
}
