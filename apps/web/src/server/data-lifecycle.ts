// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { sealedArchiver } from "@anhourmail/adapters/archive";
import type { MailMessage } from "@anhourmail/adapters/mail";
import {
  deletionCancelledEmail,
  deletionScheduledEmail,
  loginDeletedEmail,
} from "@anhourmail/adapters/mail/data-lifecycle";
import type { DeletionNotice, ExportArchiver } from "@anhourmail/core/data";
import { log } from "@anhourmail/server/log";
import { keyRingFromEnv } from "@anhourmail/server/keyring";

import { container } from "./container";
import { env } from "./env";
import { platform } from "./platform";

/*
 * Data export and account deletion wiring for the web app (ADR-0025): the archive opener (the same key ring the worker
 * seals with) and the emails the console sends. A failed email is logged by error name only, never the address, and
 * never fails the request (the change is already committed and audited).
 */

let archiver: ExportArchiver | null = null;

/** Opens sealed export archives for their download. */
export function exportArchiver(): ExportArchiver {
  if (!archiver) {
    const e = env();
    archiver = sealedArchiver(
      keyRingFromEnv({
        spec: e.SECRETS_KEYRING,
        production: e.NODE_ENV === "production",
        devFallbackSecret: e.BETTER_AUTH_SECRET,
      }),
    );
  }
  return archiver;
}

const consoleUrl = () => env().APP_URL.replace(/\/$/, "");

async function send(message: MailMessage, what: string): Promise<void> {
  try {
    await container().mailer.send(message);
  } catch (err) {
    log.error(`${what} email failed`, {
      component: "data-lifecycle",
      errorName: err instanceof Error ? err.name : "unknown",
    });
  }
}

/** Tells everyone in the account that it is scheduled for deletion (Owners get the cancel link). */
export async function sendDeletionScheduled(accountId: string, n: DeletionNotice): Promise<void> {
  const settings = `${consoleUrl()}/accounts/${encodeURIComponent(accountId)}/settings`;
  for (const p of n.notify) {
    await send(
      deletionScheduledEmail({
        to: p.email,
        accountName: n.accountName,
        deleteAfter: n.deleteAfter,
        isOwner: p.owner,
        url: p.owner ? settings : consoleUrl(),
        site: platform().hosts.site,
      }),
      "deletion scheduled",
    );
  }
}

/** Tells everyone in the account that its deletion was cancelled. */
export async function sendDeletionCancelled(n: DeletionNotice): Promise<void> {
  for (const p of n.notify) {
    await send(
      deletionCancelledEmail({
        to: p.email,
        accountName: n.accountName,
        url: consoleUrl(),
        site: platform().hosts.site,
      }),
      "deletion cancelled",
    );
  }
}

/** Confirms to the address a deleted login had that it is gone. */
export async function sendLoginDeleted(email: string): Promise<void> {
  await send(loginDeletedEmail({ to: email, url: env().SITE_URL, site: platform().hosts.site }), "login deleted");
}
