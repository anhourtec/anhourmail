// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * "This browser signed in to that mailbox before" (docs/internal/07-security.md "Webmail sign-in and suspension").
 * Stalwart refuses a suspended account's right password exactly like a wrong one, so a refused sign-in alone can't
 * tell a suspended mailbox from a typo. Saying "suspended" to anyone who types an address would let outsiders learn
 * which addresses exist and are suspended, so the sign-in names the suspension only when the browser holds this
 * cookie's proof of an earlier successful sign-in to that address; everyone else gets the generic wrong-password
 * answer.
 *
 * The cookie holds up to `MAX_KNOWN` keyed tags (HMAC-SHA256 of the normalised address under the server secret, cut to
 * 128 bits), never an address: it can't be read back into one or forged for another. HttpOnly, SameSite=Lax, sent only
 * to the sign-in endpoint.
 */

export const KNOWN_COOKIE = "am.webmail_known";
/** Path the cookie is sent to: the sign-in endpoint only. */
export const KNOWN_PATH = "/api/webmail/auth";
/** Mailboxes remembered per browser (the most recent first). */
export const MAX_KNOWN = 5;
/** How long a browser remembers a mailbox it signed in to (seconds): 180 days. */
export const KNOWN_MAX_AGE_SEC = 180 * 24 * 3600;

const TAG = /^[A-Za-z0-9_-]{22}$/;

/** The tag for `address` (normalised) under `secret`. */
export function knownTag(secret: string, address: string): string {
  return createHmac("sha256", secret)
    .update(`${KNOWN_COOKIE}\0${address.trim().toLowerCase()}`)
    .digest("base64url")
    .slice(0, 22);
}

/** The well-formed tags in a Cookie header (anything else in the cookie is ignored). */
export function knownTags(cookieHeader: string | null): string[] {
  const m = new RegExp(`(?:^|;\\s*)${KNOWN_COOKIE.replace(/[.]/g, "\\.")}=([^;]*)`).exec(cookieHeader ?? "");
  return (m?.[1] ?? "")
    .split(".")
    .filter((t) => TAG.test(t))
    .slice(0, MAX_KNOWN);
}

/** Whether `tags` holds `tag` (constant time per comparison). */
export function hasKnownTag(tags: readonly string[], tag: string): boolean {
  const want = Buffer.from(tag);
  let found = false;
  for (const t of tags) {
    const have = Buffer.from(t);
    if (have.length === want.length && timingSafeEqual(have, want)) found = true;
  }
  return found;
}

/** The Set-Cookie value remembering `tag` first, followed by the others it already held (at most `MAX_KNOWN`). */
export function rememberKnown(tags: readonly string[], tag: string, secure: boolean): string {
  const next = [tag, ...tags.filter((t) => t !== tag)].slice(0, MAX_KNOWN);
  return [
    `${KNOWN_COOKIE}=${next.join(".")}`,
    `Path=${KNOWN_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(KNOWN_MAX_AGE_SEC)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
