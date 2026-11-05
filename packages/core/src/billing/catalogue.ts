// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The provider's catalogue against our plan facts (ADR-0029 §2). `plans.ts` is the one source of every price (rule 32):
 * the provider must match it, never the reverse. The worker checks at start and daily (`job:billing-catalogue`) and
 * records the result; while it disagrees, new checkouts and plan or add-on changes are refused with
 * `503 billing_unavailable` (audited denied `catalogue_drift`), so nobody is charged a price we don't publish.
 * Existing subscriptions keep syncing, cancelling and refunding. The drift is audited in the platform log when it
 * appears or changes, and when it is fixed; Platform billing shows it.
 */
import type { Actor } from "../actor";
import { recordSystemChanges } from "../mutation";
import type { MutationSpec } from "../mutation";
import type { Deps, RequestMeta } from "../ports";

import type { CatalogueStatus } from "./entity";
import { refuse, unavailable } from "./guards";
import type { BillingProvider, CatalogueDrift } from "./ports";

const CHECKER = { kind: "system", name: "billing-catalogue" } as const;

const key = (d: CatalogueDrift) => `${d.item}\u0000${d.problem}`;
const sameDrift = (a: readonly CatalogueDrift[], b: readonly CatalogueDrift[]) =>
  a.length === b.length && a.map(key).sort().join("\n") === b.map(key).sort().join("\n");

export type CatalogueCheck = {
  drift: CatalogueDrift[];
  /** `drift`: new or different drift (audited); `restored`: back in sync (audited); `same`: nothing changed. */
  change: "drift" | "restored" | "same";
  driftSince: Date | null;
};

/**
 * Checks the provider's catalogue and records the result (`job:billing-catalogue`). A provider outage throws before
 * anything is written: the last recorded result stands until the next check. Audits only changes, so a daily run of the
 * same drift doesn't pile up entries (the worker logs it every run).
 */
export async function checkBillingCatalogue(deps: Deps, provider: BillingProvider): Promise<CatalogueCheck> {
  const drift = [...(await provider.checkCatalogue())];
  const now = deps.clock.now();
  const req: RequestMeta = { requestId: `billing-catalogue-${String(now.getTime())}`, ip: null, userAgent: null };
  return deps.uow.run(async (r) => {
    const previous = await r.billing.catalogue();
    const before = previous?.drift ?? [];
    const driftSince = drift.length === 0 ? null : before.length > 0 ? (previous?.driftSince ?? now) : now;
    await r.billing.saveCatalogue({ checkedAt: now, drift, driftSince });
    const target = { type: "billing_catalogue", id: null };
    if (drift.length > 0 && !sameDrift(drift, before)) {
      await recordSystemChanges(deps, r, CHECKER, req, [
        { action: "billing.catalogue_drift", accountId: null, target, meta: { drift, provider: provider.kind } },
      ]);
      return { drift, change: "drift", driftSince };
    }
    if (drift.length === 0 && before.length > 0) {
      await recordSystemChanges(deps, r, CHECKER, req, [
        {
          action: "billing.catalogue_restored",
          accountId: null,
          target,
          meta: { driftSince: previous?.driftSince?.toISOString() ?? null, provider: provider.kind },
        },
      ]);
      return { drift, change: "restored", driftSince };
    }
    return { drift, change: "same", driftSince };
  });
}

/** The last recorded catalogue check, or null before the first (staff: Platform billing). */
export async function catalogueStatus(deps: Deps): Promise<CatalogueStatus | null> {
  return deps.uow.run((r) => r.billing.catalogue());
}

/** Whether the last check found drift (never checked counts as in sync: the worker checks at start). */
async function drifted(deps: Deps): Promise<boolean> {
  return ((await catalogueStatus(deps))?.drift.length ?? 0) > 0;
}

/**
 * New checkouts and plan or add-on changes need the catalogue in sync: otherwise 503 `billing_unavailable`, audited as
 * denied `catalogue_drift` in the account's log (the person sees only that payments aren't available right now).
 */
export async function requireCatalogueInSync(
  deps: Deps,
  actor: Actor,
  req: RequestMeta,
  spec: MutationSpec,
): Promise<void> {
  if (await drifted(deps)) await refuse(deps, actor, req, spec, "catalogue_drift", unavailable());
}

/** The same for a preview, which writes nothing (no audit): 503 `billing_unavailable`. */
export async function assertCatalogueInSync(deps: Deps): Promise<void> {
  if (await drifted(deps)) throw unavailable();
}
