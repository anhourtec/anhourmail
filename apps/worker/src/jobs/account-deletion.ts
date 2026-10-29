// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every 10 minutes (ADR-0025): advances accounts whose deletion grace period ended by one step each — mailboxes to
 * `deleting` (the hourly `mailbox-purge` removes them and their mail), then domains released, then the account row —
 * and emails everyone who was in an account once it is gone. Never before the grace period ends; idempotent; every step
 * audited. Database only (the mail server is reached through the provisioning queue and the purge job).
 */
import { accountDeletedEmail } from "@anhourmail/adapters/mail/data-lifecycle";
import { runDueDeletions } from "@anhourmail/core/data";
import { log } from "@anhourmail/server/log";

import { lifecycleDeps, sendQuietly } from "../data-lifecycle";
import { runtime } from "../runtime";

const l = log.child({ component: "account-deletion" });
const { deps, close } = runtime();
const { mailer, consoleUrl } = lifecycleDeps();
try {
  const steps = await runDueDeletions(deps);
  let emailed = 0;
  for (const s of steps) {
    if (s.step !== "deleted") continue;
    for (const to of s.notify) {
      const sent = await sendQuietly(
        mailer,
        accountDeletedEmail({ to, accountName: s.accountName, url: consoleUrl, site: deps.platform.hosts.site }),
        (errorName) => {
          l.error("account deleted email failed", { errorName });
        },
      );
      if (sent) emailed += 1;
    }
  }
  const byStep: Record<string, number> = {};
  for (const s of steps) byStep[s.step] = (byStep[s.step] ?? 0) + 1;
  l.info("account deletion run finished", { accounts: steps.length, ...byStep, emailed });
} finally {
  await close();
}
