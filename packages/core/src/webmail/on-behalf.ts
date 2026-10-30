// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

/**
 * "Send on behalf" tag (ADR-0026 §6 and §8, ADR-0019 update 2026-10-30).
 *
 * The mail server refuses any submission whose `Sender:` differs from the envelope sender unless it has exactly one
 * `Message-ID:`, exactly one `X-AnhourMail-On-Behalf-Expires: <UTC time>` that hasn't passed, and carries
 * `X-AnhourMail-On-Behalf: <tag>`, where
 *
 *   inner = hex sha256(K | mailbox | delegate | messageId | expires)   (addresses lowercased; the Message-ID as
 *   tag   = hex sha256(K | inner)                                        written, without its angle brackets)
 *
 * The mailbox is the envelope sender (and the `From:`), the delegate the single `Sender:` address, `expires` the
 * expiry header's value (`YYYY-MM-DDTHH:MM:SSZ`, the form Stalwart's `currentdate :zone "+0000" "iso8601"` gives, so
 * the script compares it as text — verified on v0.16.27). Binding the tag to the Message-ID makes a tag copied from one
 * message useless on any other; the expiry (`ON_BEHALF_TTL_MS`) makes one seen in the moment its temporary copy
 * exists useless minutes later, even with the same Message-ID (ADR-0026 slice 13); the outer hash keeps the
 * construction from being extended. `K` is `SENDER_DELEGATION_KEY`: 32 random bytes as 64 lowercase hex characters, held by the web
 * app and the mail server's `sender-identity` system script only (never the worker). The script removes the header
 * before the message leaves.
 *
 * The same formula is written in Sieve by `@anhourmail/stalwart-client` (`senderIdentitySieve`); the two are checked
 * against each other by a unit test and, on the real server, by `npm run stack:verify`.
 */
export const ON_BEHALF_HEADER = "X-AnhourMail-On-Behalf";
/** The expiry the tag is bound to; the script refuses the tag once the mail server's clock is past it. */
export const ON_BEHALF_EXPIRES_HEADER = "X-AnhourMail-On-Behalf-Expires";
/**
 * How long a tag stays usable: enough for the submission that follows its creation (milliseconds in practice; the
 * undo hold runs after the check) and for clock drift between the web app and the mail server, short enough that a
 * tag seen in a temporary copy or a leftover is useless soon after.
 */
export const ON_BEHALF_TTL_MS = 5 * 60_000;

const EXPIRES_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The expiry header's value for a tag made at `now`: UTC, whole seconds, `YYYY-MM-DDTHH:MM:SSZ`. */
export function onBehalfExpires(now: number, ttlMs: number = ON_BEHALF_TTL_MS): string {
  return `${new Date(now + ttlMs).toISOString().slice(0, 19)}Z`;
}

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

/** The Message-IDs the script accepts on an on-behalf message (it refuses anything else before hashing). */
const MESSAGE_ID_FORMAT = /^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,200}$/;

/**
 * The tag for one message sent from `mailbox` on behalf of `delegate`, bound to its Message-ID (`messageId` without
 * angle brackets, exactly as it will be written; `<…>` around it is accepted and removed) and to `expires` (the value
 * of `ON_BEHALF_EXPIRES_HEADER`, from `onBehalfExpires`). Throws on a malformed key, on an address with `|`, `"`, `<`,
 * `>`, whitespace or control characters, on a Message-ID outside `local@host` in letters, digits and `._%+=-`, or on a
 * malformed expiry. Never logs its inputs.
 */
export function onBehalfTag(
  key: string,
  mailbox: string,
  delegate: string,
  messageId: string,
  expires: string,
): string {
  if (!isSenderDelegationKey(key)) throw new SenderDelegationKeyError("Malformed sender delegation key");
  const m = part(mailbox, "mailbox address").toLowerCase();
  const d = part(delegate, "delegate address").toLowerCase();
  const id = part(messageId.trim().replace(/^<(.*)>$/, "$1"), "Message-ID");
  if (!MESSAGE_ID_FORMAT.test(id)) throw new OnBehalfTagError("Unsupported Message-ID for an on-behalf tag");
  if (!EXPIRES_FORMAT.test(expires)) throw new OnBehalfTagError("Unsupported expiry for an on-behalf tag");
  const sha = (input: string) => createHash("sha256").update(input).digest("hex");
  return sha(`${key}|${sha(`${key}|${m}|${d}|${id}|${expires}`)}`);
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
