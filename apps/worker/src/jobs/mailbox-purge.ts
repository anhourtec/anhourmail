// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Hourly: permanently removes mailboxes whose deletion grace period has ended (MAILBOX_DELETE_GRACE_DAYS) — the
 * Stalwart account and its mail first, then the mailbox and alias rows. Each removal (or failure) is audited as
 * platform.mailbox_purged in the mailbox's account; failures are retried on the next run.
 */
import { purgeDueMailboxes } from "@anhourmail/core/mailboxes";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, mail, close } = runtime();
const { purged, failed } = await purgeDueMailboxes(deps, mail);
log
  .child({ component: "mailbox-purge" })
  .at(failed > 0 ? "warn" : "info", "mailbox purge finished", { purged, failed });
await close();
