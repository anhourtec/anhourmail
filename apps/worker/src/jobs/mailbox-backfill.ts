// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-off deploy step (05-webmail.md "Settings", deploy/README.md): queue `mailbox.ensure` for every active mailbox
 * so existing accounts get the customer Sieve lock and their managed script re-activated. The worker applies the jobs.
 * Safe to re-run (ensure is idempotent). Audited as platform.mailboxes_requeued.
 */
import { requeueActiveMailboxes } from "@anhourmail/core/provisioning";
import { log } from "@anhourmail/server/log";

import { runtime } from "../runtime";

const { deps, close } = runtime();
const queued = await requeueActiveMailboxes(deps);
log.info("mailbox backfill queued", { component: "mailbox-backfill", queued });
await close();
