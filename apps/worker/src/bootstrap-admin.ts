// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The first platform Global Administrator on a real server (deploy/README.md "First platform administrator"). The
 * job file `jobs/bootstrap-admin.ts` parses the command line and wires the adapters; this module does the work so
 * unit and integration tests can drive it. No password ever passes through here: the person gets a one-time link to
 * the console's "Choose a new password" page, by email, and the link is never logged or printed.
 */
import type { Mailer, MailMessage } from "@anhourmail/adapters/mail";
import { systemEmail } from "@anhourmail/adapters/mail/layout";
import type { Deps } from "@anhourmail/core";
import { bootstrapPlatformAdmin, SET_PASSWORD_LINK_MINUTES } from "@anhourmail/core/platform";
import type { Logger } from "@anhourmail/server/log";

export type BootstrapAdminInput = { email: string; firstName: string; lastName?: string };

/** `created`: login, role and email done. `refused`: nothing changed. `mail_failed`: created, but the email didn't go. */
export type BootstrapAdminResult = "created" | "refused" | "mail_failed";

/** The set-password email, in the shared system-email layout (branding.md "Transactional email"). */
export function setPasswordEmail(input: {
  to: string;
  firstName: string;
  url: string;
  minutes: number;
  /** The deployment's public site host (`platform.hosts.site`), for the footer link. */
  site: string;
}): MailMessage {
  return systemEmail({
    to: input.to,
    subject: "Set your AnhourMail administrator password",
    preheader: `Choose your password within ${String(input.minutes)} minutes. The link works once.`,
    greeting: `Hi ${input.firstName},`,
    lines: [
      "An AnhourMail platform administrator login was created for this address.",
      `Choose your password with this link within ${String(input.minutes)} minutes. It works once.`,
      'After that, use "Forgot password" on the console sign-in page if you need a new link.',
    ],
    action: { label: "Choose your password", url: input.url },
    note: "If you weren't expecting this, tell your team before using the link.",
    reason: "You got this email because an AnhourMail platform administrator login was created for this address.",
    site: input.site,
  });
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
        site: opts.deps.platform.hosts.site,
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
