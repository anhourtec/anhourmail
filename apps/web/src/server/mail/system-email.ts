// SPDX-License-Identifier: AGPL-3.0-only
import type { MailMessage } from "@anhourmail/adapters/mail";
import { systemEmail } from "@anhourmail/adapters/mail/layout";

/*
 * The console's and webmail's system emails, all in the one shared layout (`@anhourmail/adapters/mail/layout`; its
 * rules are in branding.md "Transactional email"). Each takes `site`, the deployment's public site host
 * (`platform().hosts.site`), for the footer link.
 */

const hello = (name?: string) => (name && name.trim() !== "" ? `Hi ${name.trim()},` : "Hi,");

export function passwordResetEmail(input: { to: string; name: string; url: string; site: string }): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "Reset your AnhourMail password",
    preheader: "Use this link within an hour to choose a new password.",
    greeting: hello(input.name),
    lines: [
      "Someone asked to reset the password for your AnhourMail account. If it was you, use this link within an hour.",
      "Every other signed-in session will be signed out once the password changes.",
    ],
    action: { label: "Reset your password", url: input.url },
    note: "If you didn't ask, ignore this email — your password stays the same.",
    reason: "You got this email because a password reset was asked for on the AnhourMail login for this address.",
    site: input.site,
  });
}

/**
 * Confirms the console sign-in address (sent at sign-up and when the person asks again). A confirmed address is what
 * a free platform address needs; the link works for `hours`.
 */
export function emailVerificationEmail(input: { to: string; url: string; hours: number; site: string }): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "Confirm your email address for AnhourMail",
    preheader: `Confirm this address to finish setting up your account. The link works for ${String(input.hours)} hours.`,
    // Plain greeting, like the invite: the sign-up name is whatever anyone typed for someone else's address.
    greeting: "Hi,",
    lines: [
      "Confirm that this is your email address to finish setting up your AnhourMail account.",
      `The link works for ${String(input.hours)} hours.`,
    ],
    action: { label: "Confirm your email address", url: input.url },
    note: "If you didn't sign up for AnhourMail, ignore this email — nothing happens unless you confirm.",
    reason: "You got this email because this address was used to sign up for AnhourMail.",
    site: input.site,
  });
}

/**
 * An invite to join an account. The link is single-use, bound to this address, and expires after `days`. The inviter's
 * display name and the account name are chosen by people, not by us, so they are never part of a sentence: they are
 * shown as quoted mono facts, which reads as data and can't pose as our own wording (XSS audit run-28 C2).
 */
export function inviteEmail(input: {
  to: string;
  accountName: string;
  inviter: string;
  role: string;
  url: string;
  days: number;
  site: string;
}): MailMessage {
  return systemEmail({
    to: input.to,
    // Generic on purpose: the subject is what spam filters and previews show, so no inviter-chosen text in it.
    subject: "You've been invited to an AnhourMail account",
    // Generic for the same reason as the subject.
    preheader: `Accept within ${String(input.days)} days. The link works once, for this address only.`,
    greeting: "Hi,",
    lines: [
      `You've been invited to join an account on AnhourMail as ${input.role}.`,
      `The link works once, for this address only, for ${String(input.days)} days.`,
    ],
    facts: [
      { label: "Account:", value: input.accountName },
      { label: "Invited by:", value: input.inviter },
    ],
    action: { label: "Accept the invite", url: input.url },
    note: "If you weren't expecting this, ignore this email — nothing happens unless you accept.",
    reason: "You got this email because someone invited this address to an AnhourMail account.",
    site: input.site,
  });
}

/**
 * Sent when a passkey is added to someone's console login: with the password it signs them in, so they should know. Shows
 * the name given (quoted, mono) and when; never any key material.
 */
export function passkeyAddedEmail(input: {
  to: string;
  passkeyName: string;
  at: Date;
  securityUrl: string;
  site: string;
}): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "A passkey was added to your AnhourMail login",
    preheader: "Together with your password, it can sign you in. If this wasn't you, remove it.",
    greeting: hello(),
    lines: [
      `A passkey was added to your AnhourMail console login on ${utcTime(input.at)}. Together with your password, it can sign you in as the second step.`,
    ],
    facts: [{ label: "Name given:", value: input.passkeyName }],
    closing: "If this wasn't you, remove it and change your password on your Security page.",
    action: { label: "Open your Security page", url: input.securityUrl },
    reason: "We send this whenever a passkey is added, so you always know.",
    site: input.site,
  });
}

const utcTime = (d: Date) =>
  `${new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d)} UTC`;

/**
 * Sent when someone sets up their first sign-in factor while an account requires one: to them, and to that account's
 * Owners, so a takeover after a password reset is visible.
 */
export function firstFactorEmail(input: {
  to: string;
  person: string;
  accountName: string | null;
  factor: "totp" | "passkey";
  at: Date;
  securityUrl: string;
  forOwner: boolean;
  site: string;
}): MailMessage {
  const what = input.factor === "passkey" ? "a passkey" : "an authenticator app";
  const where = input.accountName ? ` (required by ${input.accountName})` : "";
  return systemEmail({
    to: input.to,
    subject: input.forOwner
      ? "Someone in your account set up two-step sign-in"
      : "Two-step sign-in was set up on your login",
    preheader: input.forOwner
      ? "Check with them if you weren't expecting it."
      : "If this wasn't you, change your password now.",
    greeting: hello(),
    lines: input.forOwner
      ? [
          `${input.person} set up ${what} for signing in on ${utcTime(input.at)}${where}.`,
          "If you weren't expecting this, check with them: it could mean someone else got into their login.",
        ]
      : [
          `${what.charAt(0).toUpperCase()}${what.slice(1)} was set up for signing in to your AnhourMail login on ${utcTime(input.at)}${where}.`,
        ],
    ...(input.forOwner
      ? {}
      : { closing: "If this wasn't you, change your password and check your Security page now." }),
    action: { label: "Open the Security page", url: input.securityUrl },
    reason: "We send this the first time someone sets up a sign-in factor while their account requires one.",
    site: input.site,
  });
}

/**
 * Sent when all of someone's passkeys were removed (a password reset with "also remove all passkeys", or "sign out
 * everywhere else" with it): to them, and to the Owners of their accounts, so a takeover that strips the second step is
 * visible.
 */
export function passkeysRemovedEmail(input: {
  to: string;
  person: string;
  accountName: string | null;
  count: number;
  at: Date;
  securityUrl: string;
  forOwner: boolean;
  site: string;
}): MailMessage {
  const what = input.count === 1 ? "passkey was" : `${String(input.count)} passkeys were`;
  const where = input.accountName ? ` (in ${input.accountName})` : "";
  return systemEmail({
    to: input.to,
    subject: input.forOwner
      ? "Someone in your account removed their passkeys"
      : "The passkeys on your AnhourMail login were removed",
    preheader: input.forOwner
      ? "Check with them if you weren't expecting it."
      : "If this wasn't you, change your password now.",
    greeting: hello(),
    lines: input.forOwner
      ? [
          `All of ${input.person}'s passkeys were removed on ${utcTime(input.at)}${where}.`,
          "If you weren't expecting this, check with them: it could mean someone else got into their login.",
        ]
      : [`Your ${what} removed from your AnhourMail console login on ${utcTime(input.at)}.`],
    ...(input.forOwner ? {} : { closing: "If this wasn't you, reset your password and check your Security page now." }),
    action: { label: "Open the Security page", url: input.securityUrl },
    reason: "We send this whenever every passkey is removed from a login.",
    site: input.site,
  });
}

/**
 * Asks the owner of an address to confirm a mailbox may forward its mail there. Nothing is forwarded until they do;
 * the mailbox owner then turns forwarding on. The link opens a page with a button (a link scanner can't confirm).
 */
export function forwardingConfirmEmail(input: {
  to: string;
  mailbox: string;
  url: string;
  hours: number;
  site: string;
}): MailMessage {
  return systemEmail({
    to: input.to,
    // Generic: no text the mailbox owner chose.
    subject: "Confirm mail forwarding to this address",
    preheader: "Nothing is forwarded to you unless you confirm.",
    greeting: hello(),
    lines: [
      "An AnhourMail mailbox asked to forward its mail to this address. Nothing is forwarded unless you confirm.",
      `The link works once, for ${String(input.hours)} hours.`,
    ],
    facts: [{ label: "Mailbox:", value: input.mailbox }],
    action: { label: "Review and confirm", url: input.url },
    note: "If you don't know this mailbox, ignore this email — no mail will be forwarded to you.",
    reason: "You got this email because an AnhourMail mailbox asked to forward its mail to this address.",
    site: input.site,
  });
}
