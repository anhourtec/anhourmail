// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The managed forwarding rule's guard (maintainer decisions 2026-10-30, ADR-0019 updates "forwarding and DMARC"). One
 * source for the web app's generator (`apps/web/src/server/webmail/sieve.ts`), its start-up upgrade and the
 * reconciler, which compares a script's guard with the text expected for that mailbox.
 *
 * The redirect runs only when neither holds:
 *
 * 1. any `Authentication-Results` header with one of our authserv-ids says `dmarc=fail` (a sender who plants one only
 *    stops forwarding of their own message);
 * 2. the From address is on the forwarding mailbox's own domain or a subdomain of it — exactly the case where the
 *    copy's DKIM signature, which Stalwart makes with that domain, would be aligned — and the **top-most** results
 *    header is ours (port 25 mail always has one; mail submitted here has none, so it still forwards) and either the
 *    message has more than one From address or header, or that header does **not** end in a `dmarc=pass` item for the
 *    mailbox's domain (or a subdomain). Only the top-most header counts for "pass", so a planted one can't unlock forwarding,
 *    and the pass test is anchored at the header's end with a regex: Stalwart writes the `dmarc` item last, and a quoted
 *    MAIL FROM local part shows up verbatim inside our own header (`smtp.mailfrom="x; dmarc=pass …"`, verified on
 *    v0.16.27), so a plain substring match could be fooled.
 *
 * Every hostname written into the guard is checked against `isPlainHostname` (no wildcard, quote or backslash).
 */

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;

/** A lowercase hostname with at least one dot and nothing a Sieve pattern or string could read specially. */
export function isPlainHostname(value: string): boolean {
  return value.length <= 253 && HOSTNAME.test(value);
}

/**
 * The authserv-ids we trust: configured (`MAIL_AUTHSERV_ID`, comma-separated), else our MX hosts (plus the dev server's
 * hostname outside production). Stalwart stamps its `defaultHostname`, which the production plan sets to the MX host.
 */
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

/** The ids that can go into the guard: plain hostnames only, lowercased, de-duplicated. */
export function guardIds(authservIds: readonly string[]): string[] {
  return [...new Set(authservIds.map((i) => i.trim().toLowerCase()))].filter(isPlainHostname);
}

/**
 * Our results header's last item says DMARC passed **for the mailbox's own domain or a subdomain of it** (an optional
 * comment without parentheses or quotes, then `header.from=<domain>`, an optional policy), and nothing follows. A pass
 * for any other domain doesn't count: with `From: a@evil.example, ceo@<domain>` a pass for `evil.example` must not
 * unlock forwarding. A Rust/POSIX-class regex for Sieve `:regex`; `domain` must be a plain hostname.
 */
export function dmarcPassRegex(domain: string): string {
  const d = domain.replaceAll(".", String.raw`\.`);
  return (
    String.raw`;[[:space:]]*dmarc=pass( \([^()"]*\))? header\.from=([a-z0-9-]+\.)*` +
    d +
    String.raw`( policy\.dmarc=[a-z]+)?$`
  );
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const list = (xs: readonly string[]) => `[${xs.map(q).join(", ")}]`;

/** The Sieve extensions the guard needs beyond the script's own (only when the own-domain part is written). */
export const GUARD_EXTENSIONS = ["index", "regex", "relational", "comparator-i;ascii-numeric"] as const;

/**
 * The guard's test, on one line (`if not <guard> { redirect … }`), or null without a usable id. Without a usable
 * mailbox domain only part 1 is written (and no extension is needed).
 */
export function forwardingGuard(authservIds: readonly string[], mailboxDomain: string | null): string | null {
  const ids = guardIds(authservIds);
  if (ids.length === 0) return null;
  const failed = `header :matches "Authentication-Results" ${list(ids.map((i) => `${i};*dmarc=fail*`))}`;
  const domain = (mailboxDomain ?? "").trim().toLowerCase();
  if (!isPlainHostname(domain)) return failed;
  const own = `anyof (address :domain :is "from" ${q(domain)}, address :domain :matches "from" ${q(`*.${domain}`)})`;
  const oursOnTop = `header :index 1 :matches "Authentication-Results" ${list(ids.map((i) => `${i};*`))}`;
  // More than one From address or header never passes (Stalwart writes `dmarc=none header.from=` for them, verified).
  const multiFrom = `anyof (address :count "gt" :comparator "i;ascii-numeric" :all "from" "1", header :count "gt" :comparator "i;ascii-numeric" "from" "1")`;
  const passOnTop = `header :index 1 :regex "Authentication-Results" ${q(dmarcPassRegex(domain))}`;
  return `anyof (${failed}, allof (${own}, ${oursOnTop}, anyof (${multiFrom}, not ${passOnTop})))`;
}
