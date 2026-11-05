// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Refuses a new console password found in the breached-password corpus (docs/internal/07-security.md "Breached-password
 * check"), before the endpoint hashes or stores anything: sign-up, password reset (incl. the emailed set-password link
 * a new platform administrator gets), change password and set password. better-auth ships a plugin for the same
 * service, but it fails closed (a 500 when the service is unreachable), has no timeout and fetches by itself; ours goes
 * through the core port (one adapter, a fake in tests) and fails open.
 *
 * A password outside the length rules is left to the endpoint, so its own message comes first. So is a reset with a
 * missing, unknown or expired token: the endpoint answers `INVALID_TOKEN` without anyone asking the service about a
 * password nobody can set (no outbound lookup, and the answer can't tell a breached password from a dead link).
 */
import type { BreachedPasswords } from "@anhourmail/core/security";
import { BREACHED_PASSWORD } from "@anhourmail/shared/security";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/** Endpoint → the body field that carries the new password. */
export const NEW_PASSWORD_FIELDS: Readonly<Record<string, "password" | "newPassword">> = {
  "/sign-up/email": "password",
  "/reset-password": "newPassword",
  "/change-password": "newPassword",
  "/set-password": "newPassword",
};

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Whether the reset request carries a token the endpoint would accept (body or query, as better-auth reads it; same
 * verification row and expiry check). Read only: the endpoint itself consumes it.
 */
async function liveResetToken(ctx: HookContext): Promise<boolean> {
  const body = ctx.body as Record<string, unknown> | undefined;
  const query = ctx.query as Record<string, unknown> | undefined;
  const fromBody = body?.token;
  const token = typeof fromBody === "string" && fromBody !== "" ? fromBody : query?.token;
  if (typeof token !== "string" || token === "") return false;
  const verification = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`);
  if (!verification) return false;
  return verification.expiresAt >= new Date();
}

export function breachedPasswordPlugin(
  check: BreachedPasswords,
  lengths: { min: number; max: number },
): BetterAuthPlugin {
  return {
    id: "anhourmail-breached-passwords",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path !== undefined && ctx.path in NEW_PASSWORD_FIELDS,
          handler: createAuthMiddleware(async (ctx) => {
            const field = NEW_PASSWORD_FIELDS[ctx.path];
            if (!field) return;
            if (ctx.path === "/sign-up/email" && ctx.context.options.emailAndPassword?.disableSignUp) return;
            const body = ctx.body as Record<string, unknown> | undefined;
            const password = body?.[field];
            if (typeof password !== "string" || password.length < lengths.min || password.length > lengths.max) return;
            if (ctx.path === "/reset-password" && !(await liveResetToken(ctx))) return;
            if ((await check.check(password)) === "breached") {
              throw new APIError("BAD_REQUEST", {
                code: BREACHED_PASSWORD.authCode,
                message: BREACHED_PASSWORD.message,
              });
            }
          }),
        },
      ],
    },
  };
}
