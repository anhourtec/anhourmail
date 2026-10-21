// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console identity adapter (better-auth). Only this folder imports the SDK (ADR-0008). Mailbox identity is
 * Stalwart's; this is the AnhourMail console login. Sign-up is controlled by `signUp` (SIGNUP_MODE: open | closed):
 * open while the app is reachable only from allow-listed IPs (docs/internal/08-operations.md "Access control"),
 * closed to stop self-service sign-up entirely.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { toNextJsHandler } from "better-auth/next-js";

import type { Db } from "../db-postgres/client";
import { authAccount, authSession, authUser, authVerification } from "../db-postgres/schema";
import { hashPassword, verifyPassword } from "./password";

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
};

export function createAuth(opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins,
    database: drizzleAdapter(opts.db, {
      provider: "pg",
      schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification },
    }),
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
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    // First name is required, last name optional; `name` is the editable display name (defaults to "First Last").
    user: {
      additionalFields: {
        firstName: { type: "string", required: true, input: true },
        lastName: { type: "string", required: false, input: true },
      },
    },
    databaseHooks: {
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
    // Host-only cookies (no Domain attribute): app.* and mail.* never share a session cookie (ADR-0003).
    advanced: { cookiePrefix: "am", useSecureCookies: opts.secureCookies },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

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

export type SessionUser = { id: string; email: string; name: string };

export async function sessionUser(auth: Auth, headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  return { id: session.user.id, email: session.user.email, name: session.user.name };
}

export const authRouteHandlers = (auth: Auth) => toNextJsHandler(auth);

/** Password hashing for server-side account creation (seed). Same scheme as sign-in. */
export { hashPassword, needsRehash, verifyPassword } from "./password";
