// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Transactional mail (password resets, invites, waitlist confirmations) — adapter around nodemailer.
 * MAIL_TRANSPORT_URL: dev = Mailpit (smtp://127.0.0.1:43125, nothing leaves the machine — CLAUDE.md rule 19);
 * production = submission to our own Stalwart as the no-reply system mailbox (credentials from the private ops repo).
 * Never logs bodies or recipients (rule 24).
 */
import nodemailer, { type Transporter } from "nodemailer";

export type MailMessage = { to: string; subject: string; text: string; html: string };
export type Mailer = { send(message: MailMessage): Promise<void> };

export function createMailer(opts: { url: string; from: string }): Mailer {
  const transport: Transporter = nodemailer.createTransport(opts.url);
  return {
    async send(message) {
      await transport.sendMail({ from: opts.from, ...message });
    },
  };
}

/** Test/dev double: keeps messages in memory. */
export function memoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send: async (m) => {
      sent.push(m);
    },
  };
}
