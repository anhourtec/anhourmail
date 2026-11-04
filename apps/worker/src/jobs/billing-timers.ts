// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hourly billing timers (ADR-0029 §5, §6; rule 17): a restricted account past `BILLING.restrictedDays` has its
 * subscription ended (the sync then lapses it with holds), ended comps are synced, holds on what the Owner since deleted
 * are dropped, and the lapsed accounts' held mailboxes have their storage pinned to their mail (out of the pool
 * arithmetic, sizes read with the provisioning key). Held mailboxes past their receive window keep receiving for now
 * (send-blocked; the backscatter decision is the maintainer's). Never deletes mail or data.
 */
import { stalwartMailboxUsage } from "@anhourmail/adapters/stalwart";
import { runBillingTimers } from "@anhourmail/core/billing";
import { rebalanceStoragePools } from "@anhourmail/core/mailboxes";
import { log } from "@anhourmail/server/log";
import { stalwartProvisioning } from "@anhourmail/stalwart-client";

import { runtime } from "../runtime";

const l = log.child({ component: "billing-timers" });
const { deps, billing, close } = runtime();
const run = await runBillingTimers(deps, billing());
l.at(run.restrictedFailed > 0 ? "warn" : "info", "billing timers finished", run);
const lapsed = await deps.uow.run((r) => r.billing.listByState("lapsed", 500));
if (lapsed.length > 0) {
  const pinned = await rebalanceStoragePools(deps, stalwartMailboxUsage(stalwartProvisioning()), {
    accountIds: lapsed.map((b) => b.accountId),
  });
  l.at(pinned.unmeasured > 0 ? "warn" : "info", "lapsed accounts' storage pinned", {
    accounts: pinned.overPool,
    lowered: pinned.lowered,
    unmeasured: pinned.unmeasured,
  });
}
await close();
