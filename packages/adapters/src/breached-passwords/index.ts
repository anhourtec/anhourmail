// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Breached-password check against the Pwned Passwords range API (core `BreachedPasswords`; docs/internal/07-security.md
 * "Breached-password check"). k-anonymity: the password is hashed with SHA-1 here, only the first five hex characters
 * of the hash are sent (`GET /range/<prefix>`), and the ~800–1,000 suffixes that come back are compared locally. The
 * `Add-Padding` header makes every answer a similar size, so the response length says nothing about the prefix either.
 *
 * Server-side only: the browser never calls it (no third-party requests from the console or webmail). Fails open: any
 * network error, timeout, non-200 answer or malformed body → `unknown`, with a warning that carries only the reason
 * (never the password, the hash or the prefix). Nothing is cached.
 */
import { createHash } from "node:crypto";

import { BREACHED_PASSWORD } from "@anhourmail/shared/security";
import type { BreachedPasswords, BreachVerdict } from "@anhourmail/core/security";

export const PWNED_PASSWORDS_RANGE_URL = "https://api.pwnedpasswords.com/range/";

/** The service's padded answers are well under 64 KiB; anything far larger is not an answer we trust. */
const MAX_BODY_BYTES = 256 * 1024;

export type WarnLogger = { warn(msg: string, ctx?: Record<string, unknown>): void };

export type PwnedPasswordsOptions = {
  /** Injected in tests; the platform `fetch` otherwise. */
  fetch?: typeof fetch;
  /** Give up after this long (default 2 s) and answer `unknown`. */
  timeoutMs?: number;
  /** Where the fail-open warning goes. */
  log: WarnLogger;
  /** Clock for the warning's duration (tests). */
  now?: () => number;
};

/** SHA-1 of the password (UTF-8), upper-case hex, split into the 5-character prefix sent and the suffix kept. */
export function rangeParts(password: string): { prefix: string; suffix: string } {
  const hex = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

/**
 * The breach count for `suffix` in a range answer (`SUFFIX:COUNT` lines; padding lines have count 0), 0 when absent,
 * or null when the body isn't a range answer at all.
 */
export function countInRange(body: string, suffix: string): number | null {
  let seenLine = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^([0-9A-F]{35}):(\d{1,12})$/i.exec(line);
    if (!m) return null;
    seenLine = true;
    if (m[1]?.toUpperCase() === suffix) return Number(m[2]);
  }
  return seenLine ? 0 : null;
}

export function pwnedPasswords(opts: PwnedPasswordsOptions): BreachedPasswords {
  const go = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? BREACHED_PASSWORD.timeoutMs;
  const now = opts.now ?? (() => performance.now());
  const unknown = (reason: string, started: number, extra: Record<string, unknown> = {}): BreachVerdict => {
    opts.log.warn("breached-password check unavailable; password accepted", {
      component: "breached-passwords",
      reason,
      durationMs: Math.round(now() - started),
      ...extra,
    });
    return "unknown";
  };

  return {
    async check(password) {
      const started = now();
      const { prefix, suffix } = rangeParts(password);
      try {
        const res = await go(`${PWNED_PASSWORDS_RANGE_URL}${prefix}`, {
          method: "GET",
          headers: { "Add-Padding": "true", "User-Agent": "AnhourMail", Accept: "text/plain" },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => undefined);
          return unknown("status", started, { status: res.status });
        }
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (declared > MAX_BODY_BYTES) {
          await res.body?.cancel().catch(() => undefined);
          return unknown("too_large", started);
        }
        const body = await res.text();
        if (body.length > MAX_BODY_BYTES) return unknown("too_large", started);
        const count = countInRange(body, suffix);
        if (count === null) return unknown("malformed", started);
        return count > 0 ? "breached" : "clean";
      } catch (err) {
        const name = err instanceof Error ? err.name : "unknown";
        return unknown(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", started, {
          errorName: name,
        });
      }
    },
  };
}

/** The check turned off (`BREACHED_PASSWORD_CHECK=off`): every password is `unknown`, so none is refused. */
export const breachedPasswordsOff: BreachedPasswords = { check: () => Promise.resolve("unknown") };
