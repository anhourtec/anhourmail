// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hashPassword } from "@anhourmail/adapters/auth";
import {
  applyDefaultFolders,
  applySenderIdentityPolicy,
  backfillArchiveFolders,
  type StalwartManagement,
  upsertOAuthClient,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "@anhourmail/stalwart-client";

/**
 * Dev-only Stalwart configuration (docs/internal/02-mail-infrastructure.md "Dev mail flow").
 * Idempotent: safe on every `npm run db:seed`.
 *
 * - Every non-local recipient routes to Mailpit (CLAUDE.md rule 19). The container network has no internet
 *   route either (docker-compose.yml `mailnet`), so this is belt and braces.
 * - Pyzor is a network lookup service; the isolated dev network can't reach it, and Stalwart refuses to
 *   reload while it is enabled. Dev only — production keeps it on (rule 20 is about production filtering).
 * - The admin WebUI bundle is served from a pinned local file because Stalwart can't download it.
 * - The webmail BFF's OAuth client (`anhourmail-webmail`, ADR-0018) is registered with the local webmail origins.
 *   Production registers exactly one redirect URI, `https://mail.anhourmail.com/oauth/callback` (the same call,
 *   run by the deploy's bootstrap with `WEBMAIL_URL`); the URI is never visited, it only has to match.
 */

/** Local webmail origins: WEBMAIL_URL plus the localhost/127.0.0.1 spellings of the dev webmail port. */
export function devWebmailOrigins(webmailUrl: string | undefined, webmailDevPort = "43300"): string[] {
  const origins = [`http://localhost:${webmailDevPort}`, `http://127.0.0.1:${webmailDevPort}`];
  if (webmailUrl) origins.unshift(new URL(webmailUrl).origin);
  return [...new Set(origins)];
}

export const DEV_DOMAIN = "dev.test";
export const DEV_MAILBOXES = ["alice", "bob"] as const;

const WEBUI_VERSION = "v1.0.11";
const WEBUI_SHA256 = "d67e68caba02024301c79da9f15fe465de9bf5382cee54bdf9c309a97b4179a5";
const WEBUI_URL = `https://github.com/stalwartlabs/webui/releases/download/${WEBUI_VERSION}/webui.zip`;
const GENERATED_DIR = path.join(import.meta.dirname, ".generated");
const WEBUI_FILE = `webui-${WEBUI_VERSION}.zip`;

/** Downloads the pinned WebUI bundle once (host side) and verifies its hash. */
export async function ensureWebUiBundle(): Promise<void> {
  const target = path.join(GENERATED_DIR, WEBUI_FILE);
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
  if (existsSync(target) && sha(readFileSync(target)) === WEBUI_SHA256) return;
  const res = await fetch(WEBUI_URL);
  if (!res.ok) throw new Error(`WebUI download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== WEBUI_SHA256) throw new Error("WebUI bundle hash mismatch — refusing to use it");
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(target, buf);
}

export async function applyDevMailPlan(
  mgmt: StalwartManagement,
  opts: { mailboxPassword: string; webmailOrigins: string[] },
): Promise<{ domainId: string; restartNeeded: boolean }> {
  await ensureWebUiBundle();
  let restartNeeded = await mgmt.setWebUiResource(`file:///opt/anhourmail/${WEBUI_FILE}`);
  await mgmt.updateSingleton("x:SpamPyzor", { enable: false });
  await mgmt.upsertRelayRoute({
    name: "mailpit",
    description: "Dev: every remote recipient goes to Mailpit",
    host: "mailpit",
    port: 1025,
  });
  await mgmt.setRemoteRoute("mailpit");
  // Defaults are 25/465/993/995/4190; add the STARTTLS ports clients also use. New listeners bind on restart.
  for (const l of [
    { name: "submission", port: 587, protocol: "smtp", implicitTls: false },
    { name: "imap", port: 143, protocol: "imap", implicitTls: false },
    { name: "pop3", port: 110, protocol: "pop3", implicitTls: false },
  ] as const) {
    if (await mgmt.ensureListener(l)) restartNeeded = true;
  }
  // Header From must equal the authenticated envelope sender (ADR-0019). Also a production setting.
  await applySenderIdentityPolicy(mgmt);
  // Transport hardening (ADR-0018, validated 2026-10-21): offer no SASL mechanisms on submission until the session
  // is TLS. The default still offered OAUTHBEARER/XOAUTH2 in clear text on 587. Port 25 never offers AUTH.
  await mgmt.updateSingleton("x:MtaStageAuth", {
    saslMechanisms: {
      match: { "0": { if: "local_port != 25 && is_tls", then: "[plain, login, oauthbearer, xoauth2]" } },
      else: "false",
    },
  });
  // The webmail BFF forwards the end user's address on OAuth calls, so Stalwart's anonymous rate limit and its
  // failed-login ban apply per person instead of to the app (verified 2026-10-22: limits follow X-Forwarded-For).
  // `useXForwarded` trusts the header from any caller, so it is only safe because Stalwart's HTTP listener is
  // reachable from the app's network alone (production: internal network; dev: 127.0.0.1 by default). Also a
  // production setting.
  await mgmt.updateSingleton("x:Http", { useXForwarded: true });
  // Every account opened from now on gets Archive (role `archive`) from Stalwart; the built-in default doesn't create
  // one. Also a production setting (applied by the deploy's bootstrap with its administrator credential).
  await applyDefaultFolders(mgmt);
  await mgmt.reloadSettings();

  await upsertOAuthClient(mgmt, {
    clientId: WEBMAIL_OAUTH_CLIENT_ID,
    description: "AnhourMail webmail (dev)",
    redirectUris: opts.webmailOrigins.map(webmailRedirectUri),
  });

  // No catch-all on dev.test (`upsertDomain` writes `catchAllAddress: null`): unknown local parts are refused at RCPT with
  // 550 5.1.2 by Stalwart's directory lookup, on 25 and on submission. `x:MtaStageRcpt` stays at its defaults (no
  // `rewrite`, no RCPT `script`), which this relies on; the production plan is the same (02-mail-infrastructure.md
  // "Unknown recipients"; `stack:verify` checks it).
  const domainId = await mgmt.upsertDomain({ name: DEV_DOMAIN });
  for (const name of DEV_MAILBOXES) {
    await mgmt.upsertUser({
      name,
      domain: DEV_DOMAIN,
      password: await hashPassword(opts.mailboxPassword),
      resetPassword: true,
      quotaBytes: 1024 ** 3,
      aliases:
        name === "alice" ? [{ name: "hello", domain: DEV_DOMAIN, enabled: true, description: "Seeded alias" }] : [],
    });
  }
  // Accounts whose mail store was opened before the setting above have no Archive: add it (never touches mail).
  await backfillArchiveFolders(mgmt);
  return { domainId, restartNeeded };
}
