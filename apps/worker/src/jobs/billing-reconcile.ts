// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Nightly billing reconcile (ADR-0029 §4): queues `billing.sync` for every account with a provider customer that hasn't
 * synced for a day (a lost webhook heals within a day), retries resolving dispute orphans through the provider, and
 * prunes processed events past their 35-day retention (orphans are kept for staff). Billing off: nothing to do.
 */
import { reconcileBilling } from "@anhourmail/core/billing";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const l = log.child({ component: "billing-reconcile" });
const { deps, billing, close } = runtime();
const provider = billing();
if (provider) {
  const run = await reconcileBilling(deps, provider);
  l.at(run.orphansLeft > 0 ? "warn" : "info", "billing reconcile finished", run);
} else {
  l.info("billing is off: nothing to reconcile");
}
await close();
