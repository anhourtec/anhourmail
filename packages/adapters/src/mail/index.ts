// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Transactional mail (password resets and other system emails) — adapter around nodemailer.
 * MAIL_TRANSPORT_URL: dev = Mailpit (smtp://127.0.0.1:43125, nothing leaves the machine — CLAUDE.md rule 19);
 * production = submission to our own Stalwart as the no-reply system mailbox (credentials from the private ops repo).
 * Never logs bodies or recipients (rule 24).
 */
import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

/**
 * An inline image the HTML part shows by `cid:` (the email logo): carried in the message, never fetched from a URL, so
 * opening a system email makes no remote request (CLAUDE.md rule 29).
 */
export type MailAttachment = { filename: string; contentType: string; /** Base64. */ content: string; cid: string };
export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: readonly MailAttachment[];
};
export type Mailer = { send(message: MailMessage): Promise<void> };

/** The only query keys a transport URL may carry. Anything else (e.g. `logger`, `debug`) is refused. */
const BOOL_KEYS = ["secure", "requireTLS", "tls.rejectUnauthorized"] as const;
const QUERY_KEYS = new Set<string>([...BOOL_KEYS, "tls.servername"]);

const bool = (key: string, v: string): boolean => {
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`MAIL_TRANSPORT_URL: ${key} must be true or false`);
};

/**
 * Explicit SMTP options from MAIL_TRANSPORT_URL (`smtp://` or `smtps://`, optional `user:password@`, and only the
 * query keys above). Built by hand rather than handing the URL to nodemailer, whose URL parser also accepts `logger`
 * and `debug` and would then write SMTP transcripts — credentials and message content — to stdout. Logging is
 * always off. Error messages name the problem, never the URL (it holds the password).
 */
export function mailTransportOptions(url: string): SMTPTransport.Options {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("MAIL_TRANSPORT_URL is not a valid URL");
  }
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") {
    throw new Error("MAIL_TRANSPORT_URL must start with smtp:// or smtps://");
  }
  if (u.hostname === "") throw new Error("MAIL_TRANSPORT_URL has no host");
  const opts: SMTPTransport.Options = {
    host: u.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: u.port === "" ? (u.protocol === "smtps:" ? 465 : 587) : Number(u.port),
    secure: u.protocol === "smtps:",
    logger: false,
    debug: false,
  };
  if (u.username !== "" || u.password !== "") {
    opts.auth = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
  }
  const tls: { servername?: string; rejectUnauthorized?: boolean } = {};
  for (const [key, value] of u.searchParams) {
    if (!QUERY_KEYS.has(key)) throw new Error(`MAIL_TRANSPORT_URL: query option "${key}" is not supported`);
    if (key === "secure") opts.secure = bool(key, value);
    else if (key === "requireTLS") opts.requireTLS = bool(key, value);
    else if (key === "tls.rejectUnauthorized") tls.rejectUnauthorized = bool(key, value);
    else tls.servername = value;
  }
  if (Object.keys(tls).length > 0) opts.tls = tls;
  return opts;
}

/** What nodemailer is given for one message: inline attachments decoded from base64 and marked inline. */
export function sendMailOptions(from: string, message: MailMessage): SendMailOptions {
  const { attachments, ...rest } = message;
  return {
    from,
    ...rest,
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: a.content,
            encoding: "base64",
            cid: a.cid,
            contentDisposition: "inline" as const,
          })),
        }
      : {}),
  };
}

export function createMailer(opts: { url: string; from: string }): Mailer {
  const transport: Transporter = nodemailer.createTransport(mailTransportOptions(opts.url));
  return {
    async send(message) {
      await transport.sendMail(sendMailOptions(opts.from, message));
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
