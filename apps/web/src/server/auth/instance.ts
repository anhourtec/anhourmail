// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { networkInterfaces } from "node:os";

import { type Auth, createAuth } from "@anhourmail/adapters/auth";
import { db } from "@anhourmail/adapters/postgres";
import { provisionSignUp } from "@anhourmail/core/account";
import { recordSecurityEvent } from "@anhourmail/core/security";
import { log } from "@anhourmail/server/log";
import { requestContext } from "@anhourmail/server/request-context";

import { container } from "../container";

import { env } from "../env";
import { passwordResetEmail } from "../mail/system-email";

/**
 * Sign-up mode: `open` (anyone who can reach the console; production keeps it behind the firewall allow-list) or
 * `closed` (no sign-up page).
 */
export const signUpOpen = (): boolean => env().SIGNUP_MODE === "open";

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
      sendPasswordReset: async ({ email, name, url }) => {
        // Only called for addresses that have an account, so a delivery failure must not change the HTTP answer
        // (a 5xx only for real accounts would reveal them): log it and carry on.
        await container()
          .mailer.send(passwordResetEmail({ to: email, name, url }))
          .catch((err: unknown) => {
            log.error("password reset email failed", { component: "auth", err });
          });
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
