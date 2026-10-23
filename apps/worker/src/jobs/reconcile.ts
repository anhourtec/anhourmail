// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hourly reconciler: compares the control plane's desired mail state with Stalwart and reports drift (audited as
 * platform.reconciler_drift). NEVER deletes — unknown mailboxes may hold mail (CLAUDE.md rule 26).
 * RECONCILE_IGNORE_DOMAINS lists infrastructure domains that exist only on the mail server (dev: dev.test).
 */
import { stalwartAppPasswordInventory, stalwartManagedScripts } from "@anhourmail/adapters/stalwart";
import { reconcileAppPasswords } from "@anhourmail/core/app-passwords";
import { reconcile } from "@anhourmail/core/provisioning";
import { reconcileManagedScripts } from "@anhourmail/core/webmail";
import { log } from "@anhourmail/server/log";
import { hasStalwartCredential, stalwartAudit, stalwartProvisioning } from "@anhourmail/stalwart-client";

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
  suspensionMismatches: report.suspensionMismatch.length,
  sieveLockMismatches: report.sieveLockMismatch.length,
});
// App passwords and API keys per mailbox (ADR-0020): report only; pending revocations are queued again. Read from the
// accounts with the provisioning key (no owner access to the mailboxes).
const credentials = await reconcileAppPasswords(deps, stalwartAppPasswordInventory(stalwartProvisioning()));
l.at(credentials.clean ? "info" : "warn", "app password reconcile finished", {
  clean: credentials.clean,
  requeued: credentials.requeued,
  revokingInFlight: credentials.revokingInFlight,
  unknownOnMailServer: credentials.unknownOnMailServer,
  unexpectedPermissions: credentials.unexpectedPermissions,
  missingOnMailServer: credentials.missingOnMailServer,
  apiKeys: credentials.apiKeys,
  extraPasswords: credentials.extraPasswords,
  unreachable: credentials.unreachable,
  mailboxesWithDrift: credentials.addresses.length,
});
// The service-account check runs every minute in its own job (job:service-accounts), not here.
// Managed Sieve scripts (ADR-0020): only the webmail's own rules, redirects only to a confirmed target, active. Report
// only. Reading a mailbox's script needs owner access, which only the scheduler's read-only audit key has; a one-off run
// in the worker container (no audit key) skips it and says so.
if (hasStalwartCredential("audit")) {
  const scripts = await reconcileManagedScripts(deps, stalwartManagedScripts(stalwartAudit()));
  l.at(scripts.clean ? "info" : "warn", "managed script reconcile finished", { ...scripts });
} else {
  l.warn("managed script reconcile skipped: no audit credential in this process (STALWART_AUDIT_KEY, scheduler only)");
}
await close();
