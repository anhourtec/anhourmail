// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { headers } from "next/headers";

import { handoffMailboxes, isHandoffToken } from "@anhourmail/core/webmail";

import { AuthSplit } from "@/components/auth-split";
import { requireUser } from "@/server/console-frame";
import { container } from "@/server/container";
import { env } from "@/server/env";

import { OpenWebmail } from "./open-webmail";

export const metadata: Metadata = { title: "Open webmail" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * Console → webmail handoff, step 2 (ADR-0024). The console's **Open webmail** link went to the webmail origin first,
 * which set this browser's verifier and sent it here with the challenge. The person's own mailboxes are listed; with
 * exactly one that can be opened (or the one `?mailbox=` names) it continues by itself — but only when the browser says
 * the navigation came from our own site (`Sec-Fetch-Site: same-site`, the 303 from the webmail origin), so a link
 * from anywhere else can't make it mint; then the person chooses **Open**. The challenge isn't a secret; the code
 * minted from it is only ever put in a URL fragment. Minting needs a recent step-up: the page asks for it in place.
 */
export default async function OpenWebmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireUser();
  const params = await searchParams;
  const challenge = one(params.challenge);
  const wanted = one(params.mailbox)?.toLowerCase();
  const webmailUrl = env().WEBMAIL_URL.replace(/\/+$/, "");
  const signInUrl = `${webmailUrl}/sign-in`;
  const mailboxes = await handoffMailboxes(container().deps, actor);
  const ready = mailboxes.filter((m) => m.unavailable === null);
  const preselected = ready.find((m) => m.mailboxId === wanted) ?? (ready.length === 1 ? ready[0] : undefined);
  // Browsers that send Fetch Metadata tell us where the navigation came from; anything but our own site waits for a click.
  const site = (await headers()).get("sec-fetch-site");
  const fromUs = site === "same-site" || site === "same-origin";
  return (
    <AuthSplit>
      <div className="flex flex-col gap-2">
        <h1 className="am-h1">Open webmail</h1>
        <p className="am-small">
          {actor.actingAs
            ? "Webmail isn't available while you're acting as someone: support access never opens mail."
            : mailboxes.length === 0
              ? "You don't have a mailbox you can open from here. Sign in to the webmail with your mailbox address and password instead."
              : "Your mailbox opens in the webmail without its password, because you're signed in here."}
        </p>
      </div>
      <OpenWebmail
        challenge={isHandoffToken(challenge) ? challenge : null}
        mailboxes={actor.actingAs ? [] : mailboxes}
        autoStart={fromUs ? (preselected?.mailboxId ?? null) : null}
        startUrl={`${webmailUrl}/api/webmail/handoff`}
        signInUrl={signInUrl}
      />
    </AuthSplit>
  );
}
