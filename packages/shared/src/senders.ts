// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sender lists (docs/internal/05-webmail.md "Settings" and "Remote images", ADR-0027): the mailbox's Blocked and Safe
 * senders. One entry is an address ("jane@example.com") or a domain ("example.com"), lower-cased, with an
 * internationalised domain kept in its ASCII (`xn--`) form. The same entry means the same thing everywhere: the junk
 * rules compiled into the managed Sieve script (`address :all :is` / `address :domain :is`, no subdomains) and the
 * webmail's "Safe senders load images" check (`matchSafeSender`).
 *
 * No dependencies (shared with the browser): IDN conversion uses the WHATWG URL parser, which does the same mapping
 * as `domainToASCII` in Node and in every browser.
 */

/** Entries in each of the blocked and safe lists. */
export const MAX_SENDER_ENTRIES = 300;

/** A domain of ASCII labels (A-labels allowed), at least two of them. */
export const SENDER_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/**
 * An address whose domain is `SENDER_DOMAIN`. The local part: no spaces, quotes or Sieve/header specials, no control
 * characters, and no direction or zero-width marks (they can make one address look like another on screen).
 */
export const SENDER_ADDRESS =
  /^[^\s@"<>()[\]\\,;:\p{Cc}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** Characters that would make the URL parser read something other than a bare host. */
const NOT_A_HOST = /[\s/?#@:\\[\]%]/;

/**
 * A domain in its ASCII form (lower-cased; a typed U-label such as "bücher.example" becomes "xn--bcher-kva.example"),
 * or null when it can't be one. Doesn't check the result against `SENDER_DOMAIN`.
 */
export function asciiDomain(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (v === "") return null;
  if (/^[\x21-\x7e]*$/.test(v)) return v;
  if (NOT_A_HOST.test(v)) return null;
  try {
    const host = new URL(`http://${v}`).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/** An address with its domain in ASCII form (lower-cased), or null when it has no usable domain. */
function asciiAddress(v: string): string | null {
  const at = v.lastIndexOf("@");
  if (at <= 0 || at === v.length - 1) return null;
  const domain = asciiDomain(v.slice(at + 1));
  return domain === null ? null : `${v.slice(0, at)}@${domain}`;
}

/** "jane@example.com" stays an address; "@example.com" and "example.com" become the domain "example.com". */
export function senderEntry(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (v.length === 0 || v.length > 254) return null;
  if (v.startsWith("@")) {
    const d = asciiDomain(v.slice(1));
    return d !== null && d.length <= 253 && SENDER_DOMAIN.test(d) ? d : null;
  }
  if (v.includes("@")) {
    const a = asciiAddress(v);
    return a !== null && a.length <= 254 && SENDER_ADDRESS.test(a) ? a : null;
  }
  const d = asciiDomain(v);
  return d !== null && d.length <= 253 && SENDER_DOMAIN.test(d) ? d : null;
}

/** Which entry of a list a sender matched: its whole address, or its domain exactly (never a parent domain). */
export type SafeSenderMatch = { kind: "address" | "domain"; value: string };

/** A sender list split for lookups (`matchSafeSender` takes either form). */
export type SenderSets = { addresses: ReadonlySet<string>; domains: ReadonlySet<string> };

/** Splits list entries into addresses and domains (entries are expected to be `senderEntry` output). */
export function senderSets(list: readonly string[]): SenderSets {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const e of list) (e.includes("@") ? addresses : domains).add(e);
  return { addresses, domains };
}

/** Lower-cases A–Z only: no Unicode case mapping (the Kelvin sign U+212A must not become "k"). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * A message's From address in the one form both checks use, or null. Its domain must already be plain ASCII (an
 * A-label is fine): nothing is mapped — no fullwidth letters, no ideographic full stop (U+3002), no Kelvin sign — so the
 * domain matched here is exactly the domain the sender verification checked (`senderVerified` compares the raw From
 * domain with our results). Only A–Z are lower-cased.
 */
export function fromAddress(from: string): string | null {
  const v = from.trim();
  const at = v.lastIndexOf("@");
  if (at <= 0 || at === v.length - 1 || v.length > 254) return null;
  const domain = v.slice(at + 1);
  if (!/^[\x21-\x7e]+$/.test(domain)) return null;
  const address = `${asciiLower(v.slice(0, at))}@${asciiLower(domain)}`;
  return SENDER_ADDRESS.test(address) ? address : null;
}

/**
 * Whether `from` (a message's From address) is on a sender list: an address entry equal to the whole address wins,
 * then a domain entry equal to its domain. The From is taken as `fromAddress` gives it (ASCII domain, A–Z lower-cased,
 * nothing else mapped); entries are `senderEntry` output. No subdomains: "example.com" doesn't cover
 * "news.example.com", exactly as the junk rules' `address :domain :is` test.
 */
export function matchSafeSender(from: string, list: readonly string[] | SenderSets): SafeSenderMatch | null {
  const address = fromAddress(from);
  if (address === null) return null;
  const sets = Array.isArray(list) ? senderSets(list as readonly string[]) : (list as SenderSets);
  if (sets.addresses.has(address)) return { kind: "address", value: address };
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (sets.domains.has(domain)) return { kind: "domain", value: domain };
  return null;
}
