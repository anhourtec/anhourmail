// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every minute (ADR-0025): builds waiting data exports (control-plane data only, sealed with the key ring), emails each
 * person that theirs is ready, and deletes archives past their download window. Database and key ring only; never mail.
 * Logs counts, never addresses or contents.
 */
import { exportReadyEmail } from "@anhourmail/adapters/mail/data-lifecycle";
import { buildNextExport, expireExports } from "@anhourmail/core/data";
import { log } from "@anhourmail/server/log";

import { lifecycleDeps, sendQuietly } from "../data-lifecycle";
import { runtime } from "../runtime";

/** Builds per run (the rest wait a minute): keeps one run well inside its timeout. */
const PER_RUN = 5;

const l = log.child({ component: "data-export" });
const { deps, close } = runtime();
const { archiver, mailer, consoleUrl } = lifecycleDeps();
const counts = { built: 0, retried: 0, failed: 0, emailed: 0, expired: 0 };
try {
  for (let i = 0; i < PER_RUN; i++) {
    const out = await buildNextExport(deps, archiver);
    if (out === null) break;
    if (out === "retry") counts.retried += 1;
    else if (out === "failed") counts.failed += 1;
    else {
      counts.built += 1;
      const url =
        out.kind === "account" && out.accountId
          ? `${consoleUrl}/accounts/${out.accountId}/settings`
          : `${consoleUrl}/your-data`;
      const sent = await sendQuietly(
        mailer,
        exportReadyEmail({
          to: out.email,
          kind: out.kind,
          expiresAt: out.expiresAt,
          url,
          site: deps.platform.hosts.site,
        }),
        (errorName) => {
          l.error("export ready email failed", { errorName });
        },
      );
      if (sent) counts.emailed += 1;
    }
  }
  counts.expired = await expireExports(deps);
} finally {
  l.at(counts.failed > 0 ? "warn" : "info", "data export run finished", counts);
  await close();
}
