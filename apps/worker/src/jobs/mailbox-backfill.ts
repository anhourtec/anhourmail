// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-off deploy step (05-webmail.md "Settings", deploy/README.md): queue `mailbox.ensure` for every active mailbox
 * so existing accounts get the customer Sieve lock. The worker applies the jobs. (A managed script switched off is
 * re-activated by the next webmail settings save and reported by the reconciler; the worker has no owner access.)
 * Safe to re-run (ensure is idempotent). Audited as platform.mailboxes_requeued.
 */
import { requeueActiveMailboxes } from "@anhourmail/core/provisioning";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, close } = runtime();
const queued = await requeueActiveMailboxes(deps);
log.info("mailbox backfill queued", { component: "mailbox-backfill", queued });
await close();
