// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { systemEmail } from "@anhourmail/adapters/mail/layout";
import { devImportSources, type ImportContext, type ImportNotice } from "@anhourmail/core/imports";
import { keyRingFromEnv } from "@anhourmail/server/keyring";
import { log } from "@anhourmail/server/log";

import { importCredentialIssuer } from "./adapters/stalwart";
import { container } from "./container";
import { env } from "./env";
import { platform } from "./platform";

/*
 * Mail import wiring for the web app (ADR-0030): the operations-key issuer for the destination credential, the key
 * ring that seals both secrets (the importer opens them with the same ring), and development's source allow-list
 * (refused in production). Starting an import never reaches the source server from here: the importer does that.
 */

let context: ImportContext | null = null;

export function importContext(): ImportContext {
  if (!context) {
    const e = env();
    context = {
      issuer: importCredentialIssuer(),
      sealer: keyRingFromEnv({
        spec: e.SECRETS_KEYRING,
        production: e.NODE_ENV === "production",
        devFallbackSecret: e.BETTER_AUTH_SECRET,
      }),
      devSources: devImportSources({
        NODE_ENV: e.NODE_ENV,
        IMPORT_DEV_ALLOW_SOURCES: process.env.IMPORT_DEV_ALLOW_SOURCES,
      }),
      devSourcesOnly: e.NODE_ENV !== "production",
    };
  }
  return context;
}

const utcTime = (d: Date) =>
  `${new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d)} UTC`;

/**
 * Tells a mailbox's person that an admin started importing mail into it (ADR-0030 §13): who, when and from which
 * server. Sent to their console sign-in address. Never the old mailbox's username or anything about the mail.
 */
export async function sendImportNotice(accountId: string, notice: ImportNotice): Promise<void> {
  const url = `${env().APP_URL.replace(/\/$/, "")}/accounts/${encodeURIComponent(accountId)}/import`;
  try {
    await container().mailer.send(
      systemEmail({
        to: notice.to,
        subject: "An admin started importing mail into your mailbox",
        preheader: `Mail from another server is being copied into ${notice.address}.`,
        greeting: "Hi,",
        lines: [
          `${notice.startedBy} started copying mail from another server into ${notice.address} on ${utcTime(notice.at)}. The old mailbox is only read; nothing there is changed.`,
        ],
        facts: [{ label: "Copying from:", value: notice.sourceHost }],
        closing: "If you didn't expect this, ask your account's admins, or cancel the import from the console.",
        action: { label: "See the import", url },
        reason: "We send this whenever someone else starts an import into your mailbox.",
        site: platform().hosts.site,
      }),
    );
  } catch (err) {
    // The import is recorded either way; log only the error's name (no addresses).
    log.error("import notice failed", { component: "imports", errorName: err instanceof Error ? err.name : "unknown" });
  }
}
