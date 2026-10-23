// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { breachedPasswordsOff, pwnedPasswords } from "@anhourmail/adapters/breached-passwords";
import { memoryBreachedPasswords } from "@anhourmail/adapters/memory";
import type { BreachedPasswords } from "@anhourmail/core/security";
import { log } from "@anhourmail/server/log";

/**
 * The breached-password check for `BREACHED_PASSWORD_CHECK` (env.ts `breachedPasswordMode`): `on` asks the range API
 * from this server (the web container needs HTTPS egress to it; without it every check fails open with a warning),
 * `fake` answers from a fixed list (dev and CI, no network), `off` accepts every password.
 */
export function breachedPasswords(mode: "on" | "off" | "fake"): BreachedPasswords {
  if (mode === "off") return breachedPasswordsOff;
  if (mode === "fake") return memoryBreachedPasswords();
  return pwnedPasswords({ log });
}
