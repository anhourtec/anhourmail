// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-off deploy step after storage became pooled per account (2026-10-23: Free 1 GB, Plus and Supporter 10 GB shared
 * by the whole account), and after any plan's pool goes down: in every account whose mailboxes are given more than
 * its pool, scales their quotas down proportionally, never below the mail each already holds (rounded up to the next
 * GB), so nobody is pushed over quota. Sizes come from the mail server with the provisioning key; the worker applies
 * the new quotas (`mailbox.ensure`). Each change is audited in the mailbox's account as a system action
 * (`mailbox.quota_changed`, reason `storage_pooled`). Never deletes mail. Safe to re-run.
 */
import { stalwartMailboxUsage } from "@anhourmail/adapters/stalwart";
import { rebalanceStoragePools } from "@anhourmail/core/mailboxes";
import { log } from "@anhourmail/server/log";
import { stalwartProvisioning } from "@anhourmail/stalwart-client";

import { runtime } from "../runtime";

const { deps, close } = runtime();
const run = await rebalanceStoragePools(deps, stalwartMailboxUsage(stalwartProvisioning()));
log
  .child({ component: "quota-cap" })
  .at(run.unmeasured > 0 ? "warn" : "info", "mailbox quotas rebalanced to account pools", {
    overPool: run.overPool,
    lowered: run.lowered,
    keptAbovePool: run.keptAbovePool.length,
    keptAbovePoolAccountIds: run.keptAbovePool,
    unmeasured: run.unmeasured,
  });
await close();
