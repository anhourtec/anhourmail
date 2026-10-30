// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Show original": pure helpers for the summary above a message's source. The source itself is only ever rendered as
 * text. Authentication results are trusted only when our own mail server wrote them (RFC 8601 §5): see
 * `authResults` for how that is decided.
 */

import { INTERNAL_MAIL_HEADER, isInternalMailTag } from "@anhourmail/core/webmail";

export type RawHeader = { name: string; value: string };

/**
 * Header names are matched exactly: ASCII-only lowercasing, nothing trimmed (JS `trim()` and `toLowerCase()` also
 * touch Unicode spaces and letters). Stalwart v0.16.27 keeps a name ending in NBSP, a BOM or `\v` as written and its
 * `deleteheader` doesn't remove it (verified 2026-10-30), so such a header is never the one we mean.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
const isNamed = (h: RawHeader, name: string) => asciiLower(h.name) === name;
/** A name with everything but ASCII letters and digits removed: catches look-alike spellings for counting. */
const loose = (name: string) => asciiLower(name).replace(/[^a-z0-9]/g, "");

/** The message's header block in order (folded lines joined), up to the first blank line. */
export function parseHeaderBlock(raw: string): RawHeader[] {
  const end = raw.search(/\r?\n\r?\n/);
  const block = end === -1 ? raw : raw.slice(0, end);
  const out: RawHeader[] = [];
  for (const line of block.split(/\r?\n/)) {
    const last = out.at(-1);
    if (/^[ \t]/.test(line)) {
      if (last) last.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    // Only ASCII space and tab before the colon (RFC 5322 obsolete syntax, which Stalwart reads as the same field).
    out.push({ name: line.slice(0, colon).replace(/^[ \t]+|[ \t]+$/g, ""), value: line.slice(colon + 1).trim() });
  }
  return out;
}

/** Removes RFC 5322 comments (nested parentheses), keeping quoted strings intact. */
export function stripComments(s: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "\\" && i + 1 < s.length) {
      if (depth === 0) out += c + s.charAt(i + 1);
      i++;
      continue;
    }
    if (depth === 0 && c === '"') quoted = !quoted;
    if (!quoted && c === "(") {
      depth++;
      continue;
    }
    if (!quoted && c === ")" && depth > 0) {
      depth--;
      if (depth === 0) out += " ";
      continue;
    }
    if (depth === 0) out += c;
  }
  return out;
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

type ResInfo = { method: string; result: string; props: Record<string, string> };

function parseResInfo(segment: string): ResInfo | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const first = tokens.shift();
  if (!first) return null;
  const m = /^([a-z0-9_-]+)(?:\/\d+)?=([a-z0-9_-]+)$/i.exec(first);
  if (!m?.[1] || !m[2]) return null;
  const props: Record<string, string> = {};
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    props[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { method: m[1].toLowerCase(), result: m[2].toLowerCase(), props };
}

/** One method's result; `domain` is the checked domain (SPF: the mail-from domain, DKIM: the signing domain). */
export type AuthCheck = { result: string; detail: string | null; domain: string | null };
export type AuthSummary = { spf: AuthCheck; dkim: AuthCheck; dmarc: AuthCheck };

const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]+)$/i;
const domainOf = (v: string | undefined): string | null => {
  if (!v) return null;
  const at = v.lastIndexOf("@");
  const d = (at === -1 ? v : v.slice(at + 1)).toLowerCase();
  return d || null;
};

/** The host in a `Received` header's `by` clause, lower-cased, or null. */
export function receivedBy(value: string): string | null {
  const m = /(?:^|\s)by\s+([^\s;]+)/i.exec(stripComments(value));
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * The `Authentication-Results` header our mail server wrote, or null. Stalwart (verified on v0.16.27) writes it only
 * for mail arriving on port 25, directly below the `Received` header it prepends there, and writes neither for
 * authenticated submission (SMTP 465/587 or JMAP) — so a header in a locally sent message is always the sender's.
 * The header is trusted only when the topmost `Received` was stamped `by` one of our hosts and is followed
 * immediately (ARC headers aside) by an `Authentication-Results` carrying our authserv-id. A header with our id
 * anywhere else was written by the sender, or by another hop, and is ignored. The submission Sieve script also strips
 * every `Authentication-Results` header from submitted mail (`@anhourmail/stalwart-client` sender identity), so a
 * forged `Received` plus results pair can't be planted from inside either.
 */
export function ourAuthResultsHeader(headers: readonly RawHeader[], trustedIds: readonly string[]): string | null {
  const trusted = new Set(trustedIds.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const at = headers.findIndex((h) => isNamed(h, "received"));
  const received = headers[at];
  if (!received) return null;
  const by = receivedBy(received.value);
  if (!by || !trusted.has(by)) return null;
  let i = at + 1;
  while (asciiLower(headers[i]?.name ?? "").startsWith("arc-")) i++;
  const ar = headers[i];
  if (!ar || !isNamed(ar, "authentication-results")) return null;
  const [idPart = ""] = splitOutsideQuotes(stripComments(ar.value), ";");
  const authservId = idPart.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return authservId && trusted.has(authservId) ? ar.value : null;
}

/**
 * SPF, DKIM and DMARC as our mail server recorded them, or null when it recorded nothing (mail sent from inside
 * AnhourMail, sent or imported copies) or the only results were written by someone else (`ourAuthResultsHeader`).
 * A method our server didn't report is `none`.
 */
export function authResults(headers: readonly RawHeader[], trustedIds: readonly string[]): AuthSummary | null {
  const value = ourAuthResultsHeader(headers, trustedIds);
  if (value === null) return null;
  const [, ...rest] = splitOutsideQuotes(stripComments(value), ";");
  const infos = rest.map(parseResInfo).filter((r): r is ResInfo => r !== null);
  const of = (method: string) => infos.filter((r) => r.method === method);

  const spfAll = of("spf");
  const spf = spfAll.find((r) => r.props["smtp.mailfrom"] !== undefined) ?? spfAll[0];
  const iprev = of("iprev")[0];
  const ip =
    Object.values(spf?.props ?? {}).find((v) => IP.test(v)) ??
    Object.values(iprev?.props ?? {}).find((v) => IP.test(v)) ??
    null;
  const dkimAll = of("dkim");
  const dkim = dkimAll.find((r) => r.result === "pass") ?? dkimAll[0];
  const dmarc = of("dmarc")[0];
  const none: AuthCheck = { result: "none", detail: null, domain: null };
  const spfDomain = domainOf(spf?.props["smtp.mailfrom"] ?? spf?.props["smtp.helo"]);
  const dkimDomain = domainOf(dkim?.props["header.d"] ?? dkim?.props["header.i"]);
  const dmarcDomain = domainOf(dmarc?.props["header.from"]);
  const withDomain = (pass: boolean, d: string | null) => (pass && d ? `with domain ${d}` : null);
  return {
    spf: spf
      ? { result: spf.result, detail: spf.result === "pass" && ip ? `with IP ${ip}` : null, domain: spfDomain }
      : none,
    dkim: dkim
      ? { result: dkim.result, detail: withDomain(dkim.result === "pass", dkimDomain), domain: dkimDomain }
      : none,
    dmarc: dmarc
      ? { result: dmarc.result, detail: withDomain(dmarc.result === "pass", dmarcDomain), domain: dmarcDomain }
      : none,
  };
}

/** The protocol in a `Received` header's `with` clause, lower-cased, or null. */
export function receivedWith(value: string): string | null {
  const m = /(?:^|\s)with\s+([^\s;]+)/i.exec(stripComments(value));
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether our own server vouches that `from` submitted this message here (the internal-mail marker, ADR-0019 update
 * 2026-10-30). Only the `sender-identity` script adds the header — to authenticated submissions whose recipients are
 * all local, after checking From is exactly the account's envelope sender and removing any the client sent — and the
 * `inbound-headers` script removes it from everything arriving from outside. True only when:
 *
 * - exactly one header is named like the marker (look-alike spellings counted), and its name is exactly it; the same
 *   for `From` and `Message-ID`;
 * - the marker equals the tag for `from` and that Message-ID under `key`;
 * - nothing shows the message arrived on port 25 (a second barrier if the inbound strip were ever off — Stalwart skips
 *   a missing or inactive system script, verified): no `Authentication-Results` or `Received-SPF` anywhere (the
 *   submission script deletes every results header, and only port 25 gets either), and no `Received` stamped by one of
 *   `trustedIds` with anything but LMTP (a redirect adds only an LMTP one; submissions add none).
 *
 * So a redirected copy of internal mail passes and one of outside mail fails. False on any doubt, including a malformed
 * key.
 */
export function isInternalMail(
  headers: readonly RawHeader[],
  from: string,
  key: string,
  trustedIds: readonly string[],
): boolean {
  const trusted = new Set(trustedIds.map((t) => asciiLower(t.trim())).filter(Boolean));
  const one = (name: string): RawHeader | null => {
    const like = headers.filter((h) => loose(h.name) === loose(name));
    const only = like[0];
    return like.length === 1 && only && isNamed(only, name) ? only : null;
  };
  for (const h of headers) {
    const n = loose(h.name);
    if (n === "authenticationresults" || n === "receivedspf") return false;
    if (n === "received") {
      const by = receivedBy(h.value);
      if (by !== null && trusted.has(by) && receivedWith(h.value) !== "lmtp") return false;
    }
  }
  const marker = one(INTERNAL_MAIL_HEADER.toLowerCase());
  const id = one("message-id");
  if (!marker || !id || !one("from")) return false;
  try {
    return isInternalMailTag(key, from, id.value, marker.value);
  } catch {
    return false;
  }
}

/** "mailed-by" and "signed-by" for a message's details: the passing SPF and DKIM domains, else null. */
export function senderChecks(a: AuthSummary | null): { mailedBy: string | null; signedBy: string | null } {
  return {
    mailedBy: a?.spf.result === "pass" ? a.spf.domain : null,
    signedBy: a?.dkim.result === "pass" ? a.dkim.domain : null,
  };
}

/** "PASS with IP 192.0.2.1", "FAIL", "NONE". */
export const authLabel = (c: AuthCheck): string => `${c.result.toUpperCase()}${c.detail ? ` ${c.detail}` : ""}`;

/**
 * Seconds between the Date header and when our server received the message, or null when either is missing or
 * unreadable. A Date slightly in the future (clock skew) counts as no delay.
 */
export function deliveryDelaySeconds(
  sentAt: string | null | undefined,
  receivedAt: string | null | undefined,
): number | null {
  if (!sentAt || !receivedAt) return null;
  const sent = Date.parse(sentAt);
  const received = Date.parse(receivedAt);
  if (Number.isNaN(sent) || Number.isNaN(received)) return null;
  return Math.max(0, Math.round((received - sent) / 1000));
}

/** "Delivered after 3 seconds", "after 4 minutes", "after 2 hours", "after 3 days". */
export function delayLabel(seconds: number): string {
  const unit = (n: number, w: string) => `${String(n)} ${w}${n === 1 ? "" : "s"}`;
  if (seconds < 120) return `Delivered after ${unit(seconds, "second")}`;
  if (seconds < 120 * 60) return `Delivered after ${unit(Math.round(seconds / 60), "minute")}`;
  if (seconds < 48 * 3600) return `Delivered after ${unit(Math.round(seconds / 3600), "hour")}`;
  return `Delivered after ${unit(Math.round(seconds / 86400), "day")}`;
}

/** The authserv-ids we trust: configured, else our MX hosts (plus the dev server's hostname outside production). */
export function trustedAuthservIds(
  configured: string | undefined,
  mxHosts: readonly string[],
  production: boolean,
): string[] {
  const set = (configured ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (set.length > 0) return set;
  return [...mxHosts.map((h) => h.toLowerCase()), ...(production ? [] : ["mail.dev.test"])];
}
