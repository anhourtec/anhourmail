// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every minute (ADR-0030 §16): the summary email for each mail import that ended since the last run — to the person
 * who started it and, for an admin-started import, the mailbox's person. Counts per folder role only, never folder
 * names or anything from the mail. Each import is claimed before its emails go out (never sent twice); a failed send
 * is logged by error name and not retried. Database and the system mailer only. Counts in the log, never addresses.
 */
import { createMailer } from "@anhourmail/adapters/mail";
import { importSummaryEmail } from "@anhourmail/adapters/mail/imports";
import { claimImportSummaries } from "@anhourmail/core/imports";
import { log } from "@anhourmail/server/log";

import { sendQuietly } from "../data-lifecycle";
import { runtime } from "../runtime";

const l = log.child({ component: "import-notify" });
const consoleUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(consoleUrl)) throw new Error("APP_URL is not set");
if (!process.env.MAIL_TRANSPORT_URL || !process.env.MAIL_FROM) {
  throw new Error("MAIL_TRANSPORT_URL and MAIL_FROM must be set");
}
const mailer = createMailer({ url: process.env.MAIL_TRANSPORT_URL, from: process.env.MAIL_FROM });
const { deps, close } = runtime();
const counts = { claimed: 0, emailed: 0, failed: 0 };
try {
  const { claimed, summaries } = await claimImportSummaries(deps);
  counts.claimed = claimed;
  for (const s of summaries) {
    const url = `${consoleUrl}/accounts/${encodeURIComponent(s.accountId)}/import/${encodeURIComponent(s.importId)}`;
    const sent = await sendQuietly(
      mailer,
      importSummaryEmail({ ...s, url, site: deps.platform.hosts.site }),
      (errorName) => {
        l.error("import summary email failed", { errorName });
      },
    );
    if (sent) counts.emailed += 1;
    else counts.failed += 1;
  }
} finally {
  l.at(counts.failed > 0 ? "warn" : "info", "import notify run finished", counts);
  await close();
}
