// SPDX-License-Identifier: MIT
/**
 * DKIM public keys from a domain's `dnsZoneFile` (`x:Domain/get`; shape verified on the pinned v0.16.27, 2026-10-28).
 * Stalwart writes one TXT per signing key at `<selector>._domainkey.<domain>.`; short keys (Ed25519) are one quoted
 * string, long ones (RSA-2048) a parenthesised list of quoted strings across several lines:
 *
 *     v1-ed25519-20261028._domainkey.example.org. IN TXT "v=DKIM1; k=ed25519; h=sha256; p=MVJu…"
 *     v1-rsa-20261028._domainkey.example.org. IN TXT (
 *         "v=DKIM1; k=rsa; h=sha256; p=MIIBIjAN…"
 *         "g5EImsug…IDAQAB"
 *     )
 *
 * A TXT record's strings are joined without separators (RFC 7208 §3.3 / RFC 6376 §3.6.2.2), which is what a
 * resolver returns and what the customer publishes as one value.
 */

/** One DKIM key as the customer publishes it: TXT at `<selector>._domainkey`, value `v=DKIM1; k=…; p=…`. */
export type DkimRecord = { selector: string; value: string };

/** Splits a zone file into records: newlines end a record unless inside quotes or parentheses; `;` starts a comment. */
function records(zone: string): string[][] {
  const out: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quoted: string | null = null;
  let depth = 0;
  const flushToken = () => {
    if (token !== "") tokens.push(token);
    token = "";
  };
  const flushRecord = () => {
    flushToken();
    if (tokens.length > 0) out.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < zone.length; i++) {
    const c = zone.charAt(i);
    if (quoted !== null) {
      if (c === "\\" && i + 1 < zone.length) {
        quoted += zone.charAt(++i);
      } else if (c === '"') {
        // A quoted string is kept with a marker so it can't be confused with a bare word.
        tokens.push(`"${quoted}`);
        quoted = null;
      } else {
        quoted += c;
      }
      continue;
    }
    if (c === '"') {
      flushToken();
      quoted = "";
    } else if (c === ";") {
      while (i + 1 < zone.length && zone.charAt(i + 1) !== "\n") i++;
    } else if (c === "(") {
      flushToken();
      depth++;
    } else if (c === ")") {
      flushToken();
      depth = Math.max(0, depth - 1);
    } else if (c === "\n") {
      if (depth === 0) flushRecord();
      else flushToken();
    } else if (/\s/.test(c)) {
      flushToken();
    } else {
      token += c;
    }
  }
  flushRecord();
  return out;
}

const CLASSES = new Set(["IN", "CH", "HS"]);

/**
 * The DKIM TXT records in a zone file for `domain`, in zone order. Only names directly under `_domainkey.<domain>`
 * with a published key (`p=` non-empty) count; anything else in the zone is ignored.
 */
export function parseDkimRecords(zone: string, domain: string): DkimRecord[] {
  const suffix = `._domainkey.${domain.toLowerCase().replace(/\.$/, "")}.`;
  const found: DkimRecord[] = [];
  for (const rec of records(zone)) {
    const [owner, ...rest] = rec;
    if (owner === undefined || owner.startsWith('"')) continue;
    const name = (owner.endsWith(".") ? owner : `${owner}.`).toLowerCase();
    if (!name.endsWith(suffix)) continue;
    const selector = name.slice(0, -suffix.length);
    if (selector === "" || selector.includes(".")) continue;
    // Optional TTL and class before the type.
    let i = 0;
    while (i < rest.length && (/^\d+$/.test(rest[i] ?? "") || CLASSES.has((rest[i] ?? "").toUpperCase()))) i++;
    if ((rest[i] ?? "").toUpperCase() !== "TXT") continue;
    const value = rest
      .slice(i + 1)
      .filter((t) => t.startsWith('"'))
      .map((t) => t.slice(1))
      .join("")
      .trim();
    if (!hasKey(value)) continue;
    found.push({ selector, value });
  }
  return found;
}

/** The tags of a DKIM key record (`v=DKIM1; k=rsa; p=…`), names lowercased, whitespace removed from values. */
export function dkimTags(value: string): Map<string, string> {
  return new Map(
    value
      .split(";")
      .map((t) => t.trim())
      .filter((t) => t.includes("="))
      .map((t) => {
        const i = t.indexOf("=");
        return [t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).replace(/\s+/g, "")] as const;
      }),
  );
}

function hasKey(value: string): boolean {
  const tags = dkimTags(value);
  const v = tags.get("v");
  return (v === undefined || v.toUpperCase() === "DKIM1") && (tags.get("p") ?? "") !== "";
}
