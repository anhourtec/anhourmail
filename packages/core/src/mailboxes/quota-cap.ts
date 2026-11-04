// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Brings each account's mailbox quotas within the account's storage pool (2026-10-23: storage became pooled per
 * account — Free 1 GB, Plus and Supporter 10 GB — and the mail server enforces quotas per mailbox only, so the sum of
 * an account's mailbox quotas must stay within the pool). An account whose mailboxes are given more than its pool has
 * them scaled down proportionally, never below the mail each already holds (rounded up to the next GB): Stalwart
 * refuses incoming mail to a full mailbox, so nobody is pushed over quota, and an account whose mail alone exceeds the
 * pool is reported (`keptAbovePool`). Mail is never deleted. Each change is a system action audited in the mailbox's
 * account (`mailbox.quota_changed`, reason `storage_pooled`, so the account's admins see it), and reaches the mail
 * server through the provisioning queue (`mailbox.ensure` → `quotas.maxDiskQuota`).
 */
import { accountPoolBytes, type PlanId } from "@anhourmail/shared/plans";
import { minQuotaBytes } from "@anhourmail/shared/storage";

import { entitledAddonsOf } from "../billing/ceilings";
import { mutation } from "../mutation";
import type { Deps, RequestMeta } from "../ports";
import { GB } from "./entity";
import { type MailboxUsageReader, STORAGE_BATCH_SIZE } from "./storage";

const SYSTEM = { kind: "system", name: "quota-cap" } as const;

export type QuotaCapRun = {
  /** Accounts looked at: their mailboxes were given more than the account's pool, or some are held (ADR-0029 §6). */
  overPool: number;
  /** Mailboxes whose quota was lowered. */
  lowered: number;
  /** Accounts still above their pool after the run, because of the mail their mailboxes hold (ids, for the operator). */
  keptAbovePool: string[];
  /** Accounts not changed: the mail server couldn't say how much one of their mailboxes holds (a later run retries). */
  unmeasured: number;
};

type Share = { id: string; quotaBytes: number; usedBytes: number };

/**
 * New quotas for an over-assigned account: each mailbox's share of the pool in proportion to its current quota, in
 * whole GB, never below what it holds (rounded up, at least 1 GB) and never above what it has now. Leftover whole GB
 * go to the mailboxes that lost most to rounding; when the floors leave the total above the pool, the mailboxes with
 * room to spare give up more. Accounts within their pool keep their quotas as they are.
 */
export function rebalancedQuotas(poolBytes: number, mailboxes: readonly Share[]): Map<string, number> {
  const assigned = mailboxes.reduce((s, m) => s + m.quotaBytes, 0);
  const out = new Map(mailboxes.map((m) => [m.id, m.quotaBytes] as const));
  if (assigned <= poolBytes || assigned === 0) return out;
  const rows = mailboxes.map((m) => {
    const exact = (m.quotaBytes * poolBytes) / assigned;
    const floor = Math.min(m.quotaBytes, minQuotaBytes(m.usedBytes));
    const target = Math.min(m.quotaBytes, Math.max(floor, Math.floor(exact / GB) * GB));
    return { id: m.id, cap: m.quotaBytes, floor, exact, target };
  });
  let total = rows.reduce((s, r) => s + r.target, 0);
  while (total > poolBytes) {
    const give = rows
      .filter((r) => r.target - GB >= r.floor)
      .sort((a, b) => b.target - b.exact - (a.target - a.exact) || b.target - a.target)[0];
    if (!give) break;
    give.target -= GB;
    total -= GB;
  }
  while (poolBytes - total >= GB) {
    const take = rows
      .filter((r) => r.target + GB <= r.cap)
      .sort((a, b) => b.exact - b.target - (a.exact - a.target))[0];
    if (!take) break;
    take.target += GB;
    total += GB;
  }
  for (const r of rows) out.set(r.id, r.target);
  return out;
}

type Row = {
  id: string;
  accountId: string;
  address: string;
  stalwartId: string | null;
  quotaBytes: number;
  plan: PlanId;
};

/** Sizes of these mailboxes from the mail server (a mailbox not on it holds nothing); unanswered ones are left out. */
async function measure(reader: MailboxUsageReader, list: readonly Row[]): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  for (const m of list) if (m.stalwartId === null) used.set(m.id, 0);
  const onServer = list.filter((m) => m.stalwartId !== null);
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
      // Left unmeasured: their account keeps its quotas this run.
    }
  }
  return used;
}

/**
 * One run over every account (idempotent: an account within its pool is left alone). Reads current sizes from the
 * mail server first (provisioning key), so a quota is never decided on a stale or missing measurement.
 */
export async function rebalanceStoragePools(
  deps: Deps,
  reader: MailboxUsageReader,
  opts: {
    /** Only these accounts (the billing timers pass the lapsed ones); all accounts when absent. */
    accountIds?: readonly string[];
  } = {},
): Promise<QuotaCapRun> {
  const only = opts.accountIds ? new Set(opts.accountIds) : null;
  const all: Row[] = (await deps.uow.run((r) => r.mailboxStorage.quotas())).filter(
    (m) => only === null || only.has(m.accountId),
  );
  const byAccount = new Map<string, Row[]>();
  for (const m of all) byAccount.set(m.accountId, [...(byAccount.get(m.accountId) ?? []), m]);
  // Each account's pool with the storage blocks in force (ADR-0029 §7), so purchased storage is never taken back. A
  // mailbox held after a downgrade (ADR-0029 §6) leaves the pool arithmetic: its quota is pinned to what it holds, and
  // the mailbox kept on Free gets the pool on its own.
  const pools = new Map<string, number>();
  const held = new Set<string>();
  await deps.uow.run(async (r) => {
    for (const [accountId, list] of byAccount) {
      const plan = list[0]?.plan ?? "free";
      pools.set(accountId, accountPoolBytes(plan, (await entitledAddonsOf(r, accountId, plan)).storageBlocks));
      for (const id of await r.billing.heldIds(
        accountId,
        "mailbox",
        list.map((m) => m.id),
      ))
        held.add(id);
    }
  });
  const poolOf = (accountId: string) => pools.get(accountId) ?? 0;
  const pooled = (list: readonly Row[]) => list.filter((m) => !held.has(m.id));
  const over = [...byAccount.entries()]
    .filter(
      ([accountId, list]) =>
        pooled(list).reduce((s, m) => s + m.quotaBytes, 0) > poolOf(accountId) || list.some((m) => held.has(m.id)),
    )
    .map(([, list]) => list);
  const run: QuotaCapRun = { overPool: over.length, lowered: 0, keptAbovePool: [], unmeasured: 0 };
  const stamp = String(deps.clock.now().getTime());

  for (const list of over) {
    const first = list[0];
    if (!first) continue;
    const used = await measure(reader, list);
    if (list.some((m) => !used.has(m.id))) {
      run.unmeasured += 1;
      continue;
    }
    const poolBytes = poolOf(first.accountId);
    const targets = rebalancedQuotas(
      poolBytes,
      pooled(list).map((m) => ({ id: m.id, quotaBytes: m.quotaBytes, usedBytes: used.get(m.id) ?? 0 })),
    );
    // A held mailbox keeps exactly the room its mail needs (never below it): it can still receive within that.
    for (const m of list) {
      if (held.has(m.id)) targets.set(m.id, Math.min(m.quotaBytes, minQuotaBytes(used.get(m.id) ?? 0)));
    }
    let total = 0;
    for (const m of list) {
      const target = targets.get(m.id) ?? m.quotaBytes;
      const usedBytes = used.get(m.id) ?? 0;
      const isHeld = held.has(m.id);
      if (target >= m.quotaBytes) {
        if (!isHeld) total += m.quotaBytes;
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
          await repos.accounts.lock(m.accountId); // serialises with the console's own storage changes
          const now = await repos.mailboxes.get(m.accountId, m.id);
          const account = await repos.accounts.get(m.accountId);
          // Changed since the list was taken (rare): recorded as a no-op, so the entry still explains the run.
          const reason = isHeld ? "plan_hold" : "storage_pooled";
          const unchanged = { result: "unchanged" as const, meta: { reason, unchanged: true } };
          if (!now || account?.plan !== m.plan || now.quotaBytes !== m.quotaBytes) return unchanged;
          // Holds lifted meanwhile (a resubscribe): the mailbox is back in the pool, so nothing is pinned.
          const stillHeld = (await repos.billing.heldIds(m.accountId, "mailbox", [m.id])).length > 0;
          if (stillHeld !== isHeld) return unchanged;
          await repos.mailboxes.setQuota(now.id, target);
          if (now.stalwartId !== null) {
            await repos.provisioning.enqueue({ kind: "mailbox.ensure", subjectId: now.id, runAfter: deps.clock.now() });
            await repos.mailboxStorage.record(
              [{ id: now.id, stalwartId: now.stalwartId, usedBytes }],
              deps.clock.now(),
            );
          }
          return {
            result: "lowered" as const,
            target: { label: now.address },
            meta: {
              fromGb: now.quotaBytes / GB,
              toGb: target / GB,
              poolGb: poolBytes / GB,
              usedBytes,
              reason,
            },
          };
        },
      );
      if (outcome === "lowered") run.lowered += 1;
      if (!isHeld) total += outcome === "lowered" ? target : m.quotaBytes;
    }
    if (total > poolBytes) run.keptAbovePool.push(first.accountId);
  }
  return run;
}
