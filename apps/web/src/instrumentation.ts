// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runs once when a Node.js server instance starts, before it serves a request (Next 16 `register`;
 * node_modules/next/dist/docs/01-app/02-guides/instrumentation.md). We validate the environment here so a
 * misconfigured deployment fails fast instead of at the first request: `env()` refuses the wrong Stalwart key
 * (e.g. the provisioning or audit key, or the legacy `STALWART_API_KEY`) in production (ADR-0020 "Credential
 * split"). The operations key's permission *scope* is checked against Stalwart before its first use
 * (`server/adapters/stalwart.ts`), not here, because Stalwart may not be reachable yet at startup. It also schedules
 * the managed-script upgrade (`server/webmail/rules-upgrade.ts`).
 */
export async function register(): Promise<void> {
  // Only in the Node.js server runtime (not the edge runtime or a build worker).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { env } = await import("./server/env");
  env();
  // Existing mailboxes' rules get the current managed-script format (forwarding skips DMARC failures), a little after
  // start-up; never under unit tests. Unref'd so it never keeps the process alive.
  if (process.env.NODE_ENV === "test") return;
  const { RULES_UPGRADE_DELAY_MS, upgradeMailRules } = await import("./server/webmail/rules-upgrade");
  setTimeout(() => void upgradeMailRules(), RULES_UPGRADE_DELAY_MS).unref();
}
