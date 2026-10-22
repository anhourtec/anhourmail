// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Our own better-auth plugin around the two-factor and passkey plugins (docs/internal/07-security.md "Sign-in
 * factors"). It is listed after them, so its after-hooks see their final answers.
 *
 * Before an endpoint runs it:
 * - refuses an authenticator code that was already accepted in the last two minutes (one-time use);
 * - hashes a typed recovery code, so the two-factor plugin only ever compares stored hashes;
 * - lets two-factor sign-in be turned off only with a current code (authenticator or recovery code) on top of the
 *   password, and never when an account requirement depends on it;
 * - refuses re-verifying an authenticator that is already on, and recovery codes outside sign-in (or anything that
 *   looks like a stored value);
 * - lets a passkey be added only after a recent step-up (a sign-in or `POST /step-up` in the last few minutes; the
 *   marker is used up by the registration), never with `createSession`.
 *
 * After it runs, it records how each new session signed in, refuses a sign-in whose method an account requirement
 * doesn't accept (the new session is deleted), strips session tokens and passkey material from responses, and
 * reports what happened (`onEvent`) so the app can audit it: sign-ins and failures with the method,
 * second steps, lockouts, factor changes. Never codes, secrets or passkey material.
 */
import { DomainError } from "@anhourmail/core";
import type { AuditAction } from "@anhourmail/core/audit";
import { passkeyName } from "@anhourmail/core/security";
import { isSignInMethod, SECOND_STEP_LIMITS, type SignInMethod, STEP_UP_MINUTES } from "@anhourmail/shared/security";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
  sessionMiddleware,
} from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";

import { hashRecoveryCode, isRecoveryCodeInput } from "./recovery-codes";
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
  /** The person's second factors right now (no secrets). */
  factors(userId: string): Promise<{ totp: boolean; passkeys: number }>;
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
};

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const BEFORE = new Set([
  "/sign-out",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/disable",
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/step-up",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/change-password",
  "/reset-password",
]);

const AFTER = new Set([
  "/sign-in/email",
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
  const cookie = ctx.context.createAuthCookie("two_factor");
  const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!challenge) return null;
  const v = await ctx.context.internalAdapter.findVerificationValue(challenge);
  if (!v || v.expiresAt < new Date()) return null;
  const user = await ctx.context.internalAdapter.findUserById(v.value);
  return user ? { userId: user.id, email: user.email, signIn: true, twoFactorEnabled: true } : null;
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

/** Wrong step-ups one session may make before it is signed out. */
const STEP_UP_SESSION_FAILURES = 5;

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

/**
 * A current authenticator code (claimed, so never used twice) or an unused recovery code. With `consume`, a matching
 * recovery code is used up (compare-and-swap on the stored list).
 */
async function secondFactorOk(
  ctx: Pick<Ctx, "context">,
  hooks: SecurityHooks,
  userId: string,
  code: string,
  consume = false,
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
  const hash = hashRecoveryCode(code);
  if (!Array.isArray(hashes) || !hashes.includes(hash)) return false;
  if (!consume) return true;
  const used = await ctx.context.adapter.incrementOne({
    model: "twoFactor",
    where: [
      { field: "userId", value: userId },
      { field: "backupCodes", value: row.backupCodes },
    ],
    increment: {},
    set: { backupCodes: JSON.stringify(hashes.filter((h) => h !== hash)) },
  });
  return used !== null;
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

  /** Signs the just-created session out again when a requirement refuses its method; audited. */
  const refuseIfRequired = async (ctx: Ctx, userId: string, email: string, method: SignInMethod) => {
    const refusal = await hooks.sessionRefusal(userId, method);
    const fresh = ctx.context.newSession;
    if (!refusal) {
      // A sign-in counts as a step-up only when it proved the strongest thing the person has: a password-only
      // sign-in (or a trusted browser) doesn't, once they have a second factor.
      const passwordOnly = method === "password" || method === "password+trusted_device";
      const f = passwordOnly ? await hooks.factors(userId) : null;
      if (fresh && (!passwordOnly || (f?.totp === false && f.passkeys === 0))) {
        await markStepUp(ctx, userId, fresh.session.id);
      }
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

  return {
    id: "anhourmail-security",
    endpoints: {
      /**
       * `POST /step-up` (signed in): confirm it's you with your password, a current authenticator code or a recovery
       * code (used up). Lets this session add a passkey in the next few minutes. Audited, refusals too.
       */
      stepUp: createAuthEndpoint("/step-up", { method: "POST", use: [sessionMiddleware] }, async (ctx) => {
        const { user, session } = ctx.context.session;
        const body = (ctx.body && typeof ctx.body === "object" ? ctx.body : {}) as Record<string, unknown>;
        const password = typeof body.password === "string" ? body.password : "";
        const code = typeof body.code === "string" ? body.code : "";
        const userAgent = ctx.headers?.get("user-agent")?.slice(0, 300) ?? null;
        const f = await hooks.factors(user.id);
        if (password !== "" && (f.totp || f.passkeys > 0)) {
          throw new APIError("BAD_REQUEST", {
            code: "STEP_UP_NEEDS_FACTOR",
            message: f.totp
              ? "Use a code from your authenticator app or a recovery code."
              : "Sign out and sign in again with your passkey, then add the new one.",
          });
        }
        // Wrong passwords and codes here count toward the same lockout as the second sign-in step.
        const row = await ctx.context.adapter.findOne<{
          id: string;
          failedVerificationCount?: number | null;
          lockedUntil?: Date | null;
        }>({ model: "twoFactor", where: [{ field: "userId", value: user.id }] });
        if (row?.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) {
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "ACCOUNT_TEMPORARILY_LOCKED",
            message: "Too many wrong attempts. Try again later.",
          });
        }
        let ok = false;
        if (password !== "") {
          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          ok = account?.password ? await ctx.context.password.verify({ hash: account.password, password }) : false;
        } else if (code !== "") {
          ok = await secondFactorOk(ctx, hooks, user.id, code, true);
        }
        if (row) {
          if (ok) {
            await ctx.context.adapter.update({
              model: "twoFactor",
              where: [{ field: "id", value: row.id }],
              update: { failedVerificationCount: 0, lockedUntil: null },
            });
          } else {
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
        }
        const method = password !== "" ? "password" : /^\d{6}$/.test(code.trim()) ? "totp" : "recovery_code";
        await hooks.onEvent({
          action: "auth.identity_confirmed",
          userId: user.id,
          email: user.email,
          by: "self",
          ...(ok ? {} : { denied: "invalid_credentials" }),
          meta: { method },
          userAgent,
        });
        if (!ok) {
          // Per session too: after a few failures the session itself ends, so a stolen session can't keep the real
          // person locked out by burning the account's budget.
          const failId = `step-up-fail-${session.id}`;
          const prior = await ctx.context.internalAdapter.findVerificationValue(failId);
          const failures = (prior ? Number(prior.value) || 0 : 0) + 1;
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(failId).catch(() => undefined);
          if (failures >= STEP_UP_SESSION_FAILURES) {
            await ctx.context.internalAdapter.deleteSession(session.token);
            await hooks.onEvent({
              action: "auth.session_revoked",
              userId: user.id,
              email: user.email,
              by: "identity",
              meta: { reason: "step_up_failures", failures },
              userAgent,
            });
            throw new APIError("UNAUTHORIZED", {
              code: "STEP_UP_SESSION_ENDED",
              message: "Too many wrong attempts. You've been signed out; sign in again.",
            });
          }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: failId,
            value: String(failures),
            expiresAt: session.expiresAt,
          });
          throw new APIError("BAD_REQUEST", {
            code: "STEP_UP_FAILED",
            message: "That isn't right. Enter your password, a current code or a recovery code.",
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
                    message: "Confirm it's you first: enter your password or a code.",
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
                } else if (ok.twoFactorRedirect !== true && ok.user?.id) {
                  // Signed in with the password alone: no second step, or a trusted device skipped it.
                  const trusted = (ok.user as { twoFactorEnabled?: unknown }).twoFactorEnabled === true;
                  const fresh = ctx.context.newSession;
                  if (trusted && fresh) {
                    await ctx.context.adapter.update({
                      model: "session",
                      where: [{ field: "id", value: fresh.session.id }],
                      update: { signInMethod: "password+trusted_device" },
                    });
                  }
                  await refuseIfRequired(
                    ctx,
                    ok.user.id,
                    ok.user.email ?? email ?? "",
                    trusted ? "password+trusted_device" : "password",
                  );
                  await emit(ctx, {
                    action: "auth.sign_in",
                    userId: ok.user.id,
                    email: ok.user.email ?? email,
                    by: "self",
                    meta: { method: "password", ...(trusted ? { trustedDevice: true } : {}) },
                  });
                }
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
                  return;
                }
                if (!person.signIn) {
                  // Turning it on starts a new session (signed in with the password and this code).
                  const fresh = ctx.context.newSession;
                  if (fresh) await markStepUp(ctx, person.userId, fresh.session.id);
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
                  return;
                }
                // Starting setup changes nothing yet: "turned on" is recorded when the first code is verified.
                if (ctx.path === "/two-factor/enable") return;
                if (ctx.path === "/two-factor/disable") {
                  // Every trusted browser asks again if two-factor sign-in is ever turned back on.
                  await ctx.context.adapter.deleteMany({
                    model: "verification",
                    where: [
                      { field: "value", value: person.userId },
                      { field: "identifier", operator: "starts_with", value: "trust-device-" },
                    ],
                  });
                  await emit(ctx, {
                    ...base,
                    meta: {
                      withCode: /^\d{6}$/.test((typeof body.code === "string" ? body.code : "").trim())
                        ? "totp"
                        : "recovery_code",
                    },
                  });
                  return;
                }
                if (ctx.path === "/passkey/verify-registration") {
                  const p = returned as { id?: string; name?: string | null };
                  // A verified passkey (with user verification) upgrades this session: requirements then accept it.
                  if (person.sessionId) {
                    await ctx.context.adapter.update({
                      model: "session",
                      where: [{ field: "id", value: person.sessionId }],
                      update: { signInMethod: "passkey" },
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
                  return;
                }
                await emit(ctx, base);
                return;
              }
              case "/change-password":
              case "/reset-password": {
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
              case "/passkey/verify-authentication": {
                if (failed) {
                  await emit(ctx, {
                    action: "auth.sign_in_failed",
                    userId: null,
                    email: null,
                    by: "identity",
                    denied: code ?? "failed",
                    meta: { method: "passkey" },
                  });
                } else if (ok.user?.id) {
                  const fresh = ctx.context.newSession;
                  if (fresh) await markStepUp(ctx, ok.user.id, fresh.session.id);
                  await emit(ctx, {
                    action: "auth.sign_in",
                    userId: ok.user.id,
                    email: ok.user.email ?? null,
                    by: "self",
                    meta: { method: "passkey" },
                  });
                }
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
