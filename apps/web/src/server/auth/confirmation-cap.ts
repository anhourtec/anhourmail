// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { checkRateLimit, type Counter, LIMITS } from "@anhourmail/server/rate-limit";

/**
 * Whether another confirmation email may go to `email` now (`emailVerificationAddress`: a few a day per address,
 * however they're asked for). Someone who signed up with another person's address knows its password, and every
 * sign-in with it sends a fresh link: without this cap they could flood that inbox. Keyed by a hash of the address;
 * fails closed (no counter or a counter that's down → nothing is sent).
 */
export async function confirmationEmailAllowed(
  counter: Counter,
  email: string,
  now = Date.now(),
): Promise<"allowed" | "address_daily_cap" | "limiter_unavailable"> {
  const who = createHash("sha256").update(email.trim().toLowerCase()).digest("base64url").slice(0, 22);
  const cap = await checkRateLimit(
    counter,
    "emailVerificationAddress",
    LIMITS.emailVerificationAddress,
    `addr:${who}`,
    now,
  );
  if (cap.degraded) return "limiter_unavailable";
  return cap.allowed ? "allowed" : "address_daily_cap";
}
