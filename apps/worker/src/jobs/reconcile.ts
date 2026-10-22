// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hourly reconciler: compares the control plane's desired mail state with Stalwart and reports drift (audited as
 * platform.reconciler_drift). NEVER deletes — unknown mailboxes may hold mail (CLAUDE.md rule 26).
 * RECONCILE_IGNORE_DOMAINS lists infrastructure domains that exist only on the mail server (dev: dev.test).
 */
import { stalwartAppPasswords, stalwartManagedScripts } from "@anhourmail/adapters/stalwart";
import { reconcileAppPasswords } from "@anhourmail/core/app-passwords";
import { reconcile } from "@anhourmail/core/provisioning";
import { reconcileManagedScripts } from "@anhourmail/core/webmail";
import { log } from "@anhourmail/server/log";
import { stalwart } from "@anhourmail/stalwart-client";

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
// App passwords and API keys per mailbox (ADR-0020): report only; pending revocations are queued again.
const credentials = await reconcileAppPasswords(deps, stalwartAppPasswords(stalwart()));
l.at(credentials.clean ? "info" : "warn", "app password reconcile finished", {
  clean: credentials.clean,
  requeued: credentials.requeued,
  revokingInFlight: credentials.revokingInFlight,
  unknownOnMailServer: credentials.unknownOnMailServer,
  unexpectedPermissions: credentials.unexpectedPermissions,
  missingOnMailServer: credentials.missingOnMailServer,
  apiKeys: credentials.apiKeys,
  unreachable: credentials.unreachable,
  mailboxesWithDrift: credentials.addresses.length,
});
// Managed Sieve scripts (ADR-0020): only the webmail's own rules, redirects only to a confirmed target. Report only.
const scripts = await reconcileManagedScripts(deps, stalwartManagedScripts(stalwart()));
l.at(scripts.clean ? "info" : "warn", "managed script reconcile finished", { ...scripts });
await close();
