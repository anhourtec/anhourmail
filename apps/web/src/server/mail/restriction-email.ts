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
 * The sending restriction notice (ADR-0034 §5, build slice 19): to an account's Owners and administrators when Trust &
 * Safety restricts the account's sending, or one mailbox's. Transactional only (rule 62), from the platform's no-reply
 * sender like every other system email. It says what was restricted, the reason category in plain words, what still
 * works and where to appeal — never staff's internal note, a threshold or a signal (rule 33), and never mail content.
 * The trust service decides who gets it and records `trust.restriction_notice_sent` (at most one per account per day).
 */
export function restrictionEmail(input: {
  to: string;
  restricted: "account" | "mailbox";
  /** The restricted mailbox's address (for a mailbox restriction): the customer's own, shown in the facts (mono). */
  address?: string | null;
  reason: SuspensionReason;
  consoleUrl: string;
  site: string;
}): MailMessage {
  const account = input.restricted === "account";
  const what = account ? "your AnhourMail account" : "one of your AnhourMail mailboxes";
  return systemEmail({
    to: input.to,
    subject: account
      ? "Sending from your AnhourMail account is paused"
      : "Sending from one of your mailboxes is paused",
    preheader: `Reason: ${SUSPENSION_REASONS[input.reason]}. Receiving and reading mail keep working. Here's how to appeal.`,
    greeting: "Hi,",
    lines: [
      `Anhourtec has paused sending from ${what} while we review unusual activity.`,
      account
        ? "Its mailboxes can't send mail for now, and their forwarding and automatic replies are paused too. Receiving and reading mail keep working, and your stored mail is kept."
        : "That mailbox can't send mail for now, and its forwarding and automatic replies are paused too. Receiving and reading mail keep working, and your stored mail is kept.",
      `If you think this is a mistake, email ${SUPPORT_EMAIL} from this address and tell us why. A person reads every appeal.`,
    ],
    facts: [
      ...(!account && input.address ? [{ label: "Mailbox:", value: input.address }] : []),
      { label: "Reason:", value: SUSPENSION_REASONS[input.reason] },
    ],
    action: { label: "Open the console", url: input.consoleUrl },
    reason: "We send this when Anhourtec pauses sending for an account you're responsible for.",
    site: input.site,
  });
}

/** Sends the restriction notice to each address; one failure never stops the others (logged by error name only). */
export async function sendRestrictionNotices(
  to: readonly string[],
  input: { restricted: "account" | "mailbox"; address?: string | null; reason: SuspensionReason },
): Promise<void> {
  const consoleUrl = env().APP_URL.replace(/\/$/, "");
  for (const address of to) {
    try {
      await container().mailer.send(
        restrictionEmail({ to: address, ...input, consoleUrl, site: platform().hosts.site }),
      );
    } catch (err) {
      log.error("restriction notice failed", {
        component: "trust",
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}
