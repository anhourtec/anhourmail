// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The first platform Global Administrator on a real server (deploy/README.md "First platform administrator"). The
 * job file `jobs/bootstrap-admin.ts` parses the command line and wires the adapters; this module does the work so
 * unit and integration tests can drive it. No password ever passes through here: the person gets a one-time link to
 * the console's "Choose a new password" page, by email, and the link is never logged or printed.
 */
import type { Mailer, MailMessage } from "@anhourmail/adapters/mail";
import type { Deps } from "@anhourmail/core";
import { bootstrapPlatformAdmin, SET_PASSWORD_LINK_MINUTES } from "@anhourmail/core/platform";
import type { Logger } from "@anhourmail/server/log";

export type BootstrapAdminInput = { email: string; firstName: string; lastName?: string };

/** `created`: login, role and email done. `refused`: nothing changed. `mail_failed`: created, but the email didn't go. */
export type BootstrapAdminResult = "created" | "refused" | "mail_failed";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

/** Plain system mail (same shape as the console's: text first, one button, no images or tracking). */
export function setPasswordEmail(input: { to: string; firstName: string; url: string; minutes: number }): MailMessage {
  const lines = [
    "An AnhourMail platform administrator login was created for this address.",
    `Choose your password with this link within ${String(input.minutes)} minutes. It works once.`,
    'After that, use "Forgot password" on the console sign-in page if you need a new link.',
  ];
  const greeting = `Hi ${input.firstName},`;
  const footer = "If you weren't expecting this, tell your team before using the link.";
  return {
    to: input.to,
    subject: "Set your AnhourMail administrator password",
    text: [greeting, "", ...lines, "", `Choose your password: ${input.url}`, "", footer, "", "— AnhourMail"].join("\n"),
    html: `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f141e;line-height:1.5">
<p>${esc(greeting)}</p>
${lines.map((l) => `<p>${esc(l)}</p>`).join("\n")}
<p><a href="${esc(input.url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#0077c8;color:#ffffff;text-decoration:none">Choose your password</a></p>
<p style="color:#475060;font-size:13px">${esc(footer)}</p>
</body></html>`,
  };
}

export async function runBootstrapAdmin(opts: {
  deps: Deps;
  mailer: Mailer;
  /** Console origin; the link goes to `<appUrl>/reset-password?token=…`. */
  appUrl: string;
  input: BootstrapAdminInput;
  log: Logger;
  requestId: string;
}): Promise<BootstrapAdminResult> {
  const { log } = opts;
  const out = await bootstrapPlatformAdmin(opts.deps, opts.input, {
    requestId: opts.requestId,
    ip: null,
    userAgent: "job:bootstrap-admin",
  });
  if (out.status === "refused") {
    log.warn(
      out.reason === "admin_exists"
        ? "bootstrap refused: a platform administrator already exists; nothing changed"
        : "bootstrap refused: that email already has a console login; nothing changed",
      { reason: out.reason },
    );
    return "refused";
  }
  const url = `${opts.appUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(out.token)}`;
  try {
    await opts.mailer.send(
      setPasswordEmail({
        to: out.email,
        firstName: opts.input.firstName.trim(),
        url,
        minutes: SET_PASSWORD_LINK_MINUTES,
      }),
    );
  } catch (err) {
    // The login exists either way; "Forgot password" on the console sends a new link once mail works.
    log.error("platform administrator created, but the set-password email failed", {
      userId: out.userId,
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return "mail_failed";
  }
  log.info("platform administrator created; set-password link emailed", {
    userId: out.userId,
    linkExpiresAt: out.expiresAt.toISOString(),
  });
  return "created";
}
