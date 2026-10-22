// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { AuthSplit, LegalConsent } from "@/components/auth-split";
import { WebmailSignInForm } from "@/components/webmail/sign-in-form";
import { env } from "@/server/env";
import { platform } from "@/server/platform";
import { BLOCKED_MESSAGE, NOTICE_COOKIE } from "@/server/webmail/http";
import { webmail, webmailCookieName } from "@/server/webmail/instance";
import { prefillAddress, webmailBasePath } from "@/server/webmail/paths";

export const metadata: Metadata = { title: "Sign in to webmail" };

/**
 * Webmail sign-in (ADR-0018): mailbox address + mailbox password, exchanged once by the BFF for server-held
 * tokens. The console links here with `?address=` to pre-fill the address only (never a credential).
 */
export default async function WebmailSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const e = env();
  const base = webmailBasePath(
    (await headers()).get("host"),
    e.NODE_ENV === "production",
    process.env.WEBMAIL_DEV_PORT,
  );
  const jar = await cookies();
  const id = jar.get(webmailCookieName())?.value;
  if (id && (await webmail().store.read(id))) redirect(base === "" ? "/" : base);
  const params = await searchParams;
  const address = prefillAddress(params.address);
  const blocked = params.reason === "unavailable" || jar.get(NOTICE_COOKIE)?.value === "unavailable";
  return (
    <AuthSplit area="Webmail">
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Sign in to your mailbox</h1>
        <p className="am-small">Use your mailbox address and the mailbox password, not your console sign-in.</p>
      </div>
      {blocked && (
        <p
          role="alert"
          className="am-small rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-destructive"
        >
          {BLOCKED_MESSAGE} If you think this is a mistake, ask your account's admin.
        </p>
      )}
      <WebmailSignInForm
        home={base === "" ? "/" : base}
        defaultAddress={address}
        domain={platform().freeAddressDomain}
      />
      <p className="am-micro">Remote images stay blocked until you choose to load them.</p>
      <LegalConsent verb="signing in" />
    </AuthSplit>
  );
}
