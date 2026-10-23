// SPDX-License-Identifier: AGPL-3.0-only
import { BREACHED_PASSWORD } from "@anhourmail/shared/security";

import { DomainError } from "../errors";

/**
 * Breached-password check (docs/internal/07-security.md "Breached-password check"): is this password in the public
 * corpus of passwords seen in data breaches? The adapter asks the range API with k-anonymity (only the first five hex
 * characters of the SHA-1 hash leave the server; the suffixes are compared here). The memory fake answers from a list.
 *
 * `unknown`: the service couldn't be asked (unreachable, slow, odd answer, or the check is turned off). The check
 * fails open — the password is accepted — because it is advice on top of the length rules, and an outage of a third
 * party must not stop people from signing up or changing a password. Adapters never throw; they log the reason (never
 * the password, its hash or the prefix) and answer `unknown`.
 */
export type BreachVerdict = "breached" | "clean" | "unknown";

export type BreachedPasswords = {
  check(password: string): Promise<BreachVerdict>;
};

/** A password found in the breached-password corpus (HTTP 400 `password_breached`). */
export class BreachedPasswordError extends DomainError {
  constructor() {
    super(BREACHED_PASSWORD.message, BREACHED_PASSWORD.code);
  }
}

/** Longest input worth asking about (anything longer is refused by the length rules first). */
const MAX_CHECKED = 1024;

/**
 * True only when `check` says the password is breached. No check configured, a non-string or empty value, or an answer
 * of `unknown` (including a check that throws despite its contract) → false: fail open.
 */
export async function passwordBreached(check: BreachedPasswords | undefined, password: unknown): Promise<boolean> {
  if (!check || typeof password !== "string" || password === "" || password.length > MAX_CHECKED) return false;
  try {
    return (await check.check(password)) === "breached";
  } catch {
    return false;
  }
}

/** Throws `BreachedPasswordError` when `check` finds the password in the corpus (see `passwordBreached`). */
export async function assertNotBreached(check: BreachedPasswords | undefined, password: unknown): Promise<void> {
  if (await passwordBreached(check, password)) throw new BreachedPasswordError();
}
