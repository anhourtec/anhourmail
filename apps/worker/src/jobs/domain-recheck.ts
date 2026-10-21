// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every few minutes: re-checks the DNS of domains added in the last week that are still waiting, and activates the
 * ones whose required records now pass (the worker then adds them to the mail server). Failed checks aren't audited.
 */
import { recheckPendingDomains } from "@anhourmail/core/domains";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, dns, close } = runtime();
const activated = await recheckPendingDomains(deps, dns);
log.child({ component: "domain-recheck" }).info("domain re-check finished", { activated });
await close();
