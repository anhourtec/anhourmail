// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { REMOTE_IMAGES } from "@anhourmail/shared/webmail";
import { log } from "@anhourmail/server/log";

import { type FetchResult, imageUrl } from "./remote-image";
import { type SanitizeResult, sanitizeMessageHtml } from "./sanitize";
import type { MessageView } from "./view";

/**
 * The webmail's image proxy (docs/internal/05-webmail.md "Remote images", 07-security.md "Image proxy (SSRF)").
 *
 * **Signing happens when the message is served.** The reader's sanitiser removes every remote image address from
 * the HTML and puts an *image link* in its place (`data-am-img`): `v1.<expiry>.<base64url address>.<mac>`, an HMAC
 * under the server secret (domain-separated from every other use of it) over the address, the expiry and the
 * webmail session + mailbox it was made for. So the proxy only ever fetches addresses that were in a message this
 * session opened, a link copied to another session or mailbox is refused, and nobody can turn it into an open
 * proxy by asking it to sign arbitrary addresses (there is no sign endpoint).
 *
 * The browser sends a link to `POST /api/webmail/img` (in the body, so no address or link ever reaches an access
 * log) and turns the answer into a `data:` image inside the message frame, which itself still loads nothing.
 */

const TOKEN_DOMAIN = "am.webmail.image-link.v1";
const SENDER_DOMAIN = "am.webmail.image-sender.v1";

/** How long an image link works (seconds): the reader fetches a fresh message view after that. */
export const IMAGE_LINK_TTL_SEC = REMOTE_IMAGES.linkMinutes * 60;

/** Who a link was made for: the webmail session and the mailbox it showed. */
export type LinkBinding = { sessionId: string; accountId: string };

const mac = (secret: string, b: LinkBinding, exp: string, url: string) =>
  createHmac("sha256", secret)
    .update(`${TOKEN_DOMAIN}\0${b.sessionId}\0${b.accountId}\0${exp}\0${url}`)
    .digest("base64url");

/** An image link for `url` (null when the address can never be fetched: wrong scheme or port, too long, …). */
export function signImageLink(secret: string, binding: LinkBinding, raw: string, nowMs = Date.now()): string | null {
  const u = imageUrl(raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw.trim());
  if (!u) return null;
  const exp = String(Math.floor(nowMs / 1000) + IMAGE_LINK_TTL_SEC);
  return `v1.${exp}.${Buffer.from(u.href).toString("base64url")}.${mac(secret, binding, exp, u.href)}`;
}

export type LinkCheck = { ok: true; url: string } | { ok: false; reason: "invalid" | "expired" };

/** The address in a link, if this session and mailbox made it and it hasn't expired. */
export function verifyImageLink(secret: string, binding: LinkBinding, token: string, nowMs = Date.now()): LinkCheck {
  const [v, exp, enc, sig, ...rest] = token.split(".");
  if (v !== "v1" || !exp || !enc || !sig || rest.length > 0 || !/^\d{1,12}$/.test(exp)) {
    return { ok: false, reason: "invalid" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(enc) || enc.length > 4 * 1024) return { ok: false, reason: "invalid" };
  const url = Buffer.from(enc, "base64url").toString("utf8");
  const want = Buffer.from(mac(secret, binding, exp, url));
  const have = Buffer.from(sig);
  if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: "invalid" };
  if (Number(exp) * 1000 < nowMs) return { ok: false, reason: "expired" };
  return { ok: true, url };
}

/**
 * A remembered sender's key for this mailbox: an HMAC of the address (lowercased) under the server secret, so the
 * preference list never holds an address and can't be reversed without the secret.
 */
export function senderKey(secret: string, mailbox: string, sender: string): string {
  return createHmac("sha256", secret)
    .update(`${SENDER_DOMAIN}\0${mailbox.toLowerCase()}\0${sender.trim().toLowerCase()}`)
    .digest("base64url")
    .slice(0, 22);
}

/** The reader's sanitiser for this session and mailbox: blocked images carry image links (at most `perMessage`). */
export function linkingSanitizer(
  secret: string,
  binding: LinkBinding,
): (html: string, inline: ReadonlyMap<string, string>) => SanitizeResult {
  return (html, inline) =>
    sanitizeMessageHtml(html, inline, {
      imageLink: (url) => signImageLink(secret, binding, url),
      maxLinks: REMOTE_IMAGES.perMessage,
    });
}

/** The view with its sender's key, when it has images to load and a sender (else unchanged). */
export function withSenderKey(view: MessageView, secret: string, mailbox: string): MessageView {
  const from = view.from[0]?.email;
  if (view.loadableImages === 0 || !from) return view;
  return { ...view, senderKey: senderKey(secret, mailbox, from) };
}

/** Largest request body: `{ "token": "…" }` with a link for a 2,048-character address. */
export const MAX_IMAGE_REQUEST = 6 * 1024;

/** Image fetches in flight in this process (each holds up to `REMOTE_IMAGES.maxMb` in memory); the rest retry. */
export const MAX_IMAGE_FETCHES = 16;
/** In flight for one webmail session, so one reader can't take every slot from the others. */
export const MAX_SESSION_IMAGE_FETCHES = 4;
let fetching = 0;
const perSession = new Map<string, number>();

export type ServeDeps = {
  secret: string;
  /** The session's active mailbox, or null when signed out. */
  binding: () => Promise<LinkBinding | null>;
  fetch: (url: string) => Promise<FetchResult>;
};

const fail = (code: string, message: string, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json({ error: { code, message } }, { status, headers });

/**
 * Answers one image request: 401 signed out, 404 for a link this session didn't make (or an altered one), 410 when it
 * expired (the reader reloads the message for fresh links), 502 when the image can't be fetched or isn't one. The
 * image goes back as its sniffed type with a CSP that allows nothing, `nosniff`, no caching beyond this tab.
 */
export async function serveImage(token: unknown, deps: ServeDeps): Promise<Response> {
  const binding = await deps.binding();
  if (!binding) return fail("unauthorized", "Sign in to your mailbox first.", 401);
  if (typeof token !== "string" || token.length > MAX_IMAGE_REQUEST) return fail("not_found", "Not found.", 404);
  const link = verifyImageLink(deps.secret, binding, token);
  if (!link.ok) {
    return link.reason === "expired"
      ? fail("expired", "This image link expired. Open the message again.", 410)
      : fail("not_found", "Not found.", 404);
  }
  const mine = perSession.get(binding.sessionId) ?? 0;
  if (fetching >= MAX_IMAGE_FETCHES || mine >= MAX_SESSION_IMAGE_FETCHES) {
    return fail("rate_limited", "Many images are loading already. Try again in a moment.", 429, { "Retry-After": "1" });
  }
  fetching += 1;
  perSession.set(binding.sessionId, mine + 1);
  let result: FetchResult;
  try {
    result = await deps.fetch(link.url);
  } finally {
    fetching -= 1;
    const left = (perSession.get(binding.sessionId) ?? 1) - 1;
    if (left > 0) perSession.set(binding.sessionId, left);
    else perSession.delete(binding.sessionId);
  }
  if (!result.ok) {
    // The outcome only: never the address, its host or query (rule 24).
    log.info("image proxy refused", { component: "image-proxy", reason: result.reason });
    return fail("image_unavailable", "This image couldn't be loaded.", 502);
  }
  log.info("image proxy served", { component: "image-proxy", bytes: result.bytes.length });
  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": result.type,
      "Content-Length": String(result.bytes.length),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
    },
  });
}
