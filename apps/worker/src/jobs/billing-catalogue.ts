// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing catalogue check (ADR-0029 §2), at scheduler start and daily: the provider's prices against `plans.ts`, the
 * one source of every published price (rule 32). While they disagree, new checkouts and plan or add-on changes are
 * refused (503) and every run logs the drift at error level for operations; the drift is audited when it appears or
 * changes and when it is fixed. A provider outage keeps the last result. Billing off: nothing to check.
 */
import { checkBillingCatalogue } from "@anhourmail/core/billing";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const l = log.child({ component: "billing-catalogue" });
const { deps, billing, close } = runtime();
try {
  const provider = billing();
  if (!provider) {
    l.info("billing is off: no catalogue to check");
  } else {
    const run = await checkBillingCatalogue(deps, provider);
    if (run.drift.length > 0) {
      l.error("billing catalogue doesn't match the plan facts: new checkouts and plan changes are refused", {
        change: run.change,
        driftSince: run.driftSince?.toISOString() ?? null,
        drift: run.drift,
      });
    } else {
      l.info("billing catalogue matches the plan facts", { change: run.change });
    }
  }
} catch (err) {
  // An outage: the last recorded result stands until the next run.
  l.warn("billing catalogue check failed", { errorName: err instanceof Error ? err.name : "unknown" });
  process.exitCode = 1;
} finally {
  await close();
}
