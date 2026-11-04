// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webhook signatures in the payment processor's scheme (ADR-0029 §4), shared by the real adapter and the fake (which
 * signs its events the same way, so dev exercises the real check). Header: `t=<unix seconds>,v1=<hex>[,v1=…]`; each
 * `v1` is HMAC-SHA256(secret, `${t}.${rawBody}`) in lower-case hex. `v0` (the processor's test-only scheme) and unknown
 * keys are ignored. The body is verified raw, before any parsing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { type ProviderEvent, WebhookRejected } from "@anhourmail/core/billing";

/** Seconds a signature's timestamp may be from now, either way (the processor's own default). */
export const SIGNATURE_TOLERANCE_S = 300;

/** Our cap on a header we parse (it is untrusted input). */
const MAX_HEADER = 4096;

export const signPayload = (secret: string, timestampS: number, rawBody: string): string =>
  createHmac("sha256", secret)
    .update(`${String(timestampS)}.${rawBody}`, "utf8")
    .digest("hex");

/** The header a sender sets: what the fake emits and tests use. */
export const signatureHeader = (secret: string, timestampS: number, rawBody: string): string =>
  `t=${String(timestampS)},v1=${signPayload(secret, timestampS, rawBody)}`;

/** Parses the header's timestamp and every `v1`; whitespace around parts is tolerated, anything malformed rejected. */
export function parseSignatureHeader(header: string | null): { t: number; v1: string[] } {
  if (header === null || header.trim() === "") throw new WebhookRejected("missing_header");
  if (header.length > MAX_HEADER) throw new WebhookRejected("malformed_header");
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(value)) throw new WebhookRejected("malformed_header");
      t = Number(value);
    } else if (key === "v1") {
      v1.push(value);
    }
  }
  if (t === null || v1.length === 0) throw new WebhookRejected("malformed_header");
  return { t, v1 };
}

/** Constant-time equality of two hex strings; a length mismatch is simply no match (no early string compare). */
function sameHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Throws `WebhookRejected` unless one of `secrets` (several during a rotation) signed `rawBody` with one of the
 * header's `v1` signatures, at a timestamp within the tolerance of `now`.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secrets: readonly string[],
  now: Date,
  toleranceS: number = SIGNATURE_TOLERANCE_S,
): void {
  const { t, v1 } = parseSignatureHeader(header);
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceS) {
    throw new WebhookRejected("timestamp_out_of_tolerance");
  }
  let matched = false;
  for (const secret of secrets) {
    if (secret === "") continue;
    const expected = signPayload(secret, t, rawBody);
    // Every candidate is compared (no early exit), so timing doesn't say which secret or signature matched.
    for (const sig of v1) if (sameHex(expected, sig)) matched = true;
  }
  if (!matched) throw new WebhookRejected("no_matching_signature");
}

const id = z.string().min(1).max(255);

/** The minimal event shape we read; everything else in the payload is ignored and never stored. */
const eventSchema = z.object({
  id,
  type: z.string().min(1).max(128),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  data: z.object({
    object: z.object({
      id,
      object: z.string().max(64).optional(),
      customer: z.union([id, z.object({ id }), z.null()]).optional(),
      // Disputes name their payment, not a customer; charges carry both.
      payment_intent: z.union([id, z.object({ id }), z.null()]).optional(),
      charge: z.union([id, z.object({ id }), z.null()]).optional(),
      client_reference_id: z.string().max(255).nullable().optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    }),
  }),
});

const hint = (v: string | null | undefined): string | null =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : null;

/** Parses a verified body to a `ProviderEvent`; rejects a malformed one and one from the other mode (live vs test). */
export function parseEvent(rawBody: string, livemode: boolean): ProviderEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new WebhookRejected("malformed_event");
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) throw new WebhookRejected("malformed_event");
  const e = parsed.data;
  if (e.livemode !== livemode) throw new WebhookRejected("livemode_mismatch");
  const obj = e.data.object;
  const ref = (v: string | { id: string } | null | undefined): string | null =>
    typeof v === "string" ? v : (v?.id ?? null);
  const customerId = obj.object === "customer" ? obj.id : ref(obj.customer);
  return {
    id: e.id,
    type: e.type,
    createdAt: new Date(e.created * 1000),
    livemode: e.livemode,
    customerId,
    objectId: obj.id,
    paymentIntentId: obj.object === "payment_intent" ? obj.id : ref(obj.payment_intent),
    chargeId: obj.object === "charge" ? obj.id : ref(obj.charge),
    accountIdHint: hint(obj.metadata?.account_id) ?? hint(obj.client_reference_id),
  };
}

/** Verify, then parse: the whole webhook check both adapters run. */
export function verifyWebhookBody(
  rawBody: string,
  header: string | null,
  secrets: readonly string[],
  now: Date,
  livemode: boolean,
): ProviderEvent {
  verifySignature(rawBody, header, secrets, now);
  return parseEvent(rawBody, livemode);
}
