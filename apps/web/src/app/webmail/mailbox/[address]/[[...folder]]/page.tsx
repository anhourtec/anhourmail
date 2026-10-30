// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { MailboxRefused, ScopedMailbox } from "@/components/webmail/shared-mailbox";
import { SIDEBAR_COOKIE } from "@/components/webmail/webmail-app";
import { FOLDER_ROLES } from "@/components/webmail/tab-paths";
import { env } from "@/server/env";
import { platform } from "@/server/platform";
import { signedNoticeReason } from "@/server/webmail/http";
import { passwordChangeGate, settingsService, webmail, webmailCookieName } from "@/server/webmail/instance";
import { trustedAuthservIds } from "@/server/webmail/original";
import { webmailBasePath } from "@/server/webmail/paths";
import { isPinAddress, navigationFromUs } from "@/server/webmail/pin";
import { WebmailBlockedError, WebmailDelegationRefusedError, type WebmailService } from "@/server/webmail/service";
import { isJmapId } from "@/server/webmail/view";
import { DEFAULT_PREFERENCES } from "@anhourmail/shared/webmail";
import type { WebmailRefusal } from "@anhourmail/core/webmail";

// The address is in the URL: never send it on as a referrer.
export const metadata: Metadata = { title: "Shared mailbox", referrer: "no-referrer" };

/** The session (refreshed when due), or null; a shared active mailbox whose grant went hands back to the person's own. */
async function sessionOf(svc: WebmailService, id: string) {
  try {
    return await svc.session(id);
  } catch (err) {
    if (err instanceof WebmailDelegationRefusedError) return svc.session(id);
    throw err;
  }
}

/**
 * A mailbox shared with the person, in a tab of its own (ADR-0026 §6, Open another mailbox): `/mailbox/<address>/`
 * on the webmail origin (`/webmail/mailbox/<address>/` on a dev bare host), optionally `/<folder>` (a role such as
 * `sent`, or a folder id). The page only reads our session record; the client opens the mailbox (the grant checked
 * now, the open audited) without switching what the person's other tabs show, then pins it on every request. No
 * access — no grant, an unknown address, another account's — is one full-page answer that confirms nothing.
 */
export default async function SharedMailboxPage({
  params,
}: {
  params: Promise<{ address: string; folder?: string[] }>;
}) {
  const { address: raw, folder } = await params;
  const h = await headers();
  const base = webmailBasePath(h.get("host"), env().NODE_ENV === "production", process.env.WEBMAIL_DEV_PORT);
  const home = base === "" ? "/" : base;
  const jar = await cookies();
  const id = jar.get(webmailCookieName())?.value;
  let session = null;
  let blocked: WebmailRefusal | null = null;
  try {
    session = id ? await sessionOf(webmail(), id) : null;
  } catch (err) {
    if (err instanceof WebmailBlockedError) blocked = err.reason;
  }
  if (!session || !id) {
    const reason = blocked ? `?reason=${signedNoticeReason(env().BETTER_AUTH_SECRET, blocked)}` : "";
    redirect(`${base}/sign-in${reason}`);
  }

  let address = "";
  try {
    address = decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    address = "";
  }
  // Not an address: the same refusal, without echoing whatever the link carried.
  if (!isPinAddress(address)) return <MailboxRefused ownHref={home} />;

  const entries = [session, ...(session.others ?? [])];
  // One of the person's own mailboxes: that is the ordinary webmail, not a shared one.
  if (entries.some((m) => !m.delegated && m.username.toLowerCase() === address)) redirect(home);
  const own = session.delegated?.via ?? session.username;
  // The person's own first-sign-in password change comes before any mail (the webmail page shows that step).
  if (await passwordChangeGate().required(own)) redirect(home);

  // Open already for reading and managing (a send-opened entry is checked and marked by the open first).
  const opened = entries.some((m) => m.delegated?.opened === "full_access" && m.username.toLowerCase() === address);
  // Opening mints a mail-server credential, is audited and counts against the open limit: it starts by itself only
  // when the navigation came from us (Open another mailbox, our own site, or the person's address bar or bookmark).
  // A link from another site waits for a click.
  const fromUs = navigationFromUs(h.get("sec-fetch-site"));
  const [segment] = folder ?? [];
  const named =
    segment !== undefined && ((FOLDER_ROLES as readonly string[]).includes(segment) || isJmapId(segment))
      ? segment
      : undefined;
  // Display preferences are the person's own (no mail is read here).
  const preferences = await settingsService()
    .preferences(own)
    .catch(() => DEFAULT_PREFERENCES);
  return (
    <ScopedMailbox
      address={address}
      folder={named}
      ownHref={home}
      opened={opened}
      autoOpen={fromUs}
      signInHref={`${base}/sign-in`}
      helpHref={`${env().SITE_URL.replace(/\/$/, "")}/docs/webmail`}
      consoleHref={env().APP_URL.replace(/\/$/, "")}
      initialCollapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      initialPreferences={preferences}
      authservIds={trustedAuthservIds(env().MAIL_AUTHSERV_ID, platform().hosts.mx, env().NODE_ENV === "production")}
    />
  );
}
