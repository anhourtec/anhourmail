// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hourly reconciler: compares the control plane's desired mail state with Stalwart and reports drift (audited as
 * platform.reconciler_drift). NEVER deletes — unknown mailboxes may hold mail (CLAUDE.md rule 26).
 * RECONCILE_IGNORE_DOMAINS lists infrastructure domains that exist only on the mail server (dev: dev.test).
 */
import { reconcile } from "@anhourmail/core/provisioning";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const l = log.child({ component: "reconcile" });
const ignoreDomains = (process.env.RECONCILE_IGNORE_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const { deps, mail, close } = runtime();
const report = await reconcile(deps, mail, { ignoreDomains });
l.at(report.clean ? "info" : "warn", "reconcile finished", {
  clean: report.clean,
  missingDomains: report.missingOnMailServer.domains.length,
  missingMailboxes: report.missingOnMailServer.mailboxes.length,
  unknownDomains: report.unknownOnMailServer.domains.length,
  unknownMailboxes: report.unknownOnMailServer.mailboxes.length,
  quotaMismatches: report.quotaMismatch.length,
});
await close();
