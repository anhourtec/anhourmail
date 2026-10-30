// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

/**
 * "Send on behalf" tag (ADR-0026 §6 and §8, ADR-0019 update 2026-10-30).
 *
 * The mail server refuses any submission whose `Sender:` differs from the envelope sender unless it has exactly one
 * `Message-ID:` and carries `X-AnhourMail-On-Behalf: <tag>`, where
 *
 *   inner = hex sha256(K | mailbox | delegate | messageId)      (addresses lowercased; the Message-ID as written,
 *   tag   = hex sha256(K | inner)                                 without its angle brackets)
 *
 * The mailbox is the envelope sender (and the `From:`), the delegate the single `Sender:` address. Binding the tag to
 * the Message-ID makes a tag copied from one message useless on any other; the outer hash keeps the construction
 * from being extended. `K` is `SENDER_DELEGATION_KEY`: 32 random bytes as 64 lowercase hex characters, held by the web
 * app and the mail server's `sender-identity` system script only (never the worker). The script removes the header
 * before the message leaves.
 *
 * The same formula is written in Sieve by `@anhourmail/stalwart-client` (`senderIdentitySieve`); the two are checked
 * against each other by a unit test and, on the real server, by `npm run stack:verify`.
 */
export const ON_BEHALF_HEADER = "X-AnhourMail-On-Behalf";

const KEY_FORMAT = /^[0-9a-f]{64}$/;

export class SenderDelegationKeyError extends Error {
  override readonly name = "SenderDelegationKeyError";
}

/** An address or Message-ID the tag can't safely be made for (the caller refuses the send). */
export class OnBehalfTagError extends Error {
  override readonly name = "OnBehalfTagError";
}

/** A valid key: exactly 64 lowercase hex characters (the only characters the mail server's script text accepts). */
export function isSenderDelegationKey(value: string): boolean {
  return KEY_FORMAT.test(value);
}

/** Nothing the tag input's `|` framing or the server's header parsing could read differently. */
const UNSAFE = /[|"<>\s\p{Cc}]/u;

function part(value: string, what: string): string {
  const v = value.trim();
  if (v === "" || UNSAFE.test(v)) throw new OnBehalfTagError(`Unsupported ${what} for an on-behalf tag`);
  return v;
}

/**
 * The tag for one message sent from `mailbox` on behalf of `delegate`, bound to its Message-ID (`messageId` without
 * angle brackets, exactly as it will be written; `<…>` around it is accepted and removed). Throws on a malformed key,
 * or on an address or id with `|`, `"`, `<`, `>`, whitespace or control characters. Never logs its inputs.
 */
export function onBehalfTag(key: string, mailbox: string, delegate: string, messageId: string): string {
  if (!isSenderDelegationKey(key)) throw new SenderDelegationKeyError("Malformed sender delegation key");
  const m = part(mailbox, "mailbox address").toLowerCase();
  const d = part(delegate, "delegate address").toLowerCase();
  const id = part(messageId.trim().replace(/^<(.*)>$/, "$1"), "Message-ID");
  const sha = (input: string) => createHash("sha256").update(input).digest("hex");
  return sha(`${key}|${sha(`${key}|${m}|${d}|${id}`)}`);
}

/**
 * The key in effect: `SENDER_DELEGATION_KEY` when set (must be well formed); otherwise, outside production only, a dev
 * key derived from `BETTER_AUTH_SECRET`, so the dev plan, the web app and `stack:verify` agree with nothing extra to
 * set up (the same approach as the secrets key ring). Production must set it.
 */
export function resolveSenderDelegationKey(env: {
  NODE_ENV?: string | undefined;
  SENDER_DELEGATION_KEY?: string | undefined;
  BETTER_AUTH_SECRET?: string | undefined;
}): string {
  const set = (env.SENDER_DELEGATION_KEY ?? "").trim();
  if (set !== "") {
    if (!isSenderDelegationKey(set)) {
      throw new SenderDelegationKeyError("SENDER_DELEGATION_KEY must be 64 lowercase hex characters (32 random bytes)");
    }
    return set;
  }
  if (env.NODE_ENV === "production") {
    throw new SenderDelegationKeyError("Set SENDER_DELEGATION_KEY in production (web app and mail server only)");
  }
  const seed = (env.BETTER_AUTH_SECRET ?? "").trim();
  if (seed === "") throw new SenderDelegationKeyError("Set SENDER_DELEGATION_KEY or BETTER_AUTH_SECRET");
  return createHash("sha256").update(`anhourmail:dev-sender-delegation:${seed}`).digest("hex");
}
