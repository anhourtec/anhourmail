// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recovery codes for console two-factor sign-in (docs/internal/07-security.md "Sign-in factors").
 *
 * - 10 codes of 16 characters from a 32-letter alphabet without look-alikes (80 bits each), shown once as
 *   `ABCD-EFGH-JKLM-NPQR`.
 * - Stored only as SHA-256 hashes (`h1:<base64url>`): a code is a high-entropy random token, not a password, so a slow
 *   hash adds nothing (same rule as invite and reset tokens). better-auth's two-factor plugin keeps them in
 *   `auth_two_factor.backup_codes`; we plug in through its `storeBackupCodes` hooks, and hash the code someone types
 *   before the plugin compares (`hashRecoveryCode`), so the plugin only ever compares hashes.
 */
import { createHash, randomBytes } from "node:crypto";

import { RECOVERY_CODES } from "@anhourmail/shared/security";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PREFIX = "h1:";

/** One code: 16 characters in four groups. 32 divides 256, so `byte & 31` picks each letter without bias. */
export function newRecoveryCode(): string {
  const chars = [...randomBytes(16)].map((b) => ALPHABET[b & 31] ?? "A").join("");
  return chars.match(/.{4}/g)?.join("-") ?? chars;
}

export function newRecoveryCodes(count: number = RECOVERY_CODES.count): string[] {
  return Array.from({ length: count }, newRecoveryCode);
}

/** What people type: any case, with or without dashes or spaces. */
export const normaliseRecoveryCode = (input: string): string => input.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The stored form of a code someone typed. Always hashes: a stored hash typed back in hashes to something else, so
 * reading the database never yields a usable code. (`isRecoveryCodeInput` refuses such input earlier.)
 */
export function hashRecoveryCode(code: string): string {
  return PREFIX + createHash("sha256").update(normaliseRecoveryCode(code)).digest("base64url");
}

/** Typed input that could be a recovery code: never anything that looks like a stored value (it has a colon). */
export const isRecoveryCodeInput = (code: string): boolean => !code.includes(":");

/**
 * better-auth `backupCodeOptions.storeBackupCodes`: the plugin hands us `JSON.stringify(codes)` to store (fresh codes
 * at generation, or the remaining hashes after one is used) and parses what `decrypt` returns. We store and return
 * hashes only.
 */
export const hashedBackupCodeStore = {
  encrypt: async (json: string): Promise<string> => {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error("recovery codes must be a list");
    // Fresh codes are hashed; the remaining hashes the plugin hands back after a code is used pass through. This is
    // the only place a stored value is accepted as-is.
    return JSON.stringify(parsed.map((c) => (String(c).startsWith(PREFIX) ? String(c) : hashRecoveryCode(String(c)))));
  },
  decrypt: async (stored: string): Promise<string> => stored,
};

/** Unused codes in a stored value (0 for anything unreadable). */
export function recoveryCodesLeft(stored: string): number {
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string" && c.startsWith(PREFIX)).length : 0;
  } catch {
    return 0;
  }
}
