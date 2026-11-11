// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hourly reconciler: compares the control plane's desired mail state with Stalwart and reports drift (audited as
 * platform.reconciler_drift). NEVER deletes — unknown mailboxes may hold mail (CLAUDE.md rule 26).
 * RECONCILE_IGNORE_DOMAINS lists infrastructure domains that exist only on the mail server (dev: dev.test).
 */
import { stalwartAppPasswordInventory, stalwartManagedScripts } from "@anhourmail/adapters/stalwart";
import { reconcileAppPasswords } from "@anhourmail/core/app-passwords";
import { reconcile } from "@anhourmail/core/provisioning";
import { reconcileManagedScripts, trustedAuthservIds } from "@anhourmail/core/webmail";
import { log } from "@anhourmail/server/log";
import {
  abuseBanPeriodFromEnv,
  hasStalwartCredential,
  stalwartAudit,
  stalwartProvisioning,
} from "@anhourmail/stalwart-client";

import { workerPlatform } from "../platform";
import { runtime } from "../runtime";

const l = log.child({ component: "reconcile" });
const ignoreDomains = (process.env.RECONCILE_IGNORE_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const { deps, mail, close } = runtime();
// The automatic bans the deployment wants (STALWART_ABUSE_BAN_PERIOD_MS; the scheduler refuses to start in production
// without it): a finite abuse ban, and in production no private range on the allow-list. Unset outside production:
// not checked.
const abuseBanPeriodMs = abuseBanPeriodFromEnv(process.env);
const report = await reconcile(deps, mail, {
  ignoreDomains,
  ...(abuseBanPeriodMs === null
    ? {}
    : {
        banPolicy: { abuseBanPeriodMs, allowPrivateAllowedIps: process.env.NODE_ENV !== "production" },
      }),
});
l.at(report.clean ? "info" : "warn", "reconcile finished", {
  clean: report.clean,
  missingDomains: report.missingOnMailServer.domains.length,
  missingMailboxes: report.missingOnMailServer.mailboxes.length,
  unknownDomains: report.unknownOnMailServer.domains.length,
  unknownMailboxes: report.unknownOnMailServer.mailboxes.length,
  quotaMismatches: report.quotaMismatch.length,
  suspensionMismatches: report.suspensionMismatch.length,
  sieveLockMismatches: report.sieveLockMismatch.length,
  // Sending access per mailbox (re-queued) and the ceiling for every authenticated sender (report only; ADR-0034 §4).
  accessMismatches: report.accessMismatch.length,
  sendingPolicyMismatch: report.sendingPolicyMismatch?.join(",") ?? "not checked",
  // A finite abuse ban and no private allow-list entries in production (report only; the bootstrap applies them).
  banPolicyMismatch: report.banPolicyMismatch?.join(",") ?? "not checked",
  // The relay hold (ADR-0034 update "relay hold"): counts only, never addresses. Needs the hold key.
  relayHold: report.relayHoldMismatch
    ? {
        missing: report.relayHoldMismatch.missing.length,
        extra: report.relayHoldMismatch.extra.length,
        policyInPlace: report.relayHoldMismatch.policyInPlace,
        reloaded: report.relayHoldReloaded,
      }
    : "not checked",
});
if (report.sendingPolicyMismatch === null) {
  // The provisioning key can't read the throttles until the ops follow-up gives it (or the reconciler's key)
  // `sysMtaInboundThrottleGet` and `sysMtaStageRcptGet`; the deploy's bootstrap applies the ceiling meanwhile.
  l.warn("sending ceiling check skipped: this key can't read the mail server's throttles");
}
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
  passwordReplaced: credentials.passwordReplaced,
  passwordUntracked: credentials.passwordUntracked,
  unreachable: credentials.unreachable,
  mailboxesWithDrift: credentials.addresses.length,
});
// The service-account check runs every minute in its own job (job:service-accounts), not here.
// Managed Sieve scripts (ADR-0020): only the webmail's own rules, redirects only to a confirmed target, active. Report
// only. Reading a mailbox's script needs owner access, which only the scheduler's read-only audit key has; a one-off run
// in the worker container (no audit key) skips it and says so.
if (hasStalwartCredential("audit")) {
  // The forwarding guard each script should have: the same authserv-ids as the web app (MAIL_AUTHSERV_ID, else the MX
  // host) and the mailbox's own domain (ADR-0019 updates "forwarding and DMARC").
  const authservIds = trustedAuthservIds(
    process.env.MAIL_AUTHSERV_ID,
    workerPlatform().hosts.mx,
    process.env.NODE_ENV === "production",
  );
  const scripts = await reconcileManagedScripts(deps, stalwartManagedScripts(stalwartAudit()), { authservIds });
  l.at(scripts.clean ? "info" : "warn", "managed script reconcile finished", { ...scripts });
} else {
  l.warn("managed script reconcile skipped: no audit credential in this process (STALWART_AUDIT_KEY, scheduler only)");
}
await close();
