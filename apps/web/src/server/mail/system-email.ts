// SPDX-License-Identifier: AGPL-3.0-only
import type { MailMessage } from "@anhourmail/adapters/mail";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/**
 * One plain layout for AnhourMail's own system mail: text part first, a minimal HTML part with system fonts, one
 * button, no images, no tracking pixels, no rewritten links (privacy brand; branding.md "Transactional email").
 */
export function systemEmail(input: {
  to: string;
  subject: string;
  greeting: string;
  lines: string[];
  /** Labelled values shown quoted in mono (e.g. a name someone chose), after the lines. */
  facts?: { label: string; value: string }[];
  /** A last line just before the button. */
  closing?: string;
  action: { label: string; url: string };
  footer: string;
}): MailMessage {
  const facts = input.facts ?? [];
  const text = [
    input.greeting,
    "",
    ...input.lines,
    ...(facts.length > 0 ? ["", ...facts.map((f) => `${f.label} "${f.value}"`)] : []),
    ...(input.closing ? ["", input.closing] : []),
    "",
    `${input.action.label}: ${input.action.url}`,
    "",
    input.footer,
    "",
    "— AnhourMail",
  ].join("\n");
  const paragraphs = [
    ...input.lines.map((l) => `<p>${esc(l)}</p>`),
    ...facts.map(
      (f) =>
        `<p>${esc(f.label)} <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">&quot;${esc(f.value)}&quot;</code></p>`,
    ),
    ...(input.closing ? [`<p>${esc(input.closing)}</p>`] : []),
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f141e;line-height:1.5">
<p>${esc(input.greeting)}</p>
${paragraphs}
<p><a href="${esc(input.action.url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0077c8;color:#ffffff;text-decoration:none">${esc(input.action.label)}</a></p>
<p style="color:#475060;font-size:13px">${esc(input.footer)}</p>
</body></html>`;
  return { to: input.to, subject: input.subject, text, html };
}

const hello = (name?: string) => (name && name.trim() !== "" ? `Hi ${name.trim()},` : "Hi,");

export function passwordResetEmail(input: { to: string; name: string; url: string }): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "Reset your AnhourMail password",
    greeting: hello(input.name),
    lines: [
      "Someone asked to reset the password for your AnhourMail account. If it was you, use this link within an hour.",
      "Every other signed-in session will be signed out once the password changes.",
    ],
    action: { label: "Reset your password", url: input.url },
    footer: "If you didn't ask, ignore this email — your password stays the same.",
  });
}

/** An invite to join an account. The link is single-use, bound to this address, and expires after `days`. */
export function inviteEmail(input: {
  to: string;
  accountName: string;
  inviter: string;
  role: string;
  url: string;
  days: number;
}): MailMessage {
  return systemEmail({
    to: input.to,
    // Generic on purpose: the subject is what spam filters and previews show, so no inviter-chosen text in it.
    subject: "You've been invited to an AnhourMail account",
    greeting: "Hi,",
    lines: [
      `${input.inviter} invited you to join ${input.accountName} on AnhourMail as ${input.role}.`,
      `The link works once, for this address only, for ${String(input.days)} days.`,
    ],
    action: { label: "Accept the invite", url: input.url },
    footer: "If you weren't expecting this, ignore this email — nothing happens unless you accept.",
  });
}

/**
 * Sent when a passkey is added to someone's console login: a passkey signs in on its own, so they should know. Shows
 * the name given (quoted, mono) and when; never any key material.
 */
export function passkeyAddedEmail(input: {
  to: string;
  passkeyName: string;
  at: Date;
  securityUrl: string;
}): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "A passkey was added to your AnhourMail login",
    greeting: hello(),
    lines: [
      `A passkey was added to your AnhourMail console login on ${utcTime(input.at)}. It can sign you in without your password.`,
    ],
    facts: [{ label: "Name given:", value: input.passkeyName }],
    closing: "If this wasn't you, remove it and change your password on your Security page.",
    action: { label: "Open your Security page", url: input.securityUrl },
    footer: "We send this whenever a passkey is added, so you always know.",
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
}): MailMessage {
  const what = input.factor === "passkey" ? "a passkey" : "an authenticator app";
  const where = input.accountName ? ` (required by ${input.accountName})` : "";
  return systemEmail({
    to: input.to,
    subject: input.forOwner
      ? "Someone in your account set up two-step sign-in"
      : "Two-step sign-in was set up on your login",
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
    footer: "We send this the first time someone sets up a sign-in factor while their account requires one.",
  });
}
