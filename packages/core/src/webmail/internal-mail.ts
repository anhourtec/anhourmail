// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, timingSafeEqual } from "node:crypto";

import { isSenderDelegationKey, SenderDelegationKeyError } from "./on-behalf";

/**
 * "Internal mail" marker (ADR-0019 update 2026-10-30, docs/internal/05-webmail.md "Remote images").
 *
 * Mail an account submits to our own server and that is delivered there never passes the inbound checks, so it carries
 * no `Authentication-Results` of ours (verified on v0.16.27: no `Received` either, for SMTP 465/587 and JMAP). To let
 * the webmail treat its From as verified anyway, the `sender-identity` system script — which has already made sure
 * From is exactly the authenticated envelope sender — adds
 *
 *   X-AnhourMail-Internal: <tag>
 *   inner = hex sha256(K | "internal-mail-v1" | lowercase envelope sender | Message-ID)
 *   tag   = hex sha256(K | inner)
 *
 * to every authenticated submission whose envelope recipients are all on domains we host (so nothing leaving the
 * server carries one) and that has exactly one Message-ID in the `local@host` form below (the id as Stalwart
 * reads it: without angle brackets, case kept), after removing any such header the client sent. Mail arriving on any
 * unauthenticated session (port 25) has the header removed by the `inbound-headers` script, so a marker copied from a
 * genuine message is gone at the door; the key is the second wall (a planted header without it is worthless, and one
 * copied from a stored message only ever vouches for that message's own From and Message-ID). `K` is
 * `SENDER_DELEGATION_KEY`, the send-on-behalf key: the label keeps the two tags apart (an on-behalf inner hash has an
 * address in that position). The same formula is written in Sieve by `@anhourmail/stalwart-client`
 * (`senderIdentitySieve`); a unit test pins the two together and `npm run stack:verify` checks them on the real server.
 */
export const INTERNAL_MAIL_HEADER = "X-AnhourMail-Internal";

/** The Message-IDs the script tags (it adds no marker otherwise): the on-behalf form. */
const MESSAGE_ID_FORMAT = /^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,200}$/;
/** An address the tag can be made for: nothing the `|` framing could read differently. */
const ADDRESS_FORMAT = /^[^|"<>\s\p{Cc}@]+@[^|"<>\s\p{Cc}@]+$/u;
const TAG_FORMAT = /^[0-9a-f]{64}$/;

const sha = (input: string) => createHash("sha256").update(input).digest("hex");

/** The Message-ID as the script reads it (angle brackets and surrounding space removed), or null if it can't be tagged. */
export function internalMailMessageId(raw: string): string | null {
  const id = raw.trim().replace(/^<(.*)>$/, "$1");
  return MESSAGE_ID_FORMAT.test(id) ? id : null;
}

/** The tag for a message from `from` with `messageId`, or null when either is outside the forms the script tags. */
export function internalMailTag(key: string, from: string, messageId: string): string | null {
  if (!isSenderDelegationKey(key)) throw new SenderDelegationKeyError("Malformed sender delegation key");
  const address = from.trim().toLowerCase();
  const id = internalMailMessageId(messageId);
  if (!ADDRESS_FORMAT.test(address) || id === null) return null;
  return sha(`${key}|${sha(`${key}|internal-mail-v1|${address}|${id}`)}`);
}

/** Whether `tag` is the marker our server adds to a message from `from` with `messageId` (constant-time compare). */
export function isInternalMailTag(key: string, from: string, messageId: string, tag: string): boolean {
  const want = internalMailTag(key, from, messageId);
  const have = tag.trim();
  if (want === null || !TAG_FORMAT.test(have)) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(have));
}
