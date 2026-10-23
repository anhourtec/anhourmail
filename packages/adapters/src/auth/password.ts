// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console password hashing: argon2id with a random 16-byte salt per hash, at the OWASP Password Storage
 * Cheat Sheet baseline (m = 19 MiB, t = 2, p = 1). The PHC string stores algorithm, parameters and salt, so
 * parameters can be raised later and `needsRehash` tells sign-in to upgrade old hashes.
 * Mailbox passwords are Stalwart's (docs/internal/07-security.md "Password storage").
 */
import { hash, verify } from "@node-rs/argon2";

/** The library default algorithm is argon2id (asserted by the PHC prefix in password.test.ts). */
export const ARGON2_PARAMS = {
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

/** Constant-time verification; false for malformed or non-argon2id hashes (never throws on bad input). */
export async function verifyPassword(input: { password: string; hash: string }): Promise<boolean> {
  if (!input.hash.startsWith("$argon2id$")) return false;
  try {
    return await verify(input.hash, input.password);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than ARGON2_PARAMS (rehash on next successful sign-in). */
export function needsRehash(stored: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!m) return true;
  return Number(m[1]) < ARGON2_PARAMS.memoryCost || Number(m[2]) < ARGON2_PARAMS.timeCost;
}

/**
 * Mailbox passwords (core `PasswordHasher`): the same argon2id parameters, as the PHC string Stalwart is given (it
 * verifies it itself; we never keep it once the worker has applied it — 07-security.md "Password storage").
 */
export const mailboxPasswordHasher = { hash: hashPassword } as const;
