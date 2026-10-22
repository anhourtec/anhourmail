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
  action: { label: string; url: string };
  footer: string;
}): MailMessage {
  const text = [
    input.greeting,
    "",
    ...input.lines,
    "",
    `${input.action.label}: ${input.action.url}`,
    "",
    input.footer,
    "",
    "— AnhourMail",
  ].join("\n");
  const paragraphs = input.lines.map((l) => `<p>${esc(l)}</p>`).join("\n");
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
