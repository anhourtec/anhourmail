// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox storage used: the scheduler's `job:storage-usage` reads each mailbox's size from the mail server and keeps
 * the last good value on our mailbox row (sizes only — never anything about the mail itself, rule 24); the console
 * reads it from there, so showing it needs no mail-server access from the web app (ADR-0020 "Credential split").
 *
 * Recording a measurement isn't audited: it is an observation the scheduler repeats every few minutes, not a change
 * anyone asked for (the same as the domain re-check's failed checks).
 */
import type { PlanId } from "@anhourmail/shared/plans";

import type { Deps } from "../ports";

/** The last measurement of one mailbox: null until the scheduler has measured it once. */
export type MailboxStorage = { usedBytes: number | null; checkedAt: Date | null };

/** Mailboxes whose size the scheduler measures, and where it keeps the result (columns of the mailbox row). */
export type MailboxStorageRepository = {
  /** Every mailbox the mail server has (`stalwart_id` set), in any account. */
  targets(): Promise<{ id: string; address: string; stalwartId: string }[]>;
  /**
   * Records sizes measured at `at`. Only rows still on the same mail-server account (`stalwartId`): a mailbox that
   * was re-created meanwhile keeps its own value. Returns how many rows were written.
   */
  record(entries: readonly { id: string; stalwartId: string; usedBytes: number }[], at: Date): Promise<number>;
  /** The last measurement of each of the account's mailboxes (scoped: another account's ids are never returned). */
  byAccount(accountId: string): Promise<({ mailboxId: string } & MailboxStorage)[]>;
  /** Every mailbox, any account, with its quota and its account's plan (for capping quotas to the plan). */
  quotas(): Promise<
    { id: string; accountId: string; address: string; stalwartId: string | null; quotaBytes: number; plan: PlanId }[]
  >;
};

/** The mail server's view of mailbox sizes (adapter: Stalwart `x:Account/get usedDiskQuota`, provisioning key). */
export type MailboxUsageReader = {
  /**
   * Sizes of these mail-server accounts, with each one's local part so the caller can check it is still the account
   * it means. Accounts that no longer exist are left out. Throws when the mail server can't answer.
   */
  usage(externalIds: readonly string[]): Promise<{ externalId: string; localPart: string; usedBytes: number }[]>;
};

/** Accounts per `x:Account/get` call: well under Stalwart's default `maxObjectsInGet` (500). */
export const STORAGE_BATCH_SIZE = 100;

export type StorageRun = {
  /** Mailboxes with a mail-server account. */
  mailboxes: number;
  /** Measurements recorded. */
  measured: number;
  /** Not on the mail server, or on an account with another name now (the reconciler reports those). */
  skipped: number;
  /** Batches the mail server didn't answer: their mailboxes keep the last good value. */
  failedBatches: number;
};

/**
 * Measures every mailbox the mail server has, in batches, and records the sizes. A batch the mail server fails on is
 * skipped (counted, never written), so an outage never replaces the last good value with nothing; each batch commits
 * on its own, so one failure doesn't undo the others.
 */
export async function measureStorage(
  deps: Deps,
  reader: MailboxUsageReader,
  opts: { batchSize?: number } = {},
): Promise<StorageRun> {
  const size = Math.max(1, opts.batchSize ?? STORAGE_BATCH_SIZE);
  const targets = await deps.uow.run((r) => r.mailboxStorage.targets());
  const run: StorageRun = { mailboxes: targets.length, measured: 0, skipped: 0, failedBatches: 0 };
  for (let i = 0; i < targets.length; i += size) {
    const batch = targets.slice(i, i + size);
    let answer: Awaited<ReturnType<MailboxUsageReader["usage"]>>;
    try {
      answer = await reader.usage(batch.map((t) => t.stalwartId));
    } catch {
      run.failedBatches += 1;
      continue;
    }
    const byId = new Map(answer.map((a) => [a.externalId, a] as const));
    const entries: { id: string; stalwartId: string; usedBytes: number }[] = [];
    for (const t of batch) {
      const a = byId.get(t.stalwartId);
      const local = t.address.slice(0, t.address.lastIndexOf("@")).toLowerCase();
      if (a?.localPart.toLowerCase() !== local || !Number.isSafeInteger(a.usedBytes) || a.usedBytes < 0) {
        run.skipped += 1;
        continue;
      }
      entries.push({ id: t.id, stalwartId: t.stalwartId, usedBytes: a.usedBytes });
    }
    if (entries.length > 0) {
      const at = deps.clock.now();
      run.measured += await deps.uow.run((r) => r.mailboxStorage.record(entries, at));
    }
  }
  return run;
}
