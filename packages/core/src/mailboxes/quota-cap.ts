// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Brings mailbox quotas down to their plan's per-mailbox storage after the plan's storage was reduced (2026-10-23:
 * Free 10 → 1 GB, Plus and Supporter 30 → 10 GB). Never pushes anyone over quota: Stalwart refuses incoming mail to a
 * full mailbox, so a mailbox already holding more than the new cap keeps enough room for what it holds (rounded up to
 * the next GB, never more than it had) and is reported. Mail is never deleted. Each change is a system action audited
 * in the mailbox's account (`mailbox.quota_changed`, so the account's admins see it), and reaches the mail server
 * through the provisioning queue (`mailbox.ensure` → `quotas.maxDiskQuota`).
 */
import { PLANS } from "@anhourmail/shared/plans";

import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { GB } from "./entity";
import { type MailboxUsageReader, STORAGE_BATCH_SIZE } from "./storage";

const SYSTEM = { kind: "system", name: "quota-cap" } as const;

export type QuotaCapRun = {
  /** Mailboxes whose quota was above their plan's storage. */
  above: number;
  /** Brought down to the plan's storage. */
  capped: number;
  /**
   * Still above the plan's storage because of the mail they hold: lowered as far as that allows, or left as they are
   * when they can't go lower (ids, for the operator).
   */
  keptAbovePlan: string[];
  /** Not changed: the mail server couldn't tell us how much they hold, so the quota stays until a later run. */
  unmeasured: number;
};

/**
 * The quota a mailbox should have: the plan's storage, or — when it already holds more — what it holds rounded up to
 * the next GB. Never more than it has now.
 */
export function cappedQuota(currentBytes: number, planBytes: number, usedBytes: number): number {
  const room = Math.ceil(Math.max(0, usedBytes) / GB) * GB;
  return Math.min(currentBytes, Math.max(planBytes, room));
}

/**
 * One run over every mailbox (idempotent: a mailbox at or below its plan's storage is left alone). Reads current sizes
 * from the mail server first (provisioning key), so a cap is never decided on a stale or missing measurement; a
 * mailbox that isn't on the mail server yet holds nothing.
 */
export async function capQuotasToPlan(deps: Deps, reader: MailboxUsageReader): Promise<QuotaCapRun> {
  const all = await deps.uow.run((r) => r.mailboxStorage.quotas());
  const above = all.filter((m) => m.quotaBytes > PLANS[m.plan].storageGb * GB);
  const run: QuotaCapRun = { above: above.length, capped: 0, keptAbovePlan: [], unmeasured: 0 };

  const used = new Map<string, number>();
  const onServer = above.filter((m) => m.stalwartId !== null);
  for (let i = 0; i < onServer.length; i += STORAGE_BATCH_SIZE) {
    const batch = onServer.slice(i, i + STORAGE_BATCH_SIZE);
    try {
      const answer = new Map((await reader.usage(batch.map((m) => m.stalwartId ?? ""))).map((a) => [a.externalId, a]));
      for (const m of batch) {
        const a = answer.get(m.stalwartId ?? "");
        const local = m.address.slice(0, m.address.lastIndexOf("@")).toLowerCase();
        if (a?.localPart.toLowerCase() === local && Number.isSafeInteger(a.usedBytes) && a.usedBytes >= 0) {
          used.set(m.id, a.usedBytes);
        }
      }
    } catch {
      // Left unmeasured: these keep their quota this run.
    }
  }

  const stamp = String(deps.clock.now().getTime());
  for (const m of above) {
    const usedBytes = m.stalwartId === null ? 0 : used.get(m.id);
    if (usedBytes === undefined) {
      run.unmeasured += 1;
      continue;
    }
    // Can't go any lower without pushing it over quota (it already holds about as much): reported, not changed.
    if (cappedQuota(m.quotaBytes, PLANS[m.plan].storageGb * GB, usedBytes) >= m.quotaBytes) {
      run.keptAbovePlan.push(m.id);
      continue;
    }
    const req: RequestMeta = { requestId: `job-quota-cap-${stamp}`, ip: null, userAgent: null };
    const outcome = await mutation(
      deps,
      SYSTEM,
      req,
      {
        action: "mailbox.quota_changed",
        permission: "mailbox.manage",
        accountId: m.accountId,
        target: { type: "mailbox", id: m.id },
      },
      async (repos) => {
        // Read again inside the unit of work: the plan or the quota may have changed since the list was taken.
        const now = await repos.mailboxes.get(m.accountId, m.id);
        const account = await repos.accounts.get(m.accountId);
        // Changed meanwhile (rare): recorded as a no-op rather than skipped, so the entry still explains the run.
        const unchanged = { result: "unchanged" as const, meta: { reason: "plan_storage_reduced", unchanged: true } };
        if (!now || !account) return unchanged;
        const planBytes = PLANS[account.plan].storageGb * GB;
        const quotaBytes = cappedQuota(now.quotaBytes, planBytes, usedBytes);
        if (quotaBytes >= now.quotaBytes) return unchanged;
        await repos.mailboxes.setQuota(now.id, quotaBytes);
        if (now.stalwartId !== null) {
          await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: now.id, runAfter: deps.clock.now() });
          await repos.mailboxStorage.record([{ id: now.id, stalwartId: now.stalwartId, usedBytes }], deps.clock.now());
        }
        const abovePlan = quotaBytes > planBytes;
        return {
          result: abovePlan ? ("kept" as const) : ("capped" as const),
          target: { label: now.address },
          meta: {
            fromGb: now.quotaBytes / GB,
            toGb: quotaBytes / GB,
            planGb: planBytes / GB,
            usedBytes,
            reason: "plan_storage_reduced",
            abovePlan,
          },
        };
      },
    );
    if (outcome === "capped") run.capped += 1;
    if (outcome === "kept") run.keptAbovePlan.push(m.id);
  }
  return run;
}
