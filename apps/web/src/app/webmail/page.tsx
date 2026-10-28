// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { FirstPasswordStep } from "@/components/webmail/first-password";
import { SIDEBAR_COOKIE, WebmailApp } from "@/components/webmail/webmail-app";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { settingsService, webmail, webmailCookieName } from "@/server/webmail/instance";
import { lastPasswordChangeFailed } from "@anhourmail/core/mailboxes";
import { DEFAULT_PREFERENCES } from "@anhourmail/shared/webmail";
import { trustedAuthservIds } from "@/server/webmail/original";
import { webmailBasePath } from "@/server/webmail/paths";
import { platform } from "@/server/platform";
import { WebmailBlockedError } from "@/server/webmail/service";

export const metadata: Metadata = { title: "Webmail" };

/**
 * The webmail (mail.* origin; `/webmail` on dev bare hosts). Signed-out visitors go to the sign-in form; the
 * session check here only reads our encrypted session record — mail is fetched by the client through the BFF.
 */
export default async function WebmailPage() {
  const base = webmailBasePath(
    (await headers()).get("host"),
    env().NODE_ENV === "production",
    process.env.WEBMAIL_DEV_PORT,
  );
  const jar = await cookies();
  const id = jar.get(webmailCookieName())?.value;
  let session = null;
  let blocked = false;
  try {
    session = id ? await webmail().session(id) : null;
  } catch (err) {
    // A suspended or deleted mailbox: the sign-in page says so. A mail-server outage: sign in again later.
    blocked = err instanceof WebmailBlockedError;
  }
  if (!session) redirect(`${base}/sign-in${blocked ? "?reason=unavailable" : ""}`);
  // Display preferences only (no mail): read here so the first paint already has the chosen layout.
  const [preferences, mailbox] = await Promise.all([
    settingsService()
      .preferences(session.username)
      .catch(() => DEFAULT_PREFERENCES),
    settingsService()
      .mailbox(session.username)
      .catch(() => null),
  ]);
  // "Add a user" with a first-sign-in password change: the new password comes before the inbox (the webmail API
  // refuses everything else meanwhile). It ends once the worker has applied the new password.
  if (mailbox?.mustChangePassword) {
    const lastFailed = await lastPasswordChangeFailed(container().deps, session.username).catch(() => false);
    return (
      <FirstPasswordStep
        address={session.username}
        account={session.accountId}
        signInHref={`${base}/sign-in`}
        lastFailed={lastFailed}
      />
    );
  }
  const app = env().APP_URL.replace(/\/$/, "");
  return (
    <WebmailApp
      username={session.username}
      signInHref={`${base}/sign-in`}
      helpHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/webmail`}
      consoleHref={mailbox ? `${app}/accounts/${mailbox.accountId}/aliases` : app}
      initialCollapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      initialPreferences={preferences}
      authservIds={trustedAuthservIds(env().MAIL_AUTHSERV_ID, platform().hosts.mx, env().NODE_ENV === "production")}
    />
  );
}
