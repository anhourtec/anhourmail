// SPDX-License-Identifier: MIT
import { log } from "./log";

/**
 * Health building blocks (CLAUDE.md rule 13). Liveness touches nothing; readiness runs `probe()` per
 * dependency. Payloads are public: statuses and latencies only — no hostnames, versions of dependencies,
 * error text or stacks.
 */

export type DependencyCheck = { ok: boolean; latencyMs: number };

/** GIT_SHA when the build sets it, else the given fallback (the app's package.json version). */
export function appVersion(fallback: string): string {
  const sha = process.env.GIT_SHA?.trim();
  return sha && /^[0-9a-zA-Z._-]{1,64}$/.test(sha) ? sha : fallback;
}

export function liveness(version: string) {
  return { status: "ok" as const, uptimeSeconds: Math.round(process.uptime()), version: appVersion(version) };
}

/** Runs a probe with a timeout. Never throws; failures are logged and reported as ok: false. */
export async function probe(name: string, timeoutMs: number, fn: () => Promise<unknown>): Promise<DependencyCheck> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = fn();
  // A late rejection after the timeout must not become an unhandled rejection.
  call.catch(() => undefined);
  try {
    await Promise.race([
      call,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${name} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    log.warn("readiness check failed", { component: "health", dependency: name, err });
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}
