// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { pingDatabase } from "@anhourmail/adapters/postgres";
import { type DependencyCheck, liveness as baseLiveness, probe } from "@anhourmail/server/health";
import { redis } from "@anhourmail/server/redis";

import pkg from "../../package.json";
import { stalwartReady } from "./adapters/stalwart";

/**
 * Health endpoints (CLAUDE.md rule 13; docs/internal/01-architecture.md "Health"):
 * - liveness: the process answers. Touches nothing.
 * - readiness: Postgres, Redis and Stalwart answer within a short timeout. All three are critical — the
 *   console can't provision and the webmail can't load without Stalwart. Public payload: statuses and
 *   latencies only.
 */
export const liveness = () => baseLiveness(pkg.version);

export type Readiness = {
  status: "ok" | "unavailable";
  checks: { database: DependencyCheck; redis: DependencyCheck; mail: DependencyCheck };
};

let memo: { at: number; value: Readiness } | null = null;
const MEMO_MS = 2_000;

/** Readiness, memoised for 2 s so a burst of probes costs one round of checks. */
export async function readiness(): Promise<Readiness> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.value;
  const [database, cache, mail] = await Promise.all([
    probe("database", 2_000, pingDatabase),
    probe("redis", 1_000, () => redis().ping()),
    probe("stalwart", 2_000, stalwartReady),
  ]);
  const value: Readiness = {
    status: database.ok && cache.ok && mail.ok ? "ok" : "unavailable",
    checks: { database, redis: cache, mail },
  };
  memo = { at: Date.now(), value };
  return value;
}
