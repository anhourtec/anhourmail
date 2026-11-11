// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hourly trust promotion (ADR-0034 §2; rule 17): established accounts in good standing move from `new` to `standard`,
 * each audited by the system, their mailboxes queued so the mail server lets mail apps send. Thresholds from
 * `TRUST_PROMOTE_*` (./trust.ts); unset outside production, the job does nothing. Logs counts only.
 */
import { runTrustPromotion } from "@anhourmail/core/trust";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";
import { checkTrustPromoteSettings } from "../trust";

const l = log.child({ component: "trust-promote" });
const settings = checkTrustPromoteSettings();
if (settings === null) {
  l.info("trust promotion not configured (TRUST_PROMOTE_* unset); skipped");
} else {
  const { deps, close } = runtime();
  const run = await runTrustPromotion(deps, settings);
  l.at(run.failed > 0 ? "warn" : "info", "trust promotion finished", run);
  await close();
}
