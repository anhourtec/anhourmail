// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import type { CreatedAppPassword } from "@anhourmail/core/app-passwords";
import { log } from "@anhourmail/server/log";

import { systemEmail } from "@anhourmail/adapters/mail/layout";

import { container } from "../container";
import { env } from "../env";
import { platform } from "../platform";

const utcTime = (d: Date) =>
  `${new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d)} UTC`;

/**
 * Tells the person an app password was created for their mailbox: an app password opens the mailbox's mail on its
 * own, so they should know (and revoke it if it wasn't them). The name and mailbox only, never the secret. Sent to
 * their console sign-in address, not into the mailbox the new password can read.
 */
export async function sendAppPasswordNotice(to: string, accountId: string, created: CreatedAppPassword): Promise<void> {
  const url = `${env().APP_URL.replace(/\/$/, "")}/accounts/${encodeURIComponent(accountId)}/app-passwords`;
  try {
    await container().mailer.send(
      systemEmail({
        to,
        subject: "An app password was created for your mailbox",
        preheader: "Mail apps can use it to read or send mail. If this wasn't you, revoke it now.",
        greeting: "Hi,",
        lines: [
          `An app password was created for ${created.address} on ${utcTime(created.appPassword.createdAt)}. Mail apps can use it to read or send mail for this mailbox.`,
        ],
        facts: [{ label: "Name given:", value: created.appPassword.name }],
        closing: "If this wasn't you, revoke it now and change your console password.",
        action: { label: "Review app passwords", url },
        reason: "We send this whenever an app password is created, so you always know.",
        site: platform().hosts.site,
      }),
    );
  } catch (err) {
    // The app password exists either way; log only the error's name (no addresses).
    log.error("app password notice failed", {
      component: "app-passwords",
      errorName: err instanceof Error ? err.name : "unknown",
    });
  }
}
