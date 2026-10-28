// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every few minutes: re-checks the DNS of domains added in the last week that are still waiting, and activates the
 * ones whose required records now pass (the worker then adds them to the mail server). Failed checks aren't audited.
 * Also queues `domain.ensure` for domains on the mail server whose DKIM keys were never read (domains from before the
 * keys were cached), so their DKIM records show in the console without anyone acting.
 */
import { backfillDkimKeys, recheckPendingDomains } from "@anhourmail/core/domains";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, dns, close } = runtime();
const activated = await recheckPendingDomains(deps, dns);
const dkimQueued = await backfillDkimKeys(deps);
log.child({ component: "domain-recheck" }).info("domain re-check finished", { activated, dkimQueued });
await close();
