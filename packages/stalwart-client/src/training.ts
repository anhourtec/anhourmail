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
  const ids: string[] = [];
  for (let position = 0; ; position += PAGE) {
    const q = (
      await mgmt.transport.call([["x:SpamTrainingSample/query", { filter: { accountId }, position, limit: PAGE }, "q"]])
    ).get("q");
    const page = Array.isArray(q?.ids) ? (q.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
    ids.push(...page);
    if (page.length < PAGE) break;
  }
  if (ids.length === 0) return [];
  const rows = await mgmt.transport.getAll<{ id: string; accountId?: unknown; isSpam?: unknown; expiresAt?: unknown }>(
    "x:SpamTrainingSample",
    [...TRAINING_SAMPLE_PROPERTIES],
    ids,
  );
  return (
    rows
      .map((r) => {
        const at = typeof r.expiresAt === "string" ? new Date(r.expiresAt) : null;
        return {
          id: r.id,
          accountId: typeof r.accountId === "string" ? r.accountId : null,
          isSpam: r.isSpam === true,
          expiresAt: at !== null && Number.isFinite(at.getTime()) ? at : null,
        };
      })
      // The filter is the server's; checked again here so another account's sample is never destroyed.
      .filter((s) => s.accountId === accountId)
  );
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
