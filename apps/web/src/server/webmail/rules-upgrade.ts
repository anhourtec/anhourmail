// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHash } from "node:crypto";

import { guardIds, type ManagedScriptUpgrade, mailboxDomainOf, upgradeManagedScripts } from "@anhourmail/core/webmail";
import { log } from "@anhourmail/server/log";
import { redis } from "@anhourmail/server/redis";

import { managedSieveStore } from "../adapters/stalwart";
import { container } from "../container";
import { env } from "../env";
import { platform } from "../platform";
import { trustedAuthservIds } from "./original";
import { MAX_SCRIPT_BYTES, upgradeManagedScript } from "./sieve";

/** How long after start-up the upgrade runs, so Stalwart and Postgres are up and the first requests come first. */
export const RULES_UPGRADE_DELAY_MS = 30_000;

/** Bump when the managed-script format changes again, so the next start runs the upgrade. */
export const RULES_FORMAT = "forwarding-guard-v3";
const DONE_KEY = "am:webmail:rules-upgrade:done:";
/**
 * A finished run is remembered this long; after that one start re-reads every script once more. Short, because the
 * reconciler (scheduler, no Redis) can't clear the flag when it finds an unguarded script: at most a day until the
 * next start re-runs the upgrade.
 */
const DONE_TTL_SEC = 24 * 3600;

/** Whether a run left nothing to do: every script current, or skipped only because it isn't ours to rewrite. */
export const finished = (r: ManagedScriptUpgrade): boolean =>
  r.failed === 0 && r.skippedChanged === 0 && r.skippedTooLarge === 0 && r.upgraded === 0;

/**
 * Re-applies the current managed-script format to mailboxes that set their rules before it changed (2026-10-30: the
 * forwarding guard, ADR-0019 updates "forwarding and DMARC"). Only the web app holds the key that writes managed
 * scripts, so it runs here, after each process start. Each write is a compare-and-swap, so a save made meanwhile wins.
 * Once a run finds nothing left to do, a Redis flag for this format and these authserv-ids skips the re-read on later
 * starts (Redis down: the run simply happens). Best effort: failures are logged (counts only) and the reconciler keeps
 * reporting what is left (`unguardedForwarding`).
 */
export async function upgradeMailRules(): Promise<void> {
  try {
    const e = env();
    const ids = trustedAuthservIds(e.MAIL_AUTHSERV_ID, platform().hosts.mx, e.NODE_ENV === "production");
    const key = `${DONE_KEY}${createHash("sha256")
      .update(`${RULES_FORMAT}|${guardIds(ids).join(",")}`)
      .digest("hex")
      .slice(0, 32)}`;
    if (
      (await redis()
        .get(key)
        .catch(() => null)) === "1"
    ) {
      log.info("managed script upgrade not needed", { component: "webmail-rules-upgrade" });
      return;
    }
    const result = await upgradeManagedScripts(
      container().deps,
      managedSieveStore(),
      (text, address) => upgradeManagedScript(text, ids, mailboxDomainOf(address)),
      { maxBytes: MAX_SCRIPT_BYTES },
    );
    log.at(result.failed === 0 ? "info" : "warn", "managed script upgrade finished", {
      component: "webmail-rules-upgrade",
      ...result,
    });
    // Remember only a run with nothing left (a run that upgraded something is confirmed by the next one).
    if (finished(result))
      await redis()
        .set(key, "1", "EX", DONE_TTL_SEC)
        .catch(() => undefined);
  } catch (err) {
    log.warn("managed script upgrade skipped", {
      component: "webmail-rules-upgrade",
      errorName: err instanceof Error ? err.name : "unknown",
    });
  }
}
