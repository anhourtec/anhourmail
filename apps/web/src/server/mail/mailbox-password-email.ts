// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { log } from "@anhourmail/server/log";

import { container } from "../container";
import { env } from "../env";
import { systemEmail } from "./system-email";

const utcTime = (d: Date) =>
  `${new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d)} UTC`;

/**
 * Tells the person a mailbox belongs to that its password was set from the console (an admin's reset, or their own
 * from the console): a new password opens the mailbox's mail, so they should know, and their webmail sessions end.
 * The mailbox and the time only, never the password. Sent to their console sign-in address, not into the mailbox.
 */
export async function sendMailboxPasswordResetNotice(
  to: string,
  /** `admin`: someone else set it in the console; `self`: the person in the console; `webmail`: their own change. */
  input: { address: string; by: "admin" | "self" | "webmail"; at: Date },
): Promise<void> {
  const url = env().WEBMAIL_URL.replace(/\/$/, "");
  try {
    await container().mailer.send(
      systemEmail({
        to,
        subject: "Your mailbox password was changed",
        greeting: "Hi,",
        lines: [
          input.by === "webmail"
            ? `The password for ${input.address} was changed in the webmail on ${utcTime(input.at)}.`
            : input.by === "self"
              ? `You set a new password for ${input.address} in the console on ${utcTime(input.at)}.`
              : `An administrator of your account set a new password for ${input.address} on ${utcTime(input.at)}.`,
          input.by === "webmail"
            ? "Other webmail sessions for this mailbox are signed out. App passwords for mail apps keep working."
            : "Webmail sessions for this mailbox are signed out. App passwords for mail apps keep working.",
        ],
        closing:
          input.by !== "admin"
            ? "If this wasn't you, change your console password and ask an owner or admin of your account to set a new mailbox password now."
            : "Ask the administrator for the new password, or if you didn't expect this, contact them and an owner of your account.",
        action: { label: "Open the webmail", url },
        footer: "We send this whenever a mailbox password changes, so you always know.",
      }),
    );
  } catch (err) {
    // The password is set either way; log only the error's name (no addresses).
    log.error("mailbox password notice failed", {
      component: "mailboxes",
      errorName: err instanceof Error ? err.name : "unknown",
    });
  }
}
