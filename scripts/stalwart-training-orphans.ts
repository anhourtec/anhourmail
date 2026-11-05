// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-off clean-up of spam-training samples the mail server kept after their account was destroyed
 * (docs/internal/08-operations.md "Orphaned spam-training samples"). Each sample holds a message's sender, subject and a
 * copy of it for `holdSamplesFor` (180 days by default); destroying an account on Stalwart v0.16.27 leaves them. Since
 * the mailbox purge queues `mailbox.training_purge`, new ones don't appear; this removes the ones from before.
 *
 *   npm run ops:training-orphans                 # dry run: counts only, changes nothing
 *   npm run ops:training-orphans -- --apply      # destroys the orphaned samples
 *
 * An orphan is a sample whose account id has no account on the server — checked twice: in the full account list, then
 * by asking for the missing ids themselves; if any exists after all, `--apply` refuses and prints how many. A sample of an existing account made before
 * that account was created ("inherited": the server gave a destroyed account's id to a new one) is counted and, with
 * `--inherited`, destroyed too. Reads only `accountId`, `isSpam` and `expiresAt` of a sample (never its content) and
 * the accounts' ids and creation times. Credentials: the provisioning key (accounts) and the training key (samples),
 * or the dev admin outside production. Prints counts only.
 */
import {
  accountsThatExist,
  allTrainingSamples,
  destroyTrainingSamples,
  orphanCleanup,
  orphanedSamples,
  SPAM_SAMPLE_HOLD_DEFAULT_MS,
  stalwartProvisioning,
  stalwartTraining,
} from "@anhourmail/stalwart-client";

const apply = process.argv.includes("--apply");
const inherited = process.argv.includes("--inherited");
const holdMs = Number(process.env.STALWART_SPAM_SAMPLE_HOLD_MS ?? SPAM_SAMPLE_HOLD_DEFAULT_MS);
if (!Number.isFinite(holdMs) || holdMs <= 0) throw new Error("STALWART_SPAM_SAMPLE_HOLD_MS must be a positive number");

async function main(): Promise<void> {
  const accounts = new Map<string, Date | null>();
  const rows = await stalwartProvisioning().transport.getAll<{ id: string; createdAt?: unknown }>("x:Account", [
    "createdAt",
  ]);
  for (const r of rows) {
    const at = typeof r.createdAt === "string" ? new Date(r.createdAt) : null;
    accounts.set(r.id, at !== null && Number.isFinite(at.getTime()) ? at : null);
  }
  const training = stalwartTraining();
  const samples = await allTrainingSamples(training);
  const found = orphanedSamples(samples, accounts, holdMs);
  // Asked again by id before anything goes: an account the list missed keeps its samples, and --apply refuses.
  const reappeared = new Set(await accountsThatExist(stalwartProvisioning(), found.missingAccountIds));
  const plan = orphanCleanup(samples, found, reappeared, { apply, inherited });
  const report = {
    mode: apply ? "apply" : "dry-run",
    samples: samples.length,
    accounts: accounts.size,
    orphaned: plan.orphans,
    orphanedAccountIds: found.missingAccountIds.length - reappeared.size,
    reappearedAccountIds: reappeared.size,
    inherited: found.inherited.length,
    destroyed: 0,
    ...(plan.refused ? { refused: "accounts missing from the list exist" } : {}),
  };
  if (plan.refused) process.exitCode = 1;
  else if (apply) report.destroyed = await destroyTrainingSamples(training, plan.doomed);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
