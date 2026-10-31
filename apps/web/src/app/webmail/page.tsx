// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { FirstPasswordStep } from "@/components/webmail/first-password";
import { SIDEBAR_COOKIE, WebmailApp } from "@/components/webmail/webmail-app";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { signedNoticeReason } from "@/server/webmail/http";
import { settingsService, webmail, webmailCookieName } from "@/server/webmail/instance";
import { lastPasswordChangeFailed } from "@anhourmail/core/mailboxes";
import type { WebmailRefusal } from "@anhourmail/core/webmail";
import { DEFAULT_PREFERENCES } from "@anhourmail/shared/webmail";
import { trustedAuthservIds } from "@/server/webmail/original";
import { webmailBasePath } from "@/server/webmail/paths";
import { platform } from "@/server/platform";
import { WebmailBlockedError } from "@/server/webmail/service";
import { mailboxTabHref } from "@/components/webmail/tab-paths";
import { pageFirstLoad } from "@/server/webmail/page-first-load";
import { clientIp } from "@anhourmail/server/client-ip";

export const metadata: Metadata = { title: "Webmail" };

/**
 * The webmail (mail.* origin; `/webmail` on dev bare hosts). Signed-out visitors go to the sign-in form. Once the
 * session has been checked here, the first view (folders and the opened view's first window, summaries only) is
 * fetched through the BFF on the server and streamed inside the page; everything after that the client fetches
 * through the BFF.
 */
export default async function WebmailPage() {
  const requestHeaders = await headers();
  const base = webmailBasePath(
    requestHeaders.get("host"),
    env().NODE_ENV === "production",
    process.env.WEBMAIL_DEV_PORT,
  );
  const jar = await cookies();
  const id = jar.get(webmailCookieName())?.value;
  let session = null;
  let blocked: WebmailRefusal | null = null;
  try {
    session = id ? await webmail().session(id) : null;
  } catch (err) {
    // A suspended person or mailbox, or one being deleted or gone: the sign-in page says which. A mail-server
    // outage: sign in again later.
    if (err instanceof WebmailBlockedError) blocked = err.reason;
  }
  if (!session || !id) {
    const reason = blocked ? `?reason=${signedNoticeReason(env().BETTER_AUTH_SECRET, blocked)}` : "";
    redirect(`${base}/sign-in${reason}`);
  }
  // A mailbox shared with the person opens only in a tab of its own (Open another mailbox, `/mailbox/<address>/`;
  // ADR-0026 §6). A session still left on one (switched to it before) goes back to the person's own mailbox here, the
  // one it came through; if that can't be done, the shared mailbox is shown in its own tab instead.
  if (session.delegated) {
    const { via } = session.delegated;
    const shared = session.username;
    try {
      session = await webmail().switchMailbox(id, via);
    } catch {
      redirect(mailboxTabHref(base, shared));
    }
  }
  const own = session.username;
  // Display preferences only (no mail): read here so the first paint already has the chosen layout.
  const [preferences, mailbox] = await Promise.all([
    settingsService()
      .preferences(own)
      .catch(() => DEFAULT_PREFERENCES),
    settingsService()
      .mailbox(own)
      .catch(() => null),
  ]);
  // "Add a user" with a first-sign-in password change: the new password comes before the inbox (the webmail API
  // refuses everything else meanwhile). It ends once the worker has applied the new password.
  if (mailbox?.mustChangePassword) {
    const lastFailed = await lastPasswordChangeFailed(container().deps, own).catch(() => false);
    return (
      <FirstPasswordStep
        address={own}
        account={session.accountId}
        signInHref={`${base}/sign-in`}
        lastFailed={lastFailed}
      />
    );
  }
  const app = env().APP_URL.replace(/\/$/, "");
  // The app's first load (folders, counts and the opened view's first window), started now and streamed inside this
  // page: the inbox needs no request of its own once the app's code has loaded. Not awaited, so the page itself isn't
  // held up; null (the app then asks the first-load route) when over the budget or the mail server didn't answer.
  // The key for this browser's encrypted copy of the first view: this session's, handed only to its own page.
  const viewKey = await webmail()
    .store.viewKey(id)
    .catch(() => null);
  const firstLoad = pageFirstLoad(id, clientIp(requestHeaders), session.username, {
    start: preferences.startIn,
    grouping: preferences.grouping,
    attachments: preferences.attachmentChips,
  });
  return (
    <WebmailApp
      username={session.username}
      signInHref={`${base}/sign-in`}
      helpHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/webmail`}
      consoleHref={mailbox ? `${app}/accounts/${mailbox.accountId}/aliases` : app}
      initialCollapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      initialPreferences={preferences}
      firstLoad={firstLoad}
      viewKey={viewKey}
      authservIds={trustedAuthservIds(env().MAIL_AUTHSERV_ID, platform().hosts.mx, env().NODE_ENV === "production")}
    />
  );
}
