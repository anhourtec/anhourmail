// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHash } from "node:crypto";

import { mailboxTier, outsideAddresses } from "@anhourmail/core/trust";
import { applySendingPause, type ManagedScriptStore, pauseModeFor, redirectTargets } from "@anhourmail/core/webmail";
import {
  type AccountSignals,
  redisAccountSignals,
  SENDING_PAUSE_SIGNALS_KEY,
} from "@anhourmail/server/account-signals";
import { log } from "@anhourmail/server/log";
import { redis } from "@anhourmail/server/redis";
import type { TrustTier } from "@anhourmail/shared/sending";

import { managedSieveStore } from "../adapters/stalwart";
import { container } from "../container";
import { bumpRulesVersion } from "./safe-senders";

/**
 * Keeps each mailbox's managed Sieve script in step with its trust tier (ADR-0034 update 2026-11-11 "Forwarding and
 * automatic replies under a tier"): the mail server's send block doesn't stop a script's `redirect` or `vacation`, so a
 * `restricted` mailbox's script has both paused and a `new` one's redirects outside are paused (`sending-pause.ts`);
 * any other tier gets them back exactly as set. Only the web app holds the key that writes Sieve (ADR-0020), so this
 * runs here: in the background after a staff tier change or mailbox restriction, a refund or a plan change made in the
 * console (`scheduleSendingPause`), after a billing sync in the worker moved a tier or the reconciler found a script
 * still forwarding or replying against its tier (their signals, polled by `startSendingPauseSignals`), every five
 * minutes for every account whose tier changed or that was restricted since (`startSendingPauseCatchUp`, whoever made
 * the change, a signal lost included), and once after start-up for every mailbox (`applyAllSendingPauses`). A
 * webmail save writes the pause itself (`saveMailRules`). Each write is a compare-and-swap on the Sieve state read; a
 * save that wins is checked again on the next pass. Counts only in logs.
 */

export type PauseApplyResult = {
  checked: number;
  /** Scripts rewritten (paused, lifted, or moved between the two). */
  updated: number;
  /** Already as the tier wants it, or no script. */
  current: number;
  /** Ours but switched off: it doesn't run, and the save that switches it back on writes the pause. */
  skippedInactive: number;
  /** Changed between the read and the write: checked again on the next pass. */
  skippedChanged: number;
  failed: number;
};

export type PauseMailbox = { stalwartId: string; address: string; tier: TrustTier };

const empty = (): PauseApplyResult => ({
  checked: 0,
  updated: 0,
  current: 0,
  skippedInactive: 0,
  skippedChanged: 0,
  failed: 0,
});

/** One pass over `mailboxes`. Never throws; a mailbox that fails is counted and the rest go on. */
export async function applyPauseToMailboxes(
  mailboxes: readonly PauseMailbox[],
  store: ManagedScriptStore,
  outside: (addresses: readonly string[]) => Promise<string[]>,
): Promise<PauseApplyResult> {
  const out = empty();
  for (const m of mailboxes) {
    try {
      const script = await store.read(m.stalwartId);
      out.checked += 1;
      if (script === null) {
        out.current += 1;
        continue;
      }
      const mode = pauseModeFor(m.tier);
      const away = new Set(mode === "external" ? await outside(redirectTargets(script.content)) : []);
      const next = applySendingPause(script.content, mode, (a) => away.has(a));
      if (next === script.content) {
        out.current += 1;
        continue;
      }
      if (!script.active) {
        out.skippedInactive += 1;
        continue;
      }
      if (script.state === undefined) {
        out.failed += 1; // no state to compare against: never write blind
        continue;
      }
      if (await store.write(m.stalwartId, next, script.state, m.address)) out.updated += 1;
      else out.skippedChanged += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

/** The store with every write bumping that mailbox's rules version (ADR-0027 §3), as `saveMailRules` does. */
function store(): ManagedScriptStore {
  const base = managedSieveStore();
  return {
    ...base,
    write: async (accountId, script, state, address) => {
      const written = await base.write(accountId, script, state, address);
      if (written) await bumpRulesVersion(accountId, address);
      return written;
    },
  };
}

/** Active mailboxes on the mail server (one account's, or all) with their effective tiers, read now. */
async function mailboxesWithTiers(accountId?: string): Promise<(PauseMailbox & { id: string })[]> {
  return container().deps.uow.run(async (r) => {
    const all = (await r.appPasswords.mailboxesOnServer()).filter(
      (m) => m.status === "active" && (accountId === undefined || m.accountId === accountId),
    );
    const out: (PauseMailbox & { id: string })[] = [];
    for (const m of all) {
      out.push({
        id: m.id,
        stalwartId: m.stalwartId,
        address: m.address,
        tier: await mailboxTier(r, m.accountId, m.id),
      });
    }
    return out;
  });
}

const outside = (addresses: readonly string[]) => outsideAddresses(container().deps, addresses);

/** Applies the account's mailboxes' tiers to their scripts once (tiers read now, so a later change is never undone). */
export async function applySendingPauseNow(accountId: string): Promise<PauseApplyResult> {
  return applyPauseToMailboxes(await mailboxesWithTiers(accountId), store(), outside);
}

/** Passes after a change (a mailbox that failed or changed meanwhile is tried again, up to this many passes). */
const PASSES = 3;
const RETRY_MS = 5_000;
const running = new Map<string, boolean>();

/**
 * After a staff tier change or mailbox restriction (the change has committed and the request answered): applies the
 * account's tiers to its scripts in the background. One pass per account at a time; a change during a pass runs one
 * more pass after it. Logs counts only.
 */
export function scheduleSendingPause(accountId: string): void {
  if (running.has(accountId)) {
    running.set(accountId, true);
    return;
  }
  running.set(accountId, false);
  void (async () => {
    try {
      for (let pass = 1; pass <= PASSES; pass++) {
        running.set(accountId, false);
        const result = await applySendingPauseNow(accountId);
        const clean = result.failed === 0 && result.skippedChanged === 0;
        log.at(clean ? "info" : "warn", "sending pause applied", {
          component: "webmail-sending-pause",
          pass,
          ...result,
        });
        if (running.get(accountId) === true) {
          pass = 0; // a newer change: start over with the tiers as they are now
          continue;
        }
        if (clean) break;
        await new Promise((r) => setTimeout(r, RETRY_MS).unref());
      }
    } catch (err) {
      log.warn("sending pause not applied", {
        component: "webmail-sending-pause",
        errorName: err instanceof Error ? err.name : "unknown",
      });
    } finally {
      running.delete(accountId);
    }
  })();
}

const SIGNAL_POLL_MS = 15_000;
const SIGNAL_BATCH = 100;
const isId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Takes a batch of the accounts the worker signalled (a billing sync moved their tier: a promotion, or a refund, a
 * dispute or an early plan end taking it back; `@anhourmail/server/account-signals`) and schedules each one's pass.
 * Anything that isn't an account id is dropped. Returns how many were scheduled.
 */
export async function takeSendingPauseSignals(
  signals: AccountSignals,
  schedule: (accountId: string) => void = scheduleSendingPause,
): Promise<number> {
  const ids = (await signals.take(SIGNAL_BATCH)).filter(isId);
  for (const id of ids) schedule(id);
  return ids.length;
}

/**
 * At web-app start-up: polls the worker's signals every 15 s (unref'd, so it never keeps the process alive). Each
 * signal goes to one web process (`SPOP`). Redis down: nothing is taken, and the start-up pass catches up.
 */
export function startSendingPauseSignals(): void {
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const n = await takeSendingPauseSignals(redisAccountSignals(redis(), SENDING_PAUSE_SIGNALS_KEY));
        if (n > 0) log.info("sending pause signals taken", { component: "webmail-sending-pause", accounts: n });
      } catch (err) {
        log.warn("sending pause signals not taken", {
          component: "webmail-sending-pause",
          errorName: err instanceof Error ? err.name : "unknown",
        });
      } finally {
        busy = false;
      }
    })();
  }, SIGNAL_POLL_MS).unref();
}

/** How often the catch-up pass runs, how many accounts it takes at once, and how far it looks back past its last run. */
const CATCH_UP_EVERY_MS = 5 * 60_000;
const CATCH_UP_LIMIT = 1_000;
/** The worker's and the web app's clocks differ a little: each pass looks back this far before the last one began. */
const CATCH_UP_OVERLAP_MS = 2 * 60_000;

export type CatchUpState = { since: Date; retry: Set<string> };
export type CatchUpDeps = {
  /** Accounts whose tier changed or that were restricted since then (`TrustRepository.changedSince`). */
  changed: (since: Date, limit: number) => Promise<string[]>;
  apply: (accountId: string) => Promise<PauseApplyResult>;
  now: () => Date;
};

const catchUpDeps: CatchUpDeps = {
  changed: (since, limit) => container().deps.uow.run((r) => r.trust.changedSince(since, limit)),
  apply: applySendingPauseNow,
  now: () => new Date(),
};

/**
 * One catch-up pass (ADR-0034 security review F5): every account whose tier changed or that was restricted since the
 * last pass, whoever changed it (the promotion job, a billing sync, a later detection job in the worker), plus the
 * accounts the last pass couldn't finish, get their mailboxes' pause applied. So a restriction made outside the web
 * app reaches its scripts within minutes even when its signal was lost (Redis down, the worker without `REDIS_URL`).
 * Returns the state for the next pass: from this pass's start (less the overlap), with the accounts that failed or
 * changed meanwhile to try again. Never throws for one account; ids only, never logged.
 */
export async function catchUpSendingPauses(
  state: CatchUpState,
  d: CatchUpDeps = catchUpDeps,
): Promise<{ state: CatchUpState; accounts: number; unfinished: number }> {
  const started = d.now();
  const changed = await d.changed(state.since, CATCH_UP_LIMIT);
  const ids = [...new Set([...changed, ...state.retry])].filter(isId);
  const retry = new Set<string>();
  for (const id of ids) {
    const r = await d.apply(id).catch(() => null);
    if (!r || r.failed > 0 || r.skippedChanged > 0) retry.add(id);
  }
  // A full batch may have left some out: look from the same moment again next time.
  const since = changed.length >= CATCH_UP_LIMIT ? state.since : new Date(started.getTime() - CATCH_UP_OVERLAP_MS);
  return { state: { since, retry }, accounts: ids.length, unfinished: retry.size };
}

/**
 * At web-app start-up: the catch-up pass every five minutes (unref'd), from just before `from` (the start-up pass
 * covers everything until then). One pass at a time; counts only in logs.
 */
export function startSendingPauseCatchUp(from: Date = new Date()): void {
  let state: CatchUpState = { since: new Date(from.getTime() - CATCH_UP_OVERLAP_MS), retry: new Set() };
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const out = await catchUpSendingPauses(state);
        state = out.state;
        if (out.accounts > 0) {
          log.at(out.unfinished === 0 ? "info" : "warn", "sending pause catch-up pass", {
            component: "webmail-sending-pause",
            accounts: out.accounts,
            unfinished: out.unfinished,
          });
        }
      } catch (err) {
        log.warn("sending pause catch-up pass skipped", {
          component: "webmail-sending-pause",
          errorName: err instanceof Error ? err.name : "unknown",
        });
      } finally {
        busy = false;
      }
    })();
  }, CATCH_UP_EVERY_MS).unref();
}

const DONE_KEY = "am:webmail:sending-pause:done:";
const DONE_TTL_SEC = 24 * 3600;

/**
 * At web-app start-up (after the rules upgrade): applies every active mailbox's tier, so a pass cut short and a tier
 * the worker changed (promotion) reach the scripts. A Redis flag over every mailbox's tier skips the reads while
 * nothing changed since a run that finished clean (Redis down: the run simply happens).
 */
export async function applyAllSendingPauses(): Promise<void> {
  try {
    const mailboxes = await mailboxesWithTiers();
    const key = `${DONE_KEY}${createHash("sha256")
      .update(JSON.stringify(mailboxes.map((m) => [m.id, m.tier])))
      .digest("hex")
      .slice(0, 32)}`;
    if (
      (await redis()
        .get(key)
        .catch(() => null)) === "1"
    ) {
      return;
    }
    const result = await applyPauseToMailboxes(mailboxes, store(), outside);
    const clean = result.failed === 0 && result.skippedChanged === 0;
    log.at(clean ? "info" : "warn", "sending pause applied at start-up", {
      component: "webmail-sending-pause",
      ...result,
    });
    if (clean)
      await redis()
        .set(key, "1", "EX", DONE_TTL_SEC)
        .catch(() => undefined);
  } catch (err) {
    log.warn("sending pause start-up pass skipped", {
      component: "webmail-sending-pause",
      errorName: err instanceof Error ? err.name : "unknown",
    });
  }
}
