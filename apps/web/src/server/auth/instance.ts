// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { networkInterfaces } from "node:os";

import { type Auth, createAuth } from "@anhourmail/adapters/auth";
import { db } from "@anhourmail/adapters/postgres";
import { provisionSignUp } from "@anhourmail/core/account";
import { inviteMatches, redeemInvite } from "@anhourmail/core/invite";
import { recordSecurityEvent } from "@anhourmail/core/security";
import { log } from "@anhourmail/server/log";
import { requestContext } from "@anhourmail/server/request-context";

import { container } from "../container";

import { env } from "../env";
import { passwordResetEmail } from "../mail/system-email";

/** Sign-up mode: `open` (anyone), `invite` (valid invite for that email), `closed` (no sign-up page). */
export const signUpMode = (): "open" | "invite" | "closed" => env().SIGNUP_MODE;
export const signUpOpen = (): boolean => env().SIGNUP_MODE !== "closed";

/** Dev: the machine's LAN IPv4 addresses, so the console works from other devices (DEV_HOST=0.0.0.0). */
export function lanOrigins(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i?.family === "IPv4" && !i.internal)
    .map((i) => `http://${i?.address ?? ""}:${port}`);
}

let instance: Auth | null = null;

export function auth(): Auth {
  if (!instance) {
    const e = env();
    const dev = e.NODE_ENV !== "production";
    instance = createAuth({
      db: db(),
      secret: e.BETTER_AUTH_SECRET,
      baseURL: e.APP_URL,
      trustedOrigins: [
        e.APP_URL,
        e.WEBMAIL_URL,
        ...(dev
          ? [`http://localhost:${e.WEB_DEV_PORT}`, `http://127.0.0.1:${e.WEB_DEV_PORT}`, ...lanOrigins(e.WEB_DEV_PORT)]
          : []),
      ],
      secureCookies: e.APP_URL.startsWith("https://") || e.NODE_ENV === "production",
      signUp: e.SIGNUP_MODE,
      inviteMatches: (token, email) => inviteMatches(container().deps, token, email),
      sendPasswordReset: async ({ email, name, url }) => {
        // Only called for addresses that have an account; the HTTP answer is the same either way.
        await container().mailer.send(passwordResetEmail({ to: email, name, url }));
        await recordSecurityEvent(
          container().deps,
          { action: "auth.password_reset_requested", userId: "", email },
          { requestId: requestContext()?.requestId ?? "reset", ip: null, userAgent: null },
        ).catch((err: unknown) => {
          log.error("audit write failed", { component: "auth", err });
        });
      },
      onPasswordReset: async ({ id, email }) => {
        await recordSecurityEvent(
          container().deps,
          { action: "auth.password_reset", userId: id, email, meta: { otherSessionsRevoked: true } },
          { requestId: requestContext()?.requestId ?? "reset", ip: null, userAgent: null },
        );
      },
      onUserCreated: async (user) => {
        const req = { requestId: requestContext()?.requestId ?? "sign-up", ip: null, userAgent: null };
        if (user.inviteToken !== undefined) {
          // In invite mode the token was already checked; in open mode an invalid/expired token is simply ignored.
          await redeemInvite(
            container().deps,
            { token: user.inviteToken, userId: user.id, email: user.email },
            req,
          ).catch((err: unknown) => {
            log.warn("invite not redeemed at sign-up", { component: "auth", userId: user.id, err });
          });
        }
        try {
          await provisionSignUp(
            container().deps,
            { kind: "system", name: "sign-up" },
            { userId: user.id, email: user.email, name: user.name },
            { requestId: requestContext()?.requestId ?? "sign-up", ip: null, userAgent: null },
          );
        } catch (err) {
          // The console user exists; the account can be provisioned again on retry (idempotent).
          log.error("sign-up provisioning failed", { component: "auth", userId: user.id, err });
        }
      },
    });
  }
  return instance;
}
