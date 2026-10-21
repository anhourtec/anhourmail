// SPDX-License-Identifier: AGPL-3.0-only
import type { MailMessage } from "@anhourmail/adapters/mail";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/**
 * Password reset email. Plain text first; a minimal HTML part (system fonts, no images, no tracking — the full
 * 570 px transactional layout lands with the other system mail in phase 2, branding.md).
 */
export function passwordResetEmail(input: { to: string; name: string; url: string }): MailMessage {
  const hello = input.name.trim() === "" ? "Hi," : `Hi ${input.name.trim()},`;
  const text = `${hello}

Someone asked to reset the password for your AnhourMail account. If it was you, open this link within an hour:

${input.url}

If you didn't ask, ignore this email — your password stays the same. Every other signed-in session will be
signed out once the password changes.

— AnhourMail`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f141e">
<p>${esc(hello)}</p>
<p>Someone asked to reset the password for your AnhourMail account. If it was you, use this link within an hour:</p>
<p><a href="${esc(input.url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0077c8;color:#ffffff;text-decoration:none">Reset your password</a></p>
<p style="color:#475060;font-size:13px">If you didn't ask, ignore this email — your password stays the same.</p>
</body></html>`;
  return { to: input.to, subject: "Reset your AnhourMail password", text, html };
}
