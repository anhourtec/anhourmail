// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHash } from "node:crypto";

import { accountSafeSenderEntries, type ManagedScriptStore } from "@anhourmail/core/webmail";
import { log } from "@anhourmail/server/log";
import { redis } from "@anhourmail/server/redis";

import { managedSieveStore } from "../adapters/stalwart";
import { container } from "../container";
import { bumpRulesVersion, safeSenders } from "./safe-senders";
import { applyAccountSafeSenders, MAX_SCRIPT_BYTES } from "./sieve";

/**
 * Applies an account's Safe senders list (ADR-0032 §1) to the managed scripts of its mailboxes that nobody saves: only
 * the one marked line is replaced (`applyAccountSafeSenders`), so no contacts are needed, and each write is a
 * compare-and-swap on the Sieve state read (a save made meanwhile wins, and it wrote the list itself). Only the web
 * app holds the key that writes Sieve (ADR-0020), so this runs here: after each console change, in the background of
 * the process that took it, and once after start-up for accounts that have entries. Results are counts only.
 */

export type SafeApplyResult = {
  checked: number;
  /** Scripts whose account line was rewritten. */
  updated: number;
  /** Already current, or nothing to rewrite (no script, not ours, trusted-only off). */
  current: number;
  /** Ours but switched off: writing would switch it back on, so left alone (the next save there writes the list). */
  skippedInactive: number;
  /** Changed between the read and the write (a save won and wrote the current list). */
  skippedChanged: number;
  skippedTooLarge: number;
  failed: number;
};

export type SafeApplyMailbox = { stalwartId: string; address: string };

/** One pass over `mailboxes` with `entries`. Never throws; a mailbox that fails is counted and the rest go on. */
export async function applyToMailboxes(
  mailboxes: readonly SafeApplyMailbox[],
  entries: readonly string[],
  store: ManagedScriptStore,
): Promise<SafeApplyResult> {
  const out: SafeApplyResult = {
    checked: 0,
    updated: 0,
    current: 0,
    skippedInactive: 0,
    skippedChanged: 0,
    skippedTooLarge: 0,
    failed: 0,
  };
  for (const m of mailboxes) {
    let script: Awaited<ReturnType<ManagedScriptStore["read"]>>;
    try {
      script = await store.read(m.stalwartId);
    } catch {
      out.failed += 1;
      continue;
    }
    out.checked += 1;
    const next = script === null ? null : applyAccountSafeSenders(script.content, entries);
    if (script === null || next === null) {
      out.current += 1;
      continue;
    }
    if (!script.active) {
      out.skippedInactive += 1;
      continue;
    }
    if (new TextEncoder().encode(next).length > MAX_SCRIPT_BYTES) {
      out.skippedTooLarge += 1;
      continue;
    }
    if (script.state === undefined) {
      out.failed += 1; // no state to compare against: never write blind
      continue;
    }
    try {
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

/** The account's active mailboxes on the mail server. */
async function mailboxesOf(accountId: string): Promise<SafeApplyMailbox[]> {
  const all = await container().deps.uow.run((r) => r.appPasswords.mailboxesOnServer());
  return all
    .filter((m) => m.accountId === accountId && m.status === "active")
    .map((m) => ({ stalwartId: m.stalwartId, address: m.address }));
}

/** Applies the account's current list to its mailboxes once (reads the list now, so a later change is never undone). */
export async function applyAccountSafeSendersNow(accountId: string): Promise<SafeApplyResult> {
  const entries = await accountSafeSenderEntries(container().deps, accountId);
  return applyToMailboxes(await mailboxesOf(accountId), entries, store());
}

/** Tries after a console change (a failed mailbox is tried again, up to this many passes). */
const PASSES = 3;
const RETRY_MS = 5_000;
/** Accounts with a pass running in this process, and whether another change arrived meanwhile. */
const running = new Map<string, boolean>();

/**
 * After a console change: applies the list in the background (the request has already answered). One pass per
 * account at a time; a change during a pass runs one more pass after it. Logs counts only.
 */
export function scheduleAccountSafeSenders(accountId: string): void {
  // This process's image check sees the change at once; other processes within a minute.
  safeSenders().accountChanged();
  if (running.has(accountId)) {
    running.set(accountId, true);
    return;
  }
  running.set(accountId, false);
  void (async () => {
    try {
      for (let pass = 1; pass <= PASSES; pass++) {
        running.set(accountId, false);
        const result = await applyAccountSafeSendersNow(accountId);
        log.at(result.failed === 0 ? "info" : "warn", "account safe senders applied", {
          component: "webmail-account-safe",
          pass,
          ...result,
        });
        if (running.get(accountId) === true) {
          pass = 0; // a newer change: start over with the list as it is now
          continue;
        }
        if (result.failed === 0) break;
        await new Promise((r) => setTimeout(r, RETRY_MS).unref());
      }
    } catch (err) {
      log.warn("account safe senders not applied", {
        component: "webmail-account-safe",
        errorName: err instanceof Error ? err.name : "unknown",
      });
    } finally {
      running.delete(accountId);
    }
  })();
}

const DONE_KEY = "am:webmail:account-safe:done:";
const DONE_TTL_SEC = 24 * 3600;

/**
 * At web-app start-up (after the rules upgrade): applies every account's list that has entries, so a change whose
 * background pass was cut short reaches its mailboxes. A Redis flag over every account's list skips the reads while
 * nothing changed since a run that finished clean (Redis down: the run simply happens).
 */
export async function applyAllAccountSafeSenders(): Promise<void> {
  try {
    const deps = container().deps;
    const accounts = await deps.uow.run((r) => r.webmailSettings.accountsWithSafeSenders());
    const lists = await Promise.all(accounts.map(async (a) => [a, await accountSafeSenderEntries(deps, a)] as const));
    const key = `${DONE_KEY}${createHash("sha256").update(JSON.stringify(lists)).digest("hex").slice(0, 32)}`;
    if (
      (await redis()
        .get(key)
        .catch(() => null)) === "1"
    ) {
      return;
    }
    const total: SafeApplyResult = {
      checked: 0,
      updated: 0,
      current: 0,
      skippedInactive: 0,
      skippedChanged: 0,
      skippedTooLarge: 0,
      failed: 0,
    };
    for (const [accountId, entries] of lists) {
      const r = await applyToMailboxes(await mailboxesOf(accountId), entries, store());
      for (const k of Object.keys(total) as (keyof SafeApplyResult)[]) total[k] += r[k];
    }
    log.at(total.failed === 0 ? "info" : "warn", "account safe senders applied at start-up", {
      component: "webmail-account-safe",
      accounts: lists.length,
      ...total,
    });
    if (total.failed === 0 && total.skippedChanged === 0)
      await redis()
        .set(key, "1", "EX", DONE_TTL_SEC)
        .catch(() => undefined);
  } catch (err) {
    log.warn("account safe senders start-up pass skipped", {
      component: "webmail-account-safe",
      errorName: err instanceof Error ? err.name : "unknown",
    });
  }
}
