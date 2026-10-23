// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";

import { type Auth, type AuthSecurityEvent, createAuth, type SecurityHooks } from "@anhourmail/adapters/auth";
import { db } from "@anhourmail/adapters/postgres";
import { provisionSignUp } from "@anhourmail/core/account";
import {
  afterPasswordChange,
  factorRemovalRefusal,
  noteFactorAdded,
  recordSecurityEvent,
  sessionRefusalFor,
} from "@anhourmail/core/security";
import { keyRingFromEnv } from "@anhourmail/server/keyring";
import { log } from "@anhourmail/server/log";
import { redisOneTime } from "@anhourmail/server/one-time";
import { redis } from "@anhourmail/server/redis";
import { requestContext } from "@anhourmail/server/request-context";
import { EMAIL_VERIFICATION_HOURS } from "@anhourmail/shared/security";

import { container } from "../container";

import { env } from "../env";
import { emailVerificationEmail, firstFactorEmail, passkeyAddedEmail, passwordResetEmail } from "../mail/system-email";
import { platform } from "../platform";

/**
 * Sign-up mode: `open` (anyone who can reach the console; production keeps it behind the firewall allow-list) or
 * `closed` (no sign-up page).
 */
export const signUpOpen = (): boolean => env().SIGNUP_MODE === "open";

/** Where the "confirm your email address" link lands (better-auth appends `?error=<code>` when it fails). */
export const EMAIL_VERIFIED_PATH = "/email-verified";

/** Dev: the machine's LAN IPv4 addresses, so the console works from other devices (DEV_HOST=0.0.0.0). */
export function lanOrigins(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i?.family === "IPv4" && !i.internal)
    .map((i) => `http://${i?.address ?? ""}:${port}`);
}

/** An authenticator code is accepted once: claimed (hashed with the person's id) for the rest of its validity window. */
const USED_CODE_TTL_SEC = 120;
const usedCodeKey = (userId: string, code: string) =>
  `am:totp-used:${createHash("sha256").update(`${userId}:${code}`).digest("base64url")}`;

/** Audits identity events (sign-ins, second steps, factor changes). An audit failure is logged, never shown. */
async function auditAuthEvent(e: AuthSecurityEvent): Promise<void> {
  const ctx = requestContext();
  await recordSecurityEvent(
    container().deps,
    {
      action: e.action,
      userId: e.userId,
      email: e.email,
      by: e.by,
      ...(e.denied ? { denied: e.denied } : {}),
      ...(e.meta ? { meta: e.meta } : {}),
    },
    { requestId: ctx?.requestId ?? "auth", ip: ctx?.clientIp ?? null, userAgent: e.userAgent },
  ).catch((err: unknown) => {
    log.error("audit write failed", { component: "auth", action: e.action, err });
  });
  // A new passkey can sign in on its own: tell the person, in case it wasn't them.
  if (e.action === "auth.passkey_added" && !e.denied && e.email) {
    const name = typeof e.meta?.passkeyName === "string" ? e.meta.passkeyName : "Passkey";
    await container()
      .mailer.send(
        passkeyAddedEmail({
          to: e.email,
          passkeyName: name,
          at: new Date(),
          securityUrl: `${env().APP_URL}/security`,
          site: platform().hosts.site,
        }),
      )
      .catch((err: unknown) => {
        log.error("passkey notice email failed", { component: "auth", err });
      });
  }
}

/** Checks and auditing around console sign-in factors (packages/adapters/src/auth/security-plugin.ts). */
export const securityHooks: SecurityHooks = {
  onEvent: auditAuthEvent,
  removalRefusal: (userId, factor) => container().deps.uow.run((r) => factorRemovalRefusal(r, userId, factor)),
  // One atomic SET NX per code: of concurrent requests with the same code, only one may accept it. Redis errors
  // propagate, so the second step fails closed, like the `auth` rate-limit tier.
  codes: { claim: (userId, code) => redisOneTime(redis())(usedCodeKey(userId, code), USED_CODE_TTL_SEC * 1000) },
  factors: (userId) => container().deps.uow.run((r) => r.security.factors(userId)),
  factorAdded: async (e) => {
    const ctx = requestContext();
    try {
      const { notify } = await noteFactorAdded(
        container().deps,
        { userId: e.userId, email: e.email, factor: e.factor, firstFactor: e.firstFactor },
        { requestId: ctx?.requestId ?? "auth", ip: ctx?.clientIp ?? null, userAgent: e.userAgent },
      );
      for (const n of notify) {
        // One failed send never stops the others; log only the error's name (no addresses).
        await container()
          .mailer.send(
            firstFactorEmail({
              to: n.email,
              person: e.email,
              accountName: n.accountName,
              factor: e.factor,
              at: new Date(),
              securityUrl: `${env().APP_URL}/security`,
              forOwner: n.owner,
              site: platform().hosts.site,
            }),
          )
          .catch((err: unknown) => {
            log.error("first factor notice send failed", {
              component: "auth",
              errorName: err instanceof Error ? err.name : "unknown",
            });
          });
      }
    } catch (err) {
      log.error("first factor notice failed", { component: "auth", err });
    }
  },
  sessionRefusal: (userId, method) => container().deps.uow.run((r) => sessionRefusalFor(r, userId, method)),
  passwordChanged: async (e) => {
    const ctx = requestContext();
    await afterPasswordChange(
      container().deps,
      {
        userId: e.userId,
        email: e.email,
        via: e.via,
        keepSessionId: e.keepSessionId,
        removePasskeys: e.removePasskeys,
      },
      { requestId: ctx?.requestId ?? "auth", ip: ctx?.clientIp ?? null, userAgent: e.userAgent },
    ).catch((err: unknown) => {
      log.error("password change follow-up failed", { component: "auth", via: e.via, err });
    });
  },
};

let instance: Auth | null = null;

export function auth(): Auth {
  if (!instance) {
    const e = env();
    const dev = e.NODE_ENV !== "production";
    const consoleUrl = new URL(e.APP_URL);
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
      sealer: keyRingFromEnv({
        spec: e.SECRETS_KEYRING,
        production: e.NODE_ENV === "production",
        devFallbackSecret: e.BETTER_AUTH_SECRET,
      }),
      // Passkeys belong to the console origin only (APP_URL): `app.anhourmail.com`, `localhost` in development.
      relyingParty: { id: consoleUrl.hostname, name: "AnhourMail", origin: consoleUrl.origin },
      trustProxy: e.TRUST_PROXY === "true",
      security: securityHooks,
      sendPasswordReset: async ({ email, name, url }) => {
        // Only called for addresses that have an account, so a delivery failure must not change the HTTP answer
        // (a 5xx only for real accounts would reveal them): log it and carry on.
        await container()
          .mailer.send(passwordResetEmail({ to: email, name, url, site: platform().hosts.site }))
          .catch((err: unknown) => {
            log.error("password reset email failed", { component: "auth", err });
          });
        await recordSecurityEvent(
          container().deps,
          { action: "auth.password_reset_requested", userId: "", email },
          // The request's client address (TRUST_PROXY rules, `route()`), for staff watching for abuse; no user agent.
          {
            requestId: requestContext()?.requestId ?? "reset",
            ip: requestContext()?.clientIp ?? null,
            userAgent: null,
          },
        ).catch((err: unknown) => {
          log.error("audit write failed", { component: "auth", err });
        });
      },
      emailVerification: {
        expiresInSec: EMAIL_VERIFICATION_HOURS * 3600,
        // At sign-up and from the console's "send the link again". The link is ours: the auth endpoint on this
        // origin, landing on a fixed page (never a URL from the request). Delivery failures are logged, not shown.
        send: async ({ email, token }) => {
          const url = `${e.APP_URL.replace(/\/$/, "")}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(EMAIL_VERIFIED_PATH)}`;
          await container()
            .mailer.send(
              emailVerificationEmail({
                to: email,
                url,
                hours: EMAIL_VERIFICATION_HOURS,
                site: platform().hosts.site,
              }),
            )
            .catch((err: unknown) => {
              log.error("email confirmation send failed", { component: "auth", err });
            });
          await recordSecurityEvent(
            container().deps,
            { action: "auth.email_verification_sent", userId: null, email },
            {
              requestId: requestContext()?.requestId ?? "verify",
              ip: requestContext()?.clientIp ?? null,
              userAgent: null,
            },
          ).catch((err: unknown) => {
            log.error("audit write failed", { component: "auth", err });
          });
        },
        onVerified: async (user) => {
          await recordSecurityEvent(
            container().deps,
            { action: "auth.email_verified", userId: user.id, email: user.email },
            {
              requestId: requestContext()?.requestId ?? "verify",
              ip: requestContext()?.clientIp ?? null,
              userAgent: null,
            },
          ).catch((err: unknown) => {
            log.error("audit write failed", { component: "auth", err });
          });
        },
      },
      onUserCreated: async (user) => {
        try {
          await provisionSignUp(
            container().deps,
            { kind: "system", name: "sign-up" },
            { userId: user.id, email: user.email, name: user.name },
            // Where the sign-up came from (platform log, full address for staff watching open sign-ups); no user agent.
            {
              requestId: requestContext()?.requestId ?? "sign-up",
              ip: requestContext()?.clientIp ?? null,
              userAgent: null,
            },
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
