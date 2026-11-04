// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { DomainError, NotFoundError } from "@anhourmail/core";
import { ingestBillingEvent, type ProviderEvent, WebhookRejected } from "@anhourmail/core/billing";
import { log } from "@anhourmail/server/log";

import { container } from "./container";
import { ok } from "./http/route";

/** Largest webhook body read (ADR-0029 §4); the provider's events are a few kilobytes. */
export const WEBHOOK_MAX_BYTES = 512 * 1024;

const l = log.child({ component: "billing-webhook" });

class PayloadTooLargeError extends DomainError {
  constructor() {
    super("Request body too large.", "payload_too_large");
  }
}

class BadSignatureError extends DomainError {
  constructor() {
    super("Webhook signature check failed.", "bad_signature");
  }
}

/**
 * The raw body as text, at most `max` bytes: refused at once when the declared length is over, and while reading when
 * the body turns out longer (a missing or false `Content-Length` doesn't get past the cap). Never parsed here.
 */
export async function readCappedText(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new PayloadTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/**
 * `POST /api/billing/webhook` (ADR-0029 §4): billing off → 404; the raw body (≤ 512 KiB, 413 beyond) is verified
 * before anything reads it (400 `bad_signature`, logged with the reason only: never the body or the header), then the
 * event is recorded once and the account's sync queued. 200 for handled, duplicate and ignored events alike; a
 * database failure is a 500, so the provider retries. Unauthenticated noise is not audited (it would flood the chain).
 */
export async function receiveBillingWebhook(req: Request): Promise<Response> {
  const { billing, deps } = container();
  if (!billing) throw new NotFoundError();
  const raw = await readCappedText(req, WEBHOOK_MAX_BYTES);
  const now = deps.clock.now();
  let event: ProviderEvent;
  try {
    event = billing.verifyWebhook(raw, req.headers.get("stripe-signature"), now);
  } catch (err) {
    if (!(err instanceof WebhookRejected)) throw err;
    l.warn("billing webhook rejected", { reason: err.reason });
    throw new BadSignatureError();
  }
  const outcome = await ingestBillingEvent(deps, event, now);
  l.info("billing webhook received", { type: event.type, outcome });
  return ok({ received: true });
}
