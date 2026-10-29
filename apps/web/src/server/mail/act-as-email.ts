// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import type { MailMessage } from "@anhourmail/adapters/mail";
import { systemEmail } from "@anhourmail/adapters/mail/layout";
import { log } from "@anhourmail/server/log";
import { ACT_AS, SUPPORT_EMAIL } from "@anhourmail/shared/platform";

import { container } from "../container";
import { env } from "../env";
import { platform } from "../platform";

const whenFmt = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/**
 * "Anhourtec support opened your account" (ADR-0023): to the account's Owners when staff start support access. What
 * it allows (read-only, no mail), how long, the reason staff gave and where every step is recorded (their audit log).
 * Never the account name in a sentence (people choose it), no tracking (the system layout has none).
 */
export function actAsEmail(input: {
  to: string;
  reason: string;
  startedAt: Date;
  /** The account's audit log in the console. */
  auditUrl: string;
  site: string;
}): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "Anhourtec support opened your AnhourMail account",
    preheader: `Read-only, for up to ${String(ACT_AS.minutes)} minutes. Everything they do is in your audit log.`,
    greeting: "Hi,",
    lines: [
      `A member of the Anhourtec support team opened your AnhourMail account in the console, read-only, for up to ${String(ACT_AS.minutes)} minutes. They can see your settings, people, domains and mailboxes, but can't change anything, sign in to webmail or read your mail.`,
      "Every step is recorded in your account's audit log as Anhourtec staff, with the reason below.",
      `If you didn't ask us for help, email ${SUPPORT_EMAIL} and tell us. A person reads every message.`,
    ],
    facts: [
      { label: "Reason they gave:", value: input.reason },
      { label: "Started (UTC):", value: whenFmt.format(input.startedAt) },
    ],
    action: { label: "See your audit log", url: input.auditUrl },
    reason: "We send this to an account's Owners whenever Anhourtec support opens the account.",
    site: input.site,
  });
}

/** Emails each Owner; one failure never stops the others or the start (logged by error name only). */
export async function sendActAsNotices(
  to: readonly string[],
  input: { accountId: string; reason: string; startedAt: Date },
): Promise<void> {
  const auditUrl = `${env().APP_URL.replace(/\/$/, "")}/accounts/${encodeURIComponent(input.accountId)}/audit`;
  for (const address of to) {
    try {
      await container().mailer.send(
        actAsEmail({
          to: address,
          reason: input.reason,
          startedAt: input.startedAt,
          auditUrl,
          site: platform().hosts.site,
        }),
      );
    } catch (err) {
      log.error("act-as notice failed", {
        component: "act-as",
        errorName: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}
