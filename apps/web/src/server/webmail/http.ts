// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import type { WebmailRefusal } from "@anhourmail/core/webmail";
import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";

import { webmailCookie } from "./instance";
import { PinnedMailboxMissingError, REFUSED_HEADER } from "./pin";
import {
  WebmailBlockedError,
  WebmailBusyError,
  WebmailConflictError,
  WebmailDelegationRefusedError,
  WebmailOwnMailboxOnlyError,
  WebmailQuotaError,
  WebmailSendUnconfirmedError,
  WebmailRefusedError,
  WebmailSenderBlockedError,
  WebmailSignedOutError,
  WebmailSignInError,
  WebmailUnavailableError,
} from "./service";

/** Why the sign-in page is shown again (a short-lived, HttpOnly hint naming a `WebmailRefusal`; never a credential). */
export const NOTICE_COOKIE = "am.webmail_notice";

/**
 * What a person is told when the control plane keeps a mailbox out of the webmail, and what to do about it. A staff
 * suspension of the person is always Anhourtec's, so it names the appeal address; a suspended mailbox may be the
 * account's own doing or Anhourtec's; a mailbox being deleted can still be restored by the account's admins.
 */
export const BLOCKED_NOTICES: Record<WebmailRefusal, string> = {
  person_suspended: `Your AnhourMail sign-in is suspended, so this mailbox can't be used right now. Its mail is kept. If you think this is a mistake, email ${SUPPORT_EMAIL}.`,
  suspended: `This mailbox is suspended, so it can't be used right now. Its mail is kept. If you think this is a mistake, ask your account's admin, or email ${SUPPORT_EMAIL} if Anhourtec suspended your account.`,
  deleting:
    "This mailbox is being deleted, so it can't be used. If it should be kept, ask your account's admin to restore it before the deletion completes.",
  gone: "This mailbox no longer exists. If you think this is a mistake, ask your account's admin.",
};

/** The refusal named by a notice cookie (`unavailable` is the older name for `suspended`). */
export function blockedNoticeFor(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value === "unavailable") return BLOCKED_NOTICES.suspended;
  return Object.hasOwn(BLOCKED_NOTICES, value) ? BLOCKED_NOTICES[value as WebmailRefusal] : null;
}

/** How long a signed `?reason=` link shows its notice (seconds), like the notice cookie's Max-Age. */
export const NOTICE_LINK_TTL_SEC = 60;

const noticeMac = (secret: string, reason: string, exp: string) =>
  createHmac("sha256", secret).update(`${NOTICE_COOKIE}\0${reason}\0${exp}`).digest("base64url").slice(0, 22);

/**
 * The `?reason=` value a server page redirects to the sign-in page with when it finds the session blocked (pages
 * can't set the notice cookie). It is `reason.expiry.mac` under the server secret, so a crafted link can't make the
 * sign-in page show a suspension or deletion notice for nobody.
 */
export function signedNoticeReason(secret: string, reason: WebmailRefusal, nowMs = Date.now()): string {
  const exp = String(Math.floor(nowMs / 1000) + NOTICE_LINK_TTL_SEC);
  return `${reason}.${exp}.${noticeMac(secret, reason, exp)}`;
}

/** The notice for a signed `?reason=` value; null when it is missing, forged, altered or expired. */
export function blockedNoticeForLink(secret: string, value: string | undefined, nowMs = Date.now()): string | null {
  const [reason, exp, mac, ...rest] = (value ?? "").split(".");
  if (!reason || !exp || !mac || rest.length > 0 || !/^\d{1,12}$/.test(exp)) return null;
  if (Number(exp) * 1000 < nowMs) return null;
  const want = Buffer.from(noticeMac(secret, reason, exp));
  const have = Buffer.from(mac);
  if (have.length !== want.length || !timingSafeEqual(have, want)) return null;
  return reason === "unavailable" ? null : blockedNoticeFor(reason);
}

/** The refusal for a delegated mailbox (the same words as core's `DelegatedMailboxRefusedError`). */
export const DELEGATION_REFUSED = "You don't have access to this mailbox.";
/** What a mailbox shared with the person can't do in their webmail (ADR-0026 §6 "What each right allows"). */
export const OWN_MAILBOX_ONLY = "This isn't available in a mailbox shared with you. Switch to your own mailbox first.";

/** Maps webmail BFF errors to the `{ error: { code, message } }` envelope; null when `err` isn't one of ours. */
export function webmailErrorResponse(err: unknown): Response | null {
  const body = (code: string, message: string, status: number) =>
    NextResponse.json({ error: { code, message } }, { status });
  if (err instanceof WebmailSignedOutError) {
    const res = body("unauthorized", "Your session ended. Sign in again.", 401);
    res.headers.append("Set-Cookie", webmailCookie("", 0));
    return res;
  }
  if (err instanceof WebmailBlockedError) {
    const res = body("mailbox_unavailable", BLOCKED_NOTICES[err.reason], 401);
    res.headers.append("Set-Cookie", webmailCookie("", 0));
    res.headers.append("Set-Cookie", `${NOTICE_COOKIE}=${err.reason}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
    return res;
  }
  if (err instanceof WebmailRefusedError) return body("refused", err.message, 400);
  if (err instanceof WebmailConflictError) return body("settings_changed", err.message, 409);
  if (err instanceof WebmailSenderBlockedError) return body("sender_blocked", err.message, 409);
  // One answer for every refused delegated mailbox (ADR-0026 §6): it never says whether an address exists.
  if (err instanceof WebmailDelegationRefusedError || err instanceof PinnedMailboxMissingError) {
    const res = body("not_found", DELEGATION_REFUSED, 404);
    // Lets a mailbox-scoped tab tell this refusal from "that message is gone" (the same for every refused case).
    res.headers.set(REFUSED_HEADER, "mailbox");
    return res;
  }
  if (err instanceof WebmailOwnMailboxOnlyError) return body("own_mailbox_only", OWN_MAILBOX_ONLY, 403);
  if (err instanceof WebmailQuotaError) return body("rate_limited", err.message, 429);
  if (err instanceof WebmailSendUnconfirmedError) {
    return body(
      "send_unconfirmed",
      "We couldn't confirm whether this was sent. Check Sent before sending it again.",
      503,
    );
  }
  if (err instanceof WebmailSignInError) {
    return body("invalid_credentials", "Mailbox address or password is wrong.", 401);
  }
  if (err instanceof WebmailBusyError) return body("rate_limited", "Too many requests. Wait a moment.", 429);
  if (err instanceof WebmailUnavailableError) {
    return body("unavailable", "The mail server isn't answering. Try again in a moment.", 503);
  }
  return null;
}

/** Runs `fn`, turning webmail errors into responses (other errors propagate to `route()`). */
export async function handleWebmail(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    const res = webmailErrorResponse(err);
    if (res) return res;
    throw err;
  }
}

export class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}

/** Reads a request body as text, refusing more than `max` bytes without buffering the excess. */
export async function readCappedText(req: Request, max: number): Promise<string> {
  return Buffer.from(await readCappedBytes(req, max)).toString("utf8");
}

/** Reads a request body as bytes, refusing more than `max` bytes without buffering the excess. */
export async function readCappedBytes(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new BodyTooLargeError("body too large");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new BodyTooLargeError("body too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export const unauthorized = () =>
  NextResponse.json({ error: { code: "unauthorized", message: "Sign in to your mailbox first." } }, { status: 401 });

export const badRequest = (message: string) =>
  NextResponse.json({ error: { code: "bad_request", message } }, { status: 400 });

export const notFound = () =>
  NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });

/**
 * Uploads in flight in this process. Each holds up to 20 MB in memory (read, capped, then sent to the mail server
 * once — the body can't be streamed because the request may be retried), so at most `MAX_UPLOADS` run at once and
 * the rest are told to retry.
 */
export const MAX_UPLOADS = 4;
let uploads = 0;

export async function withUploadSlot(fn: () => Promise<Response>): Promise<Response> {
  if (uploads >= MAX_UPLOADS) {
    return NextResponse.json(
      { error: { code: "rate_limited", message: "Several files are uploading already. Try again in a moment." } },
      { status: 429, headers: { "Retry-After": "2" } },
    );
  }
  uploads += 1;
  try {
    return await fn();
  } finally {
    uploads -= 1;
  }
}

/** The header carrying the account the app is showing; contacts changes refuse a different active mailbox. */
export const ACCOUNT_HEADER = "x-webmail-account";

/** The account id from `ACCOUNT_HEADER`, or null when it is missing or malformed. */
export function shownAccount(req: Request): string | null {
  const v = req.headers.get(ACCOUNT_HEADER) ?? "";
  return /^[A-Za-z0-9_-]{1,255}$/.test(v) ? v : null;
}

/** 400 for a contacts change without the account the app is showing. */
export const noAccount = () => badRequest("Reload the page and try again.");
