// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every 10 minutes: reads each mailbox's storage used from the mail server (`x:Account/get` name + `usedDiskQuota`
 * only, in batches, with the provisioning key) and records it on the mailbox row for the console. Sizes only, never
 * anything about the mail (rule 24). A batch the mail server fails on keeps its mailboxes' last good value.
 */
import { stalwartMailboxUsage } from "@anhourmail/adapters/stalwart";
import { measureStorage } from "@anhourmail/core/mailboxes";
import { log } from "@anhourmail/server/log";
import { stalwartProvisioning } from "@anhourmail/stalwart-client";

import { runtime } from "../runtime";

const { deps, close } = runtime();
const run = await measureStorage(deps, stalwartMailboxUsage(stalwartProvisioning()));
log
  .child({ component: "storage-usage" })
  .at(run.failedBatches > 0 ? "warn" : "info", "storage usage measured", { ...run });
await close();
