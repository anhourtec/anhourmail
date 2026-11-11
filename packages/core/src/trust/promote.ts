// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The hourly promotion run (`job:trust-promote`, ADR-0034 §2): established accounts in good standing move from `new` to
 * `standard` (source `automatic`). The thresholds come from configuration set in the ops repository, never from the
 * code or the public docs (rules 33, 44). Each account is promoted in its own unit of work under its lock, checked
 * again there, and audited `trust.tier_changed` by the system in that same unit of work; one account failing never
 * stops the others. Promotion sends no email.
 */
import { recordSystemChanges } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import { promoteEstablished } from "./service";

const SYSTEM = { kind: "system", name: "trust-promote" } as const;
const HOUR_MS = 3_600_000;

export type TrustPromoteSettings = {
  /** Accounts younger than this aren't promoted, and held sends in this window count against them. */
  minAgeHours: number;
  /** Accounts with this many held sends or more in the window are skipped. */
  maxHeld: number;
  /** Most accounts promoted in one run. */
  batch: number;
};

export type TrustPromoteRun = {
  candidates: number;
  promoted: number;
  /** Listed, but no longer qualified under the lock (suspended, restricted, staff-set or billing blocked meanwhile). */
  skipped: number;
  failed: number;
};

/** Promotes up to `batch` established accounts (see the module comment). */
export async function runTrustPromotion(deps: Deps, settings: TrustPromoteSettings): Promise<TrustPromoteRun> {
  const now = deps.clock.now();
  const since = new Date(now.getTime() - settings.minAgeHours * HOUR_MS);
  const criteria = { createdBefore: since, heldSince: since, maxHeld: settings.maxHeld };
  const candidates = await deps.uow.run((r) => r.trust.promotionCandidates({ ...criteria, limit: settings.batch }));
  const run: TrustPromoteRun = { candidates: candidates.length, promoted: 0, skipped: 0, failed: 0 };
  for (const { accountId } of candidates) {
    const req: RequestMeta = { requestId: `trust-promote-${accountId}`, ip: null, userAgent: null };
    try {
      const promoted = await deps.uow.run(async (r) => {
        const changes = await promoteEstablished(deps, r, accountId, criteria);
        await recordSystemChanges(deps, r, SYSTEM, req, changes);
        return changes.length > 0;
      });
      if (promoted) run.promoted += 1;
      else run.skipped += 1;
    } catch {
      // Rolled back with its audit entry; the next run tries again. The job logs the counts.
      run.failed += 1;
    }
  }
  return run;
}
