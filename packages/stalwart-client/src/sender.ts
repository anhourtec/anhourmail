// SPDX-License-Identifier: MIT
import { StalwartError } from "./client";
import type { StalwartManagement } from "./management";

/**
 * Sender identity enforcement (ADR-0019). Stalwart's `mustMatchSender` checks only the SMTP envelope, so an
 * authenticated account could show another address in the visible From header — local or external — on mail we
 * DKIM-sign. This Sieve system script runs at DATA for authenticated sessions (SMTP 465/587 and JMAP
 * EmailSubmission, which goes through the same stage) and requires exactly one From address equal to the
 * already-validated envelope sender, and, if a Sender header is present, exactly one Sender address equal to it too.
 *
 * Verified against Stalwart v0.16.27: own address, own alias and a group member sending as the group (envelope and
 * header both the group) are accepted; a forged header From, two From addresses, a forged Sender, a second Sender
 * header and a missing From are refused with 5.5.3. Match variables (`${1}`) are not populated in this context, so
 * the script compares against `${envelope.from}` directly.
 *
 * One keyed exception, "send on behalf" (ADR-0026 §8, ADR-0019 updates 2026-10-30), present only when a key is given:
 * a single Sender address that differs from the envelope sender passes when the message has exactly one Message-ID
 * (in the web app's `local@host` form), exactly one `X-AnhourMail-On-Behalf-Expires` (UTC, not yet passed by the
 * server's `currentdate`) and carries `X-AnhourMail-On-Behalf` equal to
 * hex sha256(key | hex sha256(key | lowercase envelope sender | lowercase Sender address | Message-ID | expiry)). The
 * tag is bound to the message and expires within minutes, so one copied from a stored message is useless on any other,
 * and on the same one soon after. An unreadable Message-ID reads as empty in an expression rather than failing it
 * (verified on v0.16.27), so its form is checked before it is hashed. From must still equal the
 * envelope sender, so only someone signed in as the mailbox itself (in practice the web app holding its token) can use
 * it. The computed tag must be 64 lowercase hex before it is compared: a failed expression leaves the variable empty
 * (verified), which an empty tag header would otherwise match. Both headers are removed from every submission, so they
 * are never delivered. Verified on v0.16.27 (`vnd.stalwart.expressions` `let` + nested `hash(…, 'sha256')` and
 * `header.message-id` at DATA; ADR-0026 probe P8, `stack:verify`).
 */
export const SENDER_IDENTITY_SCRIPT = "sender-identity";

/** The header the web app adds for a send on behalf; the script checks it and always removes it. */
export const SENDER_ON_BEHALF_HEADER = "X-AnhourMail-On-Behalf";
/** The tag's expiry (UTC, `YYYY-MM-DDTHH:MM:SSZ`), bound into the tag; checked against the server's clock, removed. */
export const SENDER_ON_BEHALF_EXPIRES_HEADER = "X-AnhourMail-On-Behalf-Expires";

/**
 * The internal-mail marker (ADR-0019 update 2026-10-30): with a key, the script adds it to every authenticated
 * submission it accepts whose recipients are all local (after removing any the client sent), bound to the envelope
 * sender and the Message-ID; the
 * `inbound-headers` script removes it from everything arriving on an unauthenticated session. The webmail recomputes it
 * (`internalMailTag` in `@anhourmail/core/webmail`) to treat a locally submitted message's From as verified.
 */
export const INTERNAL_MAIL_HEADER = "X-AnhourMail-Internal";

/** The system script run at DATA for unauthenticated sessions (port 25): removes headers only our server may add. */
export const INBOUND_HEADERS_SCRIPT = "inbound-headers";

/**
 * Removes the internal-mail marker from mail arriving from outside, so a copy of one from a genuine message (or a
 * made-up one) never reaches a mailbox. Nothing else is touched: inbound checks and their results are unaffected.
 */
export const INBOUND_HEADERS_SIEVE = `require ["editheader"];

# AnhourMail inbound headers (ADR-0019 update 2026-10-30). Runs at DATA for unauthenticated sessions only
# (MtaStageData.script). Only our own server adds this header, to mail an account submitted here; never accept one
# from outside.
deleteheader "${INTERNAL_MAIL_HEADER}";
`;

const ON_BEHALF_KEY = /^[0-9a-f]{64}$/;

/**
 * The most recipients a marked message may have (Stalwart's default `MtaStageRcpt.maxRecipients`). The script checks
 * every recipient's domain by index, so a message with more gets no marker (fail safe: its readers are asked first).
 */
export const INTERNAL_MAIL_MAX_RECIPIENTS = 100;

/**
 * True ("1") only when the message has 1..max envelope recipients and every one is on a domain this server hosts.
 * Verified on v0.16.27: `envelope.to` is the recipient array in a DATA-stage `let`, `envelope.to[i]` past its end
 * reads as empty, `||` short-circuits, and `is_local_domain` works there. No marker for mail that leaves the server.
 */
export function allRecipientsLocalExpression(max = INTERNAL_MAIL_MAX_RECIPIENTS): string {
  const each = Array.from(
    { length: max },
    (_, i) =>
      `(is_empty(envelope.to[${String(i)}]) || is_local_domain(email_part(envelope.to[${String(i)}], 'domain')))`,
  );
  return [`count(envelope.to) >= 1`, `count(envelope.to) <= ${String(max)}`, ...each].join(" && ");
}

/**
 * The script text. Without `onBehalfKey` every Sender that differs from the envelope sender is refused (the ADR-0019
 * rule). With it, the keyed exception above is compiled in: the key is written into the script text (it lives in the
 * mail server's data store, readable only by its administrator), so it must be exactly 64 lowercase hex characters —
 * nothing that could end the Sieve or expression string it sits in. Never log the result.
 */
export function senderIdentitySieve(opts: { onBehalfKey?: string | undefined } = {}): string {
  const key = opts.onBehalfKey;
  if (key !== undefined && !ON_BEHALF_KEY.test(key)) {
    throw new Error("The on-behalf key must be 64 lowercase hex characters");
  }
  const requires = `"envelope", "variables", "relational", "comparator-i;ascii-numeric", "reject", "editheader"${
    key === undefined ? "" : `, "regex", "date", "vnd.stalwart.expressions"`
  }`;
  const refuseSender = `reject "The Sender address must match the address you are sending from.";
    stop;`;
  const refuse = `      ${refuseSender.replace("\n    ", "\n      ")}`;
  const inner = `hash('${key ?? ""}|' + to_lowercase(envelope.from) + '|' + to_lowercase(header.sender.addr) + '|' + header.message-id + '|' + header.${SENDER_ON_BEHALF_EXPIRES_HEADER.toLowerCase()}, 'sha256')`;
  const differentSender =
    key === undefined
      ? `    ${refuseSender}`
      : `    # Send on behalf (ADR-0026 §8): only with the web app's tag for exactly this mailbox, delegate, message and expiry.
    if header :count "ne" :comparator "i;ascii-numeric" "message-id" "1" {
      reject "Sending on behalf needs exactly one Message-ID header.";
      stop;
    }
    if header :count "ne" :comparator "i;ascii-numeric" "${SENDER_ON_BEHALF_EXPIRES_HEADER}" "1" {
${refuse}
    }
    # An unreadable Message-ID reads as empty (verified), and so would hash to a constant: only the web app's form.
    let "onbehalfid" "header.message-id";
    if not string :regex "\${onbehalfid}" "^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,200}$" {
${refuse}
    }
    let "onbehalfexp" "header.${SENDER_ON_BEHALF_EXPIRES_HEADER.toLowerCase()}";
    if not string :regex "\${onbehalfexp}" "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" {
${refuse}
    }
    # Both are UTC in the same form, so comparing them as text compares the times. Fail closed: only a comparison
    # that proves "now <= expiry" passes (one that can't be made doesn't match, so the message is refused).
    if not currentdate :zone "+0000" :value "le" "iso8601" "\${onbehalfexp}" {
${refuse}
    }
    let "onbehalf" "hash('${key}|' + ${inner}, 'sha256')";
    # A failed expression leaves the variable empty: never compare anything but a real digest.
    if not string :regex "\${onbehalf}" "^[0-9a-f]{64}$" {
${refuse}
    }
    if not header :is "${SENDER_ON_BEHALF_HEADER}" "\${onbehalf}" {
${refuse}
    }`;
  // From is exactly the envelope sender by now; bind the marker to it and to the one Message-ID in the web app's form
  // (an unreadable one reads as "", so the form is checked first; no marker otherwise). Only for mail that stays here:
  // every recipient on a domain we host, so outside recipients never receive a marker.
  const internalMarker =
    key === undefined
      ? ""
      : `let "internallocal" "${allRecipientsLocalExpression()}";
if allof (string :is "\${internallocal}" "1", header :count "eq" :comparator "i;ascii-numeric" "message-id" "1") {
  let "internalid" "header.message-id";
  if string :regex "\${internalid}" "^[A-Za-z0-9._%+=-]{1,200}@[A-Za-z0-9.-]{1,200}$" {
    let "internaltag" "hash('${key}|' + hash('${key}|internal-mail-v1|' + to_lowercase(envelope.from) + '|' + header.message-id, 'sha256'), 'sha256')";
    # A failed expression leaves the variable empty: add only a real digest.
    if string :regex "\${internaltag}" "^[0-9a-f]{64}$" {
      addheader "${INTERNAL_MAIL_HEADER}" "\${internaltag}";
    }
  }
}
`;
  return `require [${requires}];

# AnhourMail sender identity (ADR-0019). Runs at DATA for authenticated submissions only (MtaStageData.script).
# mustMatchSender has already checked the envelope sender against the account's own address, aliases and groups;
# here the visible From (and Sender, if present) must be exactly that address.

if not exists "from" {
  reject "A From header is required.";
  stop;
}

if address :count "ne" :comparator "i;ascii-numeric" :all "from" "1" {
  reject "Use exactly one address in the From header.";
  stop;
}

if not address :all :comparator "i;unicode-casemap" :is "from" "\${envelope.from}" {
  reject "The From address must match the address you are sending from.";
  stop;
}

if exists "sender" {
  # Counted over every Sender header: a second one (or a second address) could otherwise ride along with a match.
  if address :count "ne" :comparator "i;ascii-numeric" :all "sender" "1" {
    reject "Use exactly one address in the Sender header.";
    stop;
  }
  if not address :all :comparator "i;unicode-casemap" :is "sender" "\${envelope.from}" {
${differentSender}
  }
}

# The on-behalf tag and its expiry are for this check only: never delivered, whatever the outcome above.
deleteheader "${SENDER_ON_BEHALF_HEADER}";
deleteheader "${SENDER_ON_BEHALF_EXPIRES_HEADER}";

# Stalwart stamps no Authentication-Results on authenticated submissions, so any such header here was written by
# the sender and could claim checks our server never ran (RFC 8601 section 5). Remove them all.
deleteheader "Authentication-Results";

# The internal-mail marker is ours alone: whatever the client sent is removed${key === undefined ? " (no key, so none is added)." : ", then ours is added."}
deleteheader "${INTERNAL_MAIL_HEADER}";
${internalMarker}`;
}

/** The script without the on-behalf exception (every differing Sender refused). */
export const SENDER_IDENTITY_SIEVE = senderIdentitySieve();

/**
 * The DATA-stage expression: the sender-identity script for authenticated sessions, the inbound-headers script for
 * everything else (port 25; it only removes the internal-mail marker, so inbound checks are unaffected).
 */
export const SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION = {
  match: { "0": { if: "!is_empty(authenticated_as)", then: `'${SENDER_IDENTITY_SCRIPT}'` } },
  else: `'${INBOUND_HEADERS_SCRIPT}'`,
} as const;

type ScriptRow = { id: string; name: string; contents?: string; isActive?: boolean };

/**
 * Installs or updates the sender-identity and inbound-headers scripts and wires them into the DATA stage, keeping
 * `mustMatchSender` on. `onBehalfKey` (`SENDER_DELEGATION_KEY`) compiles in the send-on-behalf exception and the
 * internal-mail marker; without it the strict script is installed and no marker is added. Idempotent. Callers run
 * `reloadSettings()` afterwards (the DATA-stage expression is compiled).
 */
export async function applySenderIdentityPolicy(
  mgmt: StalwartManagement,
  opts: { onBehalfKey?: string | undefined } = {},
): Promise<{ scriptId: string; inboundScriptId: string }> {
  const contents = senderIdentitySieve(opts); // throws on a malformed key, naming no value
  try {
    return await applyPolicy(mgmt, contents);
  } catch (err) {
    // Stalwart's SetError descriptions can quote the script text, which holds the on-behalf key: never pass them on,
    // not even as `cause` (loggers and error reports walk it). Only the call that failed is named.
    const kind = err instanceof StalwartError ? `${err.kind}: ${err.message}` : "unexpected error";
    // eslint-disable-next-line preserve-caught-error -- the cause can quote the script text, which holds the key
    throw new Error(`Could not apply the sender-identity policy (${kind}; details withheld, the script holds a key)`);
  }
}

async function upsertScript(
  mgmt: StalwartManagement,
  scripts: readonly ScriptRow[],
  name: string,
  description: string,
  contents: string,
): Promise<string> {
  const t = mgmt.transport;
  const existing = scripts.find((s) => s.name === name);
  if (existing) {
    // Stalwart stores the text without its final newline (verified on v0.16.27), so compare without trailing space.
    if (existing.contents?.trimEnd() !== contents.trimEnd() || existing.isActive !== true) {
      await t.set("x:SieveSystemScript", {
        update: { [existing.id]: { contents, isActive: true } },
      });
    }
    return existing.id;
  }
  const { created } = await t.set("x:SieveSystemScript", {
    create: { s: { name, description, isActive: true, contents } },
  });
  const id = created.s?.id;
  if (!id) throw new Error(`${name} script was not created`);
  return id;
}

async function applyPolicy(
  mgmt: StalwartManagement,
  contents: string,
): Promise<{ scriptId: string; inboundScriptId: string }> {
  const scripts = await mgmt.transport.getAll<ScriptRow>("x:SieveSystemScript", ["name", "contents", "isActive"]);
  const scriptId = await upsertScript(
    mgmt,
    scripts,
    SENDER_IDENTITY_SCRIPT,
    "Header From and Sender must equal the authenticated envelope sender (ADR-0019, ADR-0026)",
    contents,
  );
  // Both scripts exist before the expression names them.
  const inboundScriptId = await upsertScript(
    mgmt,
    scripts,
    INBOUND_HEADERS_SCRIPT,
    "Remove the internal-mail marker from mail arriving from outside (ADR-0019)",
    INBOUND_HEADERS_SIEVE,
  );
  await mgmt.updateSingleton("x:MtaStageData", { script: SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION });
  await mgmt.updateSingleton("x:MtaStageAuth", { mustMatchSender: { match: {}, else: "true" } });
  return { scriptId, inboundScriptId };
}
