// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import type { MailMessage } from "@anhourmail/adapters/mail";
import { systemEmail } from "@anhourmail/adapters/mail/layout";
import { log } from "@anhourmail/server/log";
import { SUPPORT_EMAIL, SUSPENSION_REASONS, type SuspensionReason } from "@anhourmail/shared/platform";

import { container } from "../container";
import { env } from "../env";
import { platform } from "../platform";

/**
 * Suspension notices (`platform.account.suspend`): to an account's Owners and administrators when staff suspend or
 * restore the account, or to the person when staff suspend or restore their sign-in. The reason category in plain
 * words, what still holds (mail is kept) and how to appeal — never staff's internal note, never the account name in a
 * sentence (people choose it).
 */
export function suspensionEmail(input: {
  to: string;
  subject: "account" | "person";
  state: "suspended" | "restored";
  reason: SuspensionReason;
  consoleUrl: string;
  site: string;
}): MailMessage {
  const what = input.subject === "account" ? "Your AnhourMail account" : "Your AnhourMail sign-in";
  if (input.state === "restored") {
    return systemEmail({
      to: input.to,
      subject: `${what} has been restored`,
      preheader: "The suspension was lifted. Everything works again.",
      greeting: "Hi,",
      lines: [
        `${what} is no longer suspended. You can sign in again, and mailboxes that were suspended with it are coming back on — it takes a minute or two.`,
        "Mail sent to those mailboxes while they were suspended was returned to its senders and wasn't kept.",
      ],
      action: { label: "Open the console", url: input.consoleUrl },
      note: `Questions? Email ${SUPPORT_EMAIL}.`,
      reason: "We send this when Anhourtec lifts a suspension on your account or sign-in.",
      site: input.site,
    });
  }
  return systemEmail({
    to: input.to,
    subject: `${what} has been suspended`,
    preheader: `Reason: ${SUSPENSION_REASONS[input.reason]}. Your mail is kept. Here's how to appeal.`,
    greeting: "Hi,",
    lines: [
      input.subject === "account"
        ? "Anhourtec has suspended your AnhourMail account. Its mailboxes can't sign in, send or receive mail, and the console shows only a notice until the suspension is lifted."
        : "Anhourtec has suspended your AnhourMail sign-in. You can't sign in to the console, and the mailboxes assigned to you can't sign in, send or receive mail until the suspension is lifted.",
      "Your stored mail is kept. Mail sent to suspended mailboxes is returned to its senders.",
      `If you think this is a mistake, email ${SUPPORT_EMAIL} from this address and tell us why. A person reads every appeal.`,
    ],
    facts: [{ label: "Reason:", value: SUSPENSION_REASONS[input.reason] }],
    action: {
      label: input.subject === "account" ? "Open the console" : "See the sign-in notice",
      url: input.subject === "account" ? input.consoleUrl : `${input.consoleUrl}/sign-in`,
    },
    reason: "We send this when Anhourtec suspends an account or sign-in you're responsible for.",
    site: input.site,
  });
}

/** Sends a suspension notice to each address; one failure never stops the others (logged by error name only). */
export async function sendSuspensionNotices(
  to: readonly string[],
  input: { subject: "account" | "person"; state: "suspended" | "restored"; reason: SuspensionReason },
): Promise<void> {
  const consoleUrl = env().APP_URL.replace(/\/$/, "");
  for (const address of to) {
    try {
      await container().mailer.send(
        suspensionEmail({ to: address, ...input, consoleUrl, site: platform().hosts.site }),
      );
    } catch (err) {
      log.error("suspension notice failed", {
        component: "suspension",
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}
