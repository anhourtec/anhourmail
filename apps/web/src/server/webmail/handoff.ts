// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { db, pgMailboxStatusLookup } from "@anhourmail/adapters/postgres";
import {
  type HandoffAccess,
  type HandoffCodeStore,
  type HandoffGrant,
  isHandoffToken,
  webmailAccess,
} from "@anhourmail/core/webmail";
import { redis } from "@anhourmail/server/redis";
import { WEBMAIL_HANDOFF } from "@anhourmail/shared/webmail";

import { env } from "../env";

/**
 * Wiring for the console → webmail handoff (ADR-0024; the rules are in `@anhourmail/core/webmail` `handoff.ts`).
 *
 * - Codes live in Redis under the SHA-256 of the code for 60 s and are taken with `GETDEL`, so a code works once even
 *   when two requests race. A Redis failure refuses the handoff (fail closed); the sign-in page still works.
 * - The verifier is a cookie of the webmail origin: HttpOnly, `SameSite=Strict`, two minutes, `__Host-` on https. It
 *   is set when the console link arrives (`GET /api/webmail/handoff`) and read and cleared by the redemption.
 */

const KEY = "am:wm:handoff:";

export function redisHandoffCodes(): HandoffCodeStore {
  return {
    async put(key, grant, ttlSec) {
      await redis().set(`${KEY}${key}`, JSON.stringify(grant), "EX", ttlSec);
    },
    async take(key) {
      const raw = await redis().getdel(`${KEY}${key}`);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as HandoffGrant;
      } catch {
        return null;
      }
    },
  };
}

/** The webmail access gate's answer without its cache: the handoff decides on the state right now. */
export function handoffAccess(): HandoffAccess {
  const lookup = pgMailboxStatusLookup(db());
  return { state: async (address) => webmailAccess(await lookup(address)) };
}

const secure = () => env().WEBMAIL_URL.startsWith("https://");

/** `__Host-am.handoff` on https; `am.handoff` in dev (http, where `__Host-` cookies can't be set). */
export const handoffCookieName = (): string => (secure() ? "__Host-am.handoff" : "am.handoff");

/** Sets (or, with `null`, clears) the verifier cookie. */
export function handoffCookie(verifier: string | null): string {
  return [
    `${handoffCookieName()}=${verifier ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${String(verifier === null ? 0 : WEBMAIL_HANDOFF.verifierSec)}`,
    ...(secure() ? ["Secure"] : []),
  ].join("; ");
}

/** The verifier from a Cookie header, or null. */
export function handoffVerifier(cookieHeader: string | null): string | null {
  const name = handoffCookieName().replace(/[.]/g, "\\.");
  const v = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader ?? "")?.[1] ?? null;
  return isHandoffToken(v) ? v : null;
}
