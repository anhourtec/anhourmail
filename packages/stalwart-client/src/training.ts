// SPDX-License-Identifier: MIT
/**
 * Spam-classifier training samples (`x:SpamTrainingSample`), for removing the ones a mail import created (ADR-0030
 * update 2026-11-05). On the pinned v0.16.27 every IMAP APPEND adds a sample for the account — into Junk as spam,
 * anywhere else as ham — and the classifier model is shared server-wide, so mail copied from someone else's server
 * would train everyone's filter. The worker destroys those samples after each import slice with the training key
 * (`keys.ts`), matched by account, kind and the slice's time window.
 *
 * Verified on the dev server (2026-11-05): with `impersonate` + `sysSpamTrainingSample{Get,Query,Destroy}` the samples
 * are one server-wide list; `query { filter: { accountId } }` answers that account's ids; `get` answers `accountId`,
 * `isSpam`, `expiresAt` (whole seconds) — and `from`, `subject`, `blobId`, which we never ask for; `set { destroy }`
 * works, create and update are `forbidden`. A sample has no creation time: `expiresAt` is its creation plus the
 * classifier's `holdSamplesFor` (default 180 days, `SPAM_SAMPLE_HOLD_DEFAULT_MS`), rounded down to the second.
 */
import { StalwartError } from "./client";
import type { StalwartManagement } from "./management";

/** `x:SpamClassifier.holdSamplesFor`'s default on v0.16.27 (180 days, ms). */
export const SPAM_SAMPLE_HOLD_DEFAULT_MS = 15_552_000_000;

/** The only properties ever read from a sample (never `from`, `subject` or `blobId`: those are mail content). */
export const TRAINING_SAMPLE_PROPERTIES = ["accountId", "isSpam", "expiresAt"] as const;

export type TrainingSample = { id: string; accountId: string | null; isSpam: boolean; expiresAt: Date | null };

const PAGE = 500;

/** The account's training samples (ids, kind, expiry), read with the training key. */
export async function accountTrainingSamples(mgmt: StalwartManagement, accountId: string): Promise<TrainingSample[]> {
  // The filter is the server's; checked again here so another account's sample is never destroyed.
  return (await samplesWhere(mgmt, { accountId })).filter((s) => s.accountId === accountId);
}

/** Every training sample on the server (ids, account, kind, expiry; never content), for the orphan clean-up. */
export const allTrainingSamples = (mgmt: StalwartManagement): Promise<TrainingSample[]> => samplesWhere(mgmt, {});

async function samplesWhere(mgmt: StalwartManagement, filter: Record<string, string>): Promise<TrainingSample[]> {
  // One query with its total checked (`queryAll`): `position` paging repeats pages on v0.16.27 and would miss samples.
  const ids = await mgmt.transport.queryAll("x:SpamTrainingSample", filter);
  if (ids.length === 0) return [];
  const rows = await mgmt.transport.getAll<{ id: string; accountId?: unknown; isSpam?: unknown; expiresAt?: unknown }>(
    "x:SpamTrainingSample",
    [...TRAINING_SAMPLE_PROPERTIES],
    ids,
  );
  return rows.map((r) => {
    const at = typeof r.expiresAt === "string" ? new Date(r.expiresAt) : null;
    return {
      id: r.id,
      accountId: typeof r.accountId === "string" ? r.accountId : null,
      isSpam: r.isSpam === true,
      expiresAt: at !== null && Number.isFinite(at.getTime()) ? at : null,
    };
  });
}

/**
 * The ham samples of a sample list that were created inside `window` (each side widened by `slackMs` for clock
 * differences and for samples the server writes a moment after the APPEND). Spam samples are never matched: an import
 * never appends into Junk or with `$Junk`, so any spam sample in the window is the person's own.
 */
export function importSamples(
  samples: readonly TrainingSample[],
  window: { from: Date; to: Date },
  opts: { holdMs: number; slackMs: number },
): string[] {
  const from = window.from.getTime() - opts.slackMs;
  // `expiresAt` is rounded down to the second: a sample made at x.999 s reads as x.000.
  const to = window.to.getTime() + opts.slackMs;
  return samples
    .filter((s) => {
      if (s.isSpam || s.expiresAt === null) return false;
      const created = s.expiresAt.getTime() - opts.holdMs;
      return created >= from - 1000 && created <= to;
    })
    .map((s) => s.id);
}

/**
 * Every sample (spam and ham) of a destroyed account that was created before `before` (its destroy time), widened by
 * `slackMs` for clock differences. Destroying the account doesn't take its samples (verified on v0.16.27): each keeps
 * the message's sender, subject and a copy of it until `holdSamplesFor` runs out. The cut-off matters because the
 * server can hand the same account id to an account created later: that account's samples are newer and stay. A
 * sample without a readable expiry can't be dated and goes too (it can only be the old account's or a malformed one).
 */
export function samplesMadeBefore(
  samples: readonly TrainingSample[],
  before: Date,
  opts: { holdMs: number; slackMs: number },
): string[] {
  const limit = before.getTime() + opts.slackMs;
  return samples.filter((s) => s.expiresAt === null || s.expiresAt.getTime() - opts.holdMs <= limit).map((s) => s.id);
}

/**
 * Samples left by destroyed accounts, for the one-off clean-up (`scripts/stalwart-training-orphans.ts`): `orphans` have
 * no account with their id (or none at all), `inherited` were made before the account now holding their id was created
 * (the server gave a destroyed account's id to a new one), with a minute of slack. `accounts` maps each existing
 * account id to its creation time (null: unknown, never counted as inherited). `missingAccountIds`: the distinct ids
 * with no account.
 */
export function orphanedSamples(
  samples: readonly TrainingSample[],
  accounts: ReadonlyMap<string, Date | null>,
  holdMs: number,
): { orphans: string[]; inherited: string[]; missingAccountIds: string[] } {
  const orphans: string[] = [];
  const inherited: string[] = [];
  const missing = new Set<string>();
  for (const s of samples) {
    if (s.accountId === null || !accounts.has(s.accountId)) {
      orphans.push(s.id);
      if (s.accountId !== null) missing.add(s.accountId);
      continue;
    }
    const created = accounts.get(s.accountId) ?? null;
    if (created !== null && s.expiresAt !== null && s.expiresAt.getTime() - holdMs < created.getTime() - 60_000) {
      inherited.push(s.id);
    }
  }
  return { orphans, inherited, missingAccountIds: [...missing] };
}

/**
 * What the clean-up may destroy: the orphans whose account is still missing when asked for by id, plus the inherited
 * ones with `inherited`. With `apply`, any reappeared account refuses the whole run (`refused`), destroying nothing.
 */
export function orphanCleanup(
  samples: readonly TrainingSample[],
  found: ReturnType<typeof orphanedSamples>,
  reappeared: ReadonlySet<string>,
  opts: { apply: boolean; inherited: boolean },
): { doomed: string[]; orphans: number; refused: boolean } {
  const orphanIds = new Set(found.orphans);
  const orphans = samples
    .filter((x) => orphanIds.has(x.id) && (x.accountId === null || !reappeared.has(x.accountId)))
    .map((x) => x.id);
  const refused = opts.apply && reappeared.size > 0;
  const doomed = refused ? [] : [...orphans, ...(opts.inherited ? found.inherited : [])];
  return { doomed, orphans: orphans.length, refused };
}

/**
 * Of `accountIds` (ones a full account list didn't have), those that exist after all, asked for by id: the clean-up
 * re-checks before destroying anything, so an account the list missed (or one created meanwhile) keeps its samples.
 */
export async function accountsThatExist(mgmt: StalwartManagement, accountIds: readonly string[]): Promise<string[]> {
  if (accountIds.length === 0) return [];
  const rows = await mgmt.transport.getAll<{ id: string }>("x:Account", ["id"], [...accountIds]);
  const asked = new Set(accountIds);
  return [...new Set(rows.map((r) => r.id).filter((id) => asked.has(id)))];
}

/**
 * A sample whose expiry is further ahead than the hold allows was made under a longer `holdSamplesFor` than the one
 * configured here: the window match would miss every import sample, so the caller stops and says so.
 */
export function holdMismatch(samples: readonly TrainingSample[], now: Date, holdMs: number): boolean {
  const limit = now.getTime() + holdMs + 5 * 60_000;
  return samples.some((s) => s.expiresAt !== null && s.expiresAt.getTime() > limit);
}

/** Destroys samples by id (any already gone, e.g. used up by training, count as done). Returns how many went. */
export async function destroyTrainingSamples(mgmt: StalwartManagement, ids: readonly string[]): Promise<number> {
  let destroyed = 0;
  for (let i = 0; i < ids.length; i += PAGE) {
    const chunk = ids.slice(i, i + PAGE);
    const res = (await mgmt.transport.call([["x:SpamTrainingSample/set", { destroy: chunk }, "d"]])).get("d") ?? {};
    const done = Array.isArray(res.destroyed) ? res.destroyed.length : 0;
    const failed = (res.notDestroyed ?? {}) as Record<string, { type?: unknown }>;
    const refused = Object.values(failed).filter((f) => f.type !== "notFound");
    if (refused.length > 0) throw new StalwartError("x:SpamTrainingSample/set notDestroyed", "set", failed);
    destroyed += done;
  }
  return destroyed;
}
