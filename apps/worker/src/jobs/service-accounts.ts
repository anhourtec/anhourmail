// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Service-account check (every minute; ADR-0020 "Credential split"): the owners of the management keys
 * (`svc-provision`, `svc-ops`, `svc-audit`) on the infrastructure domains must exist and hold API keys only. A
 * password on one (any key with `sysAccountUpdate` can set one, though the management proxy refuses it) would sign in
 * with that key's permissions — on `svc-ops`/`svc-audit`, `impersonate`, including `<mailbox>%<account>` as any
 * mailbox even on the mail ports. Cheap (one `x:Account/get`), so it runs far more often than the hourly reconciler.
 * Reports and audits drift (`platform.reconciler_drift`); never removes anything. Uses the provisioning key.
 *
 * It refuses to run in production without `RECONCILE_IGNORE_DOMAINS` (the infrastructure domains to search): without
 * it the check would find no service accounts and pass with `checked: 0`, hiding drift.
 */
import { expectedServiceAccounts, stalwartServiceAccounts } from "@anhourmail/adapters/stalwart";
import { reconcileServiceAccounts } from "@anhourmail/core/provisioning";
import { log } from "@anhourmail/server/log";
import { stalwartProvisioning } from "@anhourmail/stalwart-client";

import { runtime } from "../runtime";

const l = log.child({ component: "service-accounts" });
const ignoreDomains = (process.env.RECONCILE_IGNORE_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

if (process.env.NODE_ENV === "production" && ignoreDomains.length === 0) {
  throw new Error("service-account check refused: set RECONCILE_IGNORE_DOMAINS to the system domain(s) in production");
}

const { deps, close } = runtime();
const report = await reconcileServiceAccounts(
  deps,
  stalwartServiceAccounts(stalwartProvisioning(), ignoreDomains),
  expectedServiceAccounts(),
);
l.at(report.clean ? "info" : "warn", "service account check finished", { ...report });
await close();
