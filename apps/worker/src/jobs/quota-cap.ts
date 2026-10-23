// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-off deploy step after a plan's storage per mailbox goes down (2026-10-23: Free 1 GB, Plus and Supporter 10 GB):
 * lowers every mailbox quota above its plan's storage, never below the mail it already holds (rounded up to the next
 * GB), so nobody is pushed over quota. Sizes come from the mail server with the provisioning key; the worker applies
 * the new quotas (`mailbox.ensure`). Each change is audited in the mailbox's account as a system action
 * (`mailbox.quota_changed`, reason `plan_storage_reduced`). Never deletes mail. Safe to re-run.
 */
import { stalwartMailboxUsage } from "@anhourmail/adapters/stalwart";
import { capQuotasToPlan } from "@anhourmail/core/mailboxes";
import { log } from "@anhourmail/server/log";
import { stalwartProvisioning } from "@anhourmail/stalwart-client";

import { runtime } from "../runtime";

const { deps, close } = runtime();
const run = await capQuotasToPlan(deps, stalwartMailboxUsage(stalwartProvisioning()));
log.child({ component: "quota-cap" }).at(run.unmeasured > 0 ? "warn" : "info", "mailbox quotas capped to plan", {
  above: run.above,
  capped: run.capped,
  keptAbovePlan: run.keptAbovePlan.length,
  keptAbovePlanIds: run.keptAbovePlan,
  unmeasured: run.unmeasured,
});
await close();
