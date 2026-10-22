// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { NextResponse } from "next/server";

import { webmailCookie } from "./instance";
import {
  WebmailBlockedError,
  WebmailBusyError,
  WebmailSignedOutError,
  WebmailSignInError,
  WebmailUnavailableError,
} from "./service";

/** Why the sign-in page is shown again (a short-lived, HttpOnly hint; never a credential). */
export const NOTICE_COOKIE = "am.webmail_notice";
export const BLOCKED_MESSAGE = "This mailbox can't be used right now.";

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
    const res = body("mailbox_unavailable", BLOCKED_MESSAGE, 401);
    res.headers.append("Set-Cookie", webmailCookie("", 0));
    res.headers.append("Set-Cookie", `${NOTICE_COOKIE}=unavailable; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
    return res;
  }
  if (err instanceof WebmailSignInError) return body("unauthorized", "Mailbox address or password is wrong.", 401);
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
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new BodyTooLargeError("body too large");
  if (!req.body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}

export const unauthorized = () =>
  NextResponse.json({ error: { code: "unauthorized", message: "Sign in to your mailbox first." } }, { status: 401 });

export const badRequest = (message: string) =>
  NextResponse.json({ error: { code: "bad_request", message } }, { status: 400 });

export const notFound = () =>
  NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
