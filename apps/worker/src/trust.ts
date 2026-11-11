// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Settings for the trust promotion job (`job:trust-promote`, ADR-0034 §2). The thresholds are private: production
 * values live in the ops repository's environment, never in this repository or the public docs (rules 33, 44), and
 * `.env.example` carries obvious development values only. Production refuses to start the scheduler without all
 * three; elsewhere, all three unset means the job does nothing. Problems name settings only, never values.
 */
import type { TrustPromoteSettings } from "@anhourmail/core/trust";

const KEYS = {
  minAgeHours: { name: "TRUST_PROMOTE_MIN_AGE_HOURS", max: 24 * 366 },
  maxHeld: { name: "TRUST_PROMOTE_MAX_HELD", max: 100_000 },
  batch: { name: "TRUST_PROMOTE_BATCH", max: 10_000 },
} as const;

const present = (v: string | undefined) => v !== undefined && v.trim() !== "";

/** The settings, or null when none is set outside production; every problem found, by setting name. */
export function trustPromoteSettings(env: Record<string, string | undefined> = process.env): {
  settings: TrustPromoteSettings | null;
  problems: string[];
} {
  const production = env.NODE_ENV === "production";
  const entries = Object.entries(KEYS) as [keyof TrustPromoteSettings, (typeof KEYS)[keyof typeof KEYS]][];
  if (!production && entries.every(([, k]) => !present(env[k.name]))) return { settings: null, problems: [] };
  const problems: string[] = [];
  const out: Partial<TrustPromoteSettings> = {};
  for (const [field, { name, max }] of entries) {
    const raw = env[name];
    if (!present(raw)) {
      problems.push(
        `${name} must be set${production ? " in production" : " (with the other TRUST_PROMOTE_* settings)"}`,
      );
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) {
      problems.push(`${name} must be a whole number from 1 to ${String(max)}`);
      continue;
    }
    out[field] = n;
  }
  if (problems.length > 0 || out.minAgeHours === undefined || out.maxHeld === undefined || out.batch === undefined) {
    return { settings: null, problems };
  }
  return { settings: { minAgeHours: out.minAgeHours, maxHeld: out.maxHeld, batch: out.batch }, problems };
}

/** Refuses to start (throws, naming settings only) when the settings are wrong; null when unset outside production. */
export function checkTrustPromoteSettings(
  env: Record<string, string | undefined> = process.env,
): TrustPromoteSettings | null {
  const { settings, problems } = trustPromoteSettings(env);
  if (problems.length > 0) throw new Error(`Worker configuration refused: ${problems.join("; ")}`);
  return settings;
}
