// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { clientIp } from "@anhourmail/server/client-ip";
import { callerKey, checkRateLimit, LIMITS } from "@anhourmail/server/rate-limit";

import { LocalTime, OriginalActions } from "@/components/webmail/original-actions";
import { container } from "@/server/container";
import { env } from "@/server/env";
import { platform } from "@/server/platform";
import { webmail, webmailCookieName } from "@/server/webmail/instance";
import {
  authLabel,
  authResults,
  delayLabel,
  deliveryDelaySeconds,
  parseHeaderBlock,
  trustedAuthservIds,
} from "@/server/webmail/original";
import { webmailBasePath } from "@/server/webmail/paths";
import { WebmailBlockedError } from "@/server/webmail/service";
import type { Address } from "@/server/webmail/view";
import { isJmapId } from "@/server/webmail/view";

export const metadata: Metadata = { title: "Original message", referrer: "no-referrer" };

/** The source shown on the page (the whole message is always available from "Download original"). */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const who = (list: Address[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");

function Row({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 border-b py-2.5 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-words text-[14px] ${mono ? "font-mono text-[13px]" : ""}`}>{children}</dd>
    </div>
  );
}

/**
 * "Show original" (opened in a new tab from a message's ⋯ menu): a summary of the message and its full source as
 * plain text. The source is fetched here, server-side, with the session's token for the signed-in mailbox only;
 * any other id is a 404. It is never rendered as HTML.
 */
export default async function OriginalMessagePage({ params }: { params: Promise<{ emailId: string }> }) {
  const { emailId } = await params;
  const h = await headers();
  const production = env().NODE_ENV === "production";
  const base = webmailBasePath(h.get("host"), production, process.env.WEBMAIL_DEV_PORT);
  const sessionId = (await cookies()).get(webmailCookieName())?.value;
  // A suspended or deleted mailbox: the sign-in page says so.
  const session = sessionId
    ? await webmail()
        .session(sessionId)
        .catch((err: unknown) => {
          if (err instanceof WebmailBlockedError) return "blocked" as const;
          throw err;
        })
    : null;
  if (session === "blocked") redirect(`${base}/sign-in?reason=unavailable`);
  if (!session || !sessionId) redirect(`${base}/sign-in`);
  if (!isJmapId(emailId)) notFound();

  const limit = LIMITS.webmailDownload;
  const rl = await checkRateLimit(
    container().counter,
    "webmailDownload:GET /message/:emailId/original",
    limit,
    callerKey(sessionId, clientIp(h)),
  );
  if (!rl.allowed) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-8">
        <h1 className="am-h1">Original message</h1>
        <p role="alert" className="am-small">
          Too many requests. Wait a moment and reload this page.
        </p>
      </main>
    );
  }

  const original = await webmail().original(sessionId, emailId, MAX_SOURCE_BYTES);
  if (!original) notFound();

  const auth = authResults(
    parseHeaderBlock(original.text),
    trustedAuthservIds(env().MAIL_AUTHSERV_ID, platform().hosts.mx, production),
  );
  const delay = deliveryDelaySeconds(original.sentAt, original.receivedAt);
  const notChecked = "Not checked";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <h1 className="am-h1">Original message</h1>
      <dl aria-label="Message summary" className="rounded-xl border px-4">
        <Row label="Message ID" mono>
          {original.messageId ? `<${original.messageId}>` : "None"}
        </Row>
        <Row label="Created at">
          {original.sentAt ? (
            <>
              <LocalTime iso={original.sentAt} />
              {delay !== null && <span className="text-muted-foreground"> ({delayLabel(delay)})</span>}
            </>
          ) : (
            "Unknown"
          )}
        </Row>
        <Row label="From">{who(original.from) || "None"}</Row>
        <Row label="To">{who(original.to) || "None"}</Row>
        {original.cc.length > 0 && <Row label="Cc">{who(original.cc)}</Row>}
        <Row label="Subject">{original.subject || "(no subject)"}</Row>
        <Row label="SPF" mono>
          {auth ? authLabel(auth.spf) : notChecked}
        </Row>
        <Row label="DKIM" mono>
          {auth ? authLabel(auth.dkim) : notChecked}
        </Row>
        <Row label="DMARC" mono>
          {auth ? authLabel(auth.dmarc) : notChecked}
        </Row>
      </dl>
      <OriginalActions
        downloadHref={`/api/webmail/messages/${encodeURIComponent(emailId)}/raw?download=1`}
        sourceId="original-source"
      />
      {original.cut && (
        <p className="am-small">Only the first 2 MB is shown here. Download the original for the whole message.</p>
      )}
      <pre
        id="original-source"
        aria-label="Message source"
        tabIndex={0}
        className="max-h-[70vh] overflow-auto rounded-xl border bg-muted p-4 font-mono text-[12.5px] leading-5 break-all whitespace-pre-wrap"
      >
        {original.text}
      </pre>
    </main>
  );
}
