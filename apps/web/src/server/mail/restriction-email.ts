// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import type { MailMessage } from "@anhourmail/adapters/mail";
import { systemEmail } from "@anhourmail/adapters/mail/layout";
import type { RequestMeta } from "@anhourmail/core";
import { recordRestrictionNoticeFailed, type RestrictionNotice } from "@anhourmail/core/trust";
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
 * The trust service decides who gets it and records `trust.restriction_notice_sent` (at most one per account and kind
 * — account or mailbox — per day); `sendRestrictionNotices` sends it with retries.
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

/**
 * Waits before each retry of one address (bounded: three tries over about 35 s, so a mail server that restarts or
 * refuses for a moment still gets the notice; there is no web-to-worker mail queue to hand it to).
 */
export const RESTRICTION_NOTICE_RETRY_MS: readonly number[] = [5_000, 30_000];

let retryDelays: readonly number[] = RESTRICTION_NOTICE_RETRY_MS;

/** Tests: shorter waits (null restores the default). */
export function setRestrictionNoticeRetryForTests(delays: readonly number[] | null): void {
  retryDelays = delays ?? RESTRICTION_NOTICE_RETRY_MS;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/**
 * Sends the restriction notice to each address the trust service named, retrying each one with bounded backoff
 * (`RESTRICTION_NOTICE_RETRY_MS`); one failure never stops the others. When it gives up on any of them it records
 * `trust.restriction_notice_failed` with the counts (`recordRestrictionNoticeFailed`), which frees the day's cap when
 * nobody got it. Never throws, so a route may run it after answering. Logs counts and error names only, never an
 * address. Resolves with how many were delivered.
 */
export async function sendRestrictionNotices(
  notice: RestrictionNotice | null,
  to: readonly string[],
  input: { address?: string | null; reason: SuspensionReason },
  req: RequestMeta,
): Promise<{ delivered: number; failed: number }> {
  if (!notice || to.length === 0) return { delivered: 0, failed: 0 };
  const l = log.child({ component: "trust", requestId: req.requestId });
  let delivered = 0;
  try {
    const consoleUrl = env().APP_URL.replace(/\/$/, "");
    const site = platform().hosts.site;
    for (const address of to) {
      const message = restrictionEmail({ to: address, restricted: notice.restricted, ...input, consoleUrl, site });
      for (let attempt = 0; ; attempt++) {
        try {
          await container().mailer.send(message);
          delivered += 1;
          break;
        } catch (err) {
          const delay = retryDelays[attempt];
          const errorName = err instanceof Error ? err.name : "unknown";
          if (delay === undefined) {
            l.error("restriction notice failed", { errorName, attempts: attempt + 1 });
            break;
          }
          l.warn("restriction notice retrying", { errorName, attempt: attempt + 1 });
          await wait(delay);
        }
      }
    }
  } catch (err) {
    l.error("restriction notice failed", { errorName: err instanceof Error ? err.name : "unknown" });
  }
  const failed = to.length - delivered;
  if (failed > 0) {
    try {
      await recordRestrictionNoticeFailed(container().deps, notice, { notified: to.length, delivered }, req);
    } catch (err) {
      l.error("restriction notice failure not recorded", { errorName: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { delivered, failed };
}
