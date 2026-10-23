// SPDX-License-Identifier: AGPL-3.0-only
import type { BreachedPasswords, BreachVerdict } from "@anhourmail/core/security";

/**
 * Passwords the fake treats as breached by default. Each is also in the real corpus (they are among the most common
 * breached passwords), so a test that uses one passes the same way against the real service.
 */
export const KNOWN_BREACHED_PASSWORDS: readonly string[] = ["password1234", "correcthorsebatterystaple"];

export type MemoryBreachedPasswords = BreachedPasswords & {
  /** How many times `check` was asked (never the passwords themselves). */
  readonly calls: number;
  /** Simulate the service being down or slow: every answer becomes `unknown`. */
  unavailable: boolean;
};

/**
 * In-memory breached-password check (core `BreachedPasswords`) for unit tests and the dev/CI `fake` mode: `breached`
 * for the listed passwords, `clean` for everything else, `unknown` while `unavailable`. No network.
 */
export function memoryBreachedPasswords(
  breached: Iterable<string> = KNOWN_BREACHED_PASSWORDS,
  opts: { unavailable?: boolean } = {},
): MemoryBreachedPasswords {
  const list = new Set(breached);
  let calls = 0;
  const fake = {
    unavailable: opts.unavailable ?? false,
    get calls() {
      return calls;
    },
    check(password: string): Promise<BreachVerdict> {
      calls += 1;
      if (fake.unavailable) return Promise.resolve("unknown");
      return Promise.resolve(list.has(password) ? "breached" : "clean");
    },
  };
  return fake;
}
