// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { headers } from "next/headers";

import { AuthSplit } from "@/components/auth-split";
import { WebmailHandoff } from "@/components/webmail/handoff";
import { env } from "@/server/env";
import { webmailBasePath } from "@/server/webmail/paths";

export const metadata: Metadata = { title: "Opening your mailbox", referrer: "no-referrer" };

/**
 * Console → webmail handoff, step 3 (ADR-0024). The console sends the browser here with the one-time code in the URL
 * fragment (no server, log or `Referer` sees it); the page takes it out of the address bar and history at once and
 * redeems it with this browser's verifier cookie. Refusals explain themselves and offer the ordinary sign-in.
 */
export default async function WebmailHandoffPage() {
  const e = env();
  const base = webmailBasePath(
    (await headers()).get("host"),
    e.NODE_ENV === "production",
    process.env.WEBMAIL_DEV_PORT,
  );
  return (
    <AuthSplit area="Webmail">
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Opening your mailbox</h1>
        <p className="am-small">You're signed in to the console, so your mailbox opens without its password.</p>
      </div>
      <WebmailHandoff
        home={base === "" ? "/" : base}
        signIn={`${base}/sign-in`}
        consoleUrl={`${e.APP_URL.replace(/\/+$/, "")}/`}
      />
    </AuthSplit>
  );
}
