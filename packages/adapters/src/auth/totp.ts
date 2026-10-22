// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RFC 6238 time-based codes (HMAC-SHA1, 6 digits, 30-second steps — what better-auth's two-factor plugin issues).
 * Used where we check a code ourselves (turning two-factor sign-in off needs the current code); sign-in itself is
 * checked by the plugin.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { TOTP } from "@anhourmail/shared/security";

export function totpAt(key: Buffer, counter: number, digits: number = TOTP.digits): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Claims a code for a person, atomically: true only for the first caller in its lifetime (e.g. Redis `SET … NX PX`).
 * Errors propagate, so a store failure refuses the code (fail closed).
 */
export type CodeClaim = (userId: string, code: string) => Promise<boolean>;

/**
 * One-time authenticator codes: `ok` only for the single request that both presents a valid code and wins its claim;
 * a valid code that was already claimed is `reused`; anything else is `invalid` (nothing is claimed).
 */
export async function claimTotp(
  secret: string,
  userId: string,
  code: string,
  claim: CodeClaim,
  now: number = Date.now(),
): Promise<"ok" | "reused" | "invalid"> {
  const input = code.replace(/\s/g, "");
  if (!verifyTotp(secret, input, now)) return "invalid";
  return (await claim(userId, input)) ? "ok" : "reused";
}

/**
 * True when `code` matches the step at `now` or one step either side (clock drift). Constant time per candidate.
 * `secret` is the plugin's secret string (its UTF-8 bytes are the HMAC key).
 */
export function verifyTotp(secret: string, code: string, now: number = Date.now()): boolean {
  const input = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(input)) return false;
  const key = Buffer.from(secret, "utf8");
  const counter = Math.floor(now / 1000 / TOTP.periodSeconds);
  let ok = false;
  for (const step of [-1, 0, 1]) {
    const expected = Buffer.from(totpAt(key, counter + step));
    ok = timingSafeEqual(expected, Buffer.from(input)) || ok;
  }
  return ok;
}
