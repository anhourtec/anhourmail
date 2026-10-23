// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console identity adapter (better-auth). Only this folder imports the SDK (ADR-0008). Mailbox identity is
 * Stalwart's; this is the AnhourMail console login. Sign-up is controlled by `signUp` (SIGNUP_MODE: open | closed):
 * open while the app is reachable only from allow-listed IPs (docs/internal/08-operations.md "Access control"),
 * closed to stop self-service sign-up entirely.
 */
import { getAuthenticatorName, passkey } from "@better-auth/passkey";
import {
  isSignInMethod,
  SECOND_STEP_LIMITS,
  type SignInMethod,
  TOTP,
  TRUSTED_DEVICE_DAYS,
} from "@anhourmail/shared/security";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { toNextJsHandler } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";

import type { Db } from "../db-postgres/client";
import {
  authAccount,
  authPasskey,
  authSession,
  authTwoFactor,
  authUser,
  authVerification,
} from "../db-postgres/schema";
import { hashPassword, verifyPassword } from "./password";
import { hashedBackupCodeStore, newRecoveryCodes } from "./recovery-codes";
import { type Sealer, sealTwoFactorSecrets } from "./sealed-adapter";
import { type SecurityHooks, securityPlugin } from "./security-plugin";

export type AuthOptions = {
  db: Db;
  secret: string;
  /** Console origin, e.g. https://app.anhourmail.com. */
  baseURL: string;
  /** Extra origins allowed to call the auth endpoints (dev: *.localhost, LAN IPs). */
  trustedOrigins: string[];
  secureCookies: boolean;
  /** Allow self-service sign-up (POST /api/auth/sign-up/email). */
  signUp: "open" | "closed";
  /** Runs after a new console user is stored (personal account provisioning). Errors are logged by the caller. */
  onUserCreated?: (user: { id: string; email: string; name: string }) => Promise<void>;
  /** Sends the reset link. Must not reveal whether the address has an account (the endpoint answers the same). */
  sendPasswordReset: (input: { email: string; name: string; url: string }) => Promise<void>;
  /** After a successful reset (audit, notifications). */
  onPasswordReset?: (user: { id: string; email: string }) => Promise<void>;
  /** Key ring that seals TOTP secrets at rest (rule 16). */
  sealer: Sealer;
  /**
   * WebAuthn relying party: the console origin only (never the webmail's). `id` is the console host name
   * (`app.anhourmail.com`; `localhost` in development).
   */
  relyingParty: { id: string; name: string; origin: string };
  /** Behind our proxy (TRUST_PROXY=true): take the client address from X-Forwarded-For; otherwise never. */
  trustProxy: boolean;
  /** Auditing and checks around sign-in factors (`security-plugin.ts`). */
  security: SecurityHooks;
};

/** Passkeys must prove the person, not just the device (PIN, fingerprint or face): a passkey signs in on its own. */
function requireUserVerified(verified: boolean): void {
  if (!verified) {
    throw new APIError("UNAUTHORIZED", {
      code: "USER_NOT_VERIFIED",
      message: "Your passkey didn't confirm it's you. Use one with a PIN, fingerprint or face check.",
    });
  }
}

export function createAuth(opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins,
    database: (options: BetterAuthOptions) =>
      sealTwoFactorSecrets(
        drizzleAdapter(opts.db, {
          provider: "pg",
          schema: {
            user: authUser,
            session: authSession,
            account: authAccount,
            verification: authVerification,
            twoFactor: authTwoFactor,
            passkey: authPasskey,
          },
        })(options),
        opts.sealer,
      ),
    emailAndPassword: {
      enabled: true,
      disableSignUp: opts.signUp === "closed",
      minPasswordLength: 12,
      // Salted argon2id (OWASP baseline) instead of the library default (docs/internal/07-security.md).
      password: { hash: hashPassword, verify: verifyPassword },
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await opts.sendPasswordReset({ email: user.email, name: user.name, url });
      },
      onPasswordReset: async ({ user }) => {
        await opts.onPasswordReset?.({ id: user.id, email: user.email });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // How the session was signed in (account requirements depend on it; never set from input).
      additionalFields: { signInMethod: { type: "string", required: false, input: false } },
    },
    // First name is required, last name optional; `name` is the editable display name (defaults to "First Last").
    user: {
      additionalFields: {
        firstName: { type: "string", required: true, input: true },
        lastName: { type: "string", required: false, input: true },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            // The session this one replaces, if any: endpoints without session middleware (e.g. turning on an
            // authenticator via verify-totp) haven't loaded it, so read it from the request.
            const current =
              context?.context.session?.session ??
              (context ? ((await getSessionFromCtx(context).catch(() => null))?.session ?? null) : null);
            return { data: { ...session, signInMethod: signInMethodFor(context?.path, current) } };
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            const names = normaliseNames(user);
            if (!names) throw new APIError("BAD_REQUEST", { message: "First name is required." });
            return { data: { ...user, ...names } };
          },
          after: async (user) => {
            await opts.onUserCreated?.({ id: user.id, email: user.email, name: user.name });
          },
        },
        // Profile edits get the same trimming and length caps as sign-up (a blank first name is refused).
        update: {
          before: async (data) => {
            const touched = "firstName" in data || "lastName" in data || "name" in data;
            if (!touched) return { data };
            const d = data as { firstName?: unknown; lastName?: unknown; name?: unknown };
            if ("name" in data && clean(d.name, 80) === "") {
              throw new APIError("BAD_REQUEST", { message: "Display name can't be empty." });
            }
            // Fields not being edited are filled with harmless stand-ins only so the shared rules can run.
            const names = normaliseNames({
              firstName: "firstName" in data ? d.firstName : "x",
              lastName: d.lastName,
              name: "name" in data ? d.name : "x",
            });
            if (!names) throw new APIError("BAD_REQUEST", { message: "First name is required." });
            return {
              data: {
                ...data,
                ...("firstName" in data ? { firstName: names.firstName } : {}),
                ...("lastName" in data ? { lastName: names.lastName } : {}),
                ...("name" in data ? { name: names.name } : {}),
              },
            };
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: "AnhourMail",
        totpOptions: { digits: TOTP.digits, period: TOTP.periodSeconds },
        // Recovery codes: our format, stored as hashes only (recovery-codes.ts).
        backupCodeOptions: {
          storeBackupCodes: hashedBackupCodeStore,
          customBackupCodesGenerate: () => newRecoveryCodes(),
        },
        trustDeviceMaxAge: TRUSTED_DEVICE_DAYS * 24 * 3600,
        twoFactorCookieMaxAge: SECOND_STEP_LIMITS.challengeMinutes * 60,
        accountLockout: {
          enabled: true,
          maxFailedAttempts: SECOND_STEP_LIMITS.perAccount,
          durationSeconds: SECOND_STEP_LIMITS.lockMinutes * 60,
        },
      }),
      passkey({
        rpID: opts.relyingParty.id,
        rpName: opts.relyingParty.name,
        origin: opts.relyingParty.origin,
        // Discoverable credentials (so a passkey can sign in without typing an email) that check the person.
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          // The name typed is checked first (security-plugin.ts); without one, name it after the authenticator.
          afterVerification: ({ verification }) => {
            requireUserVerified(verification.registrationInfo?.userVerified === true);
            return { name: getAuthenticatorName(verification.registrationInfo?.aaguid) ?? "Passkey" };
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            requireUserVerified(verification.authenticationInfo.userVerified);
          },
        },
      }),
      // Last, so its after-hooks see the two plugins' final answers.
      securityPlugin(opts.security),
    ],
    // Host-only cookies (no Domain attribute): app.* and mail.* never share a session cookie (ADR-0003).
    advanced: {
      cookiePrefix: "am",
      useSecureCookies: opts.secureCookies,
      // Session and audit addresses: only from our proxy's header. Directly reachable (dev), a client could set it,
      // so read a header nobody sends (better-auth then records loopback in development).
      ipAddress: { ipAddressHeaders: opts.trustProxy ? ["x-forwarded-for"] : ["x-anhourmail-no-client-ip"] },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The sign-in method for a session being created, from the endpoint creating it. Sessions re-created by a signed-in
 * endpoint (turning two-factor on or off, changing the password) keep the method of the session they replace.
 */
export function signInMethodFor(path: string | undefined, current: unknown): SignInMethod {
  switch (path) {
    case "/two-factor/verify-totp": {
      // Turning on an authenticator in a passkey session keeps the stronger method.
      const m = (current as { signInMethod?: unknown } | null | undefined)?.signInMethod;
      return m === "passkey" ? "passkey" : "password+totp";
    }
    case "/two-factor/verify-backup-code":
      return "password+recovery_code";
    case "/passkey/verify-authentication":
      return "passkey";
    case "/sign-in/email":
    case "/sign-up/email":
      return "password";
    default: {
      const m = (current as { signInMethod?: unknown } | null | undefined)?.signInMethod;
      return isSignInMethod(m) ? m : "password";
    }
  }
}

const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";

/**
 * Trims and caps the name fields; the display name falls back to "First Last". Returns null when the first name
 * is missing (the request is refused).
 */
export function normaliseNames(input: { firstName?: unknown; lastName?: unknown; name?: unknown }): {
  firstName: string;
  lastName: string | null;
  name: string;
} | null {
  const firstName = clean(input.firstName, 60);
  if (firstName === "") return null;
  const lastName = clean(input.lastName, 60);
  const display = clean(input.name, 80);
  return {
    firstName,
    lastName: lastName === "" ? null : lastName,
    name: display !== "" ? display : [firstName, lastName].filter(Boolean).join(" "),
  };
}

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  sessionId: string;
  signInMethod: SignInMethod | null;
};

export async function sessionUser(auth: Auth, headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const m = (session.session as { signInMethod?: unknown }).signInMethod;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.session.id,
    signInMethod: isSignInMethod(m) ? m : null,
  };
}

export const authRouteHandlers = (auth: Auth) => toNextJsHandler(auth);

/** Password hashing for server-side account creation (seed). Same scheme as sign-in. */
export { hashPassword, mailboxPasswordHasher, needsRehash, verifyPassword } from "./password";
export { hashRecoveryCode, newRecoveryCodes, recoveryCodesLeft } from "./recovery-codes";
export type { Sealer } from "./sealed-adapter";
export type { AuthSecurityEvent, SecurityHooks } from "./security-plugin";
export { totpAt, verifyTotp } from "./totp";
