// SPDX-License-Identifier: AGPL-3.0-only
import { ACCOUNT_DELETION_GRACE_DAYS } from "@anhourmail/shared/data-lifecycle";

import type { MailMessage } from "./index";
import { systemEmail } from "./layout";

/*
 * Data export and account deletion emails (ADR-0025), shared by the console (requests, cancellations, a deleted login)
 * and the worker (an export ready, an account deleted). The shared system-email layout: text + minimal HTML, the inline
 * logo, no tracking. Account names are chosen by people, so they appear only as quoted mono facts, never in a sentence
 * or a subject (XSS audit run-28 C2). Links go to the console, never straight to a download (that needs a sign-in and
 * a fresh step-up).
 */

const utcDay = (d: Date) =>
  `${new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: "UTC" }).format(d)} (UTC)`;

/** The export the person asked for is ready to download until `expiresAt`. */
export function exportReadyEmail(input: {
  to: string;
  kind: "account" | "personal";
  expiresAt: Date;
  url: string;
  site: string;
}): MailMessage {
  const what = input.kind === "account" ? "account data export" : "personal data export";
  return systemEmail({
    to: input.to,
    subject: `Your AnhourMail ${what} is ready`,
    preheader: `Download it before ${utcDay(input.expiresAt)}. After that it is deleted.`,
    greeting: "Hi,",
    lines: [
      `The ${what} you asked for is ready. Sign in to the console to download it; you'll confirm it's you first.`,
      `It can be downloaded until ${utcDay(input.expiresAt)}, then we delete it.`,
      "Mail and contacts aren't in it: export them from the webmail (Settings, Export).",
    ],
    action: { label: "Open your exports", url: input.url },
    note: "If you didn't ask for this, change your password and review your sessions on the Security page.",
    reason: "You got this email because a data export was requested from your AnhourMail login.",
    site: input.site,
  });
}

/** Everyone in an account: an Owner asked to delete it. */
export function deletionScheduledEmail(input: {
  to: string;
  accountName: string;
  deleteAfter: Date;
  isOwner: boolean;
  url: string;
  site: string;
}): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "An AnhourMail account you belong to is scheduled for deletion",
    preheader: `It will be deleted on ${utcDay(input.deleteAfter)} unless an Owner cancels it.`,
    greeting: "Hi,",
    lines: [
      `An Owner of this account asked us to delete it. Its mailboxes are suspended now: they can't send, receive or be signed in to, but their mail is kept until the deletion.`,
      `On ${utcDay(input.deleteAfter)} the account, its mailboxes and all their mail, its aliases and its domains are removed for good. That can't be undone.`,
      input.isOwner
        ? `You can cancel it in Account settings until then (${String(ACCOUNT_DELETION_GRACE_DAYS)} days from the request). To keep a mailbox's mail, cancel, export it from the webmail, then ask again.`
        : "If you need mail from your mailbox, ask an Owner to cancel the deletion so you can export it from the webmail.",
    ],
    facts: [
      { label: "Account:", value: input.accountName },
      { label: "Deleted on:", value: utcDay(input.deleteAfter) },
    ],
    action: { label: input.isOwner ? "Open Account settings" : "Open the console", url: input.url },
    note: "If you didn't expect this, contact the account's Owner.",
    reason: "You got this email because you belong to this AnhourMail account.",
    site: input.site,
  });
}

/** Everyone in an account: the deletion was cancelled. */
export function deletionCancelledEmail(input: { to: string; accountName: string; url: string; site: string }) {
  return systemEmail({
    to: input.to,
    subject: "An AnhourMail account deletion was cancelled",
    preheader: "Nothing will be deleted. Its mailboxes are coming back on.",
    greeting: "Hi,",
    lines: [
      "An Owner cancelled the deletion of this account. Nothing will be deleted, and the mailboxes it suspended are coming back on (it takes a minute or two).",
      "Mail sent to them while they were suspended was returned to its senders and wasn't kept. A catch-all address that was turned off stays off until an admin turns it on again.",
    ],
    facts: [{ label: "Account:", value: input.accountName }],
    action: { label: "Open the console", url: input.url },
    reason: "You got this email because you belong to this AnhourMail account.",
    site: input.site,
  });
}

/** Everyone who was in an account: it has been deleted. */
export function accountDeletedEmail(input: { to: string; accountName: string; url: string; site: string }) {
  return systemEmail({
    to: input.to,
    subject: "An AnhourMail account was deleted",
    preheader: "Its mailboxes, mail, aliases and domains are gone. Your console login is kept.",
    greeting: "Hi,",
    lines: [
      "The account below has been deleted, as one of its Owners asked. Its mailboxes and their mail, its aliases and its domains are gone, and its people were removed from it.",
      "Your console login is kept, along with any other accounts you belong to. If you no longer need it, you can delete it from your Profile page.",
    ],
    facts: [{ label: "Account:", value: input.accountName }],
    action: { label: "Open the console", url: input.url },
    reason: "You got this email because you belonged to this AnhourMail account.",
    site: input.site,
  });
}

/** The person: their console login was deleted (sent after it's gone, to the address it had). */
export function loginDeletedEmail(input: { to: string; url: string; site: string }): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "Your AnhourMail login was deleted",
    preheader: "You asked us to delete it. Its sessions, sign-in methods and profile are gone.",
    greeting: "Hi,",
    lines: [
      "Your AnhourMail console login was deleted, as you asked. Its sessions, sign-in methods, profile and photo are gone, and you were removed from your accounts.",
      "You can sign up again with this address at any time; nothing from the old login comes back.",
    ],
    action: { label: "Visit AnhourMail", url: input.url },
    note: "If you didn't do this, contact support straight away.",
    reason: "You got this email because the AnhourMail login for this address was deleted.",
    site: input.site,
  });
}
