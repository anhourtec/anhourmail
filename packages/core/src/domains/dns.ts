// SPDX-License-Identifier: AGPL-3.0-only
import { customerDomainRecords, type DnsRecordTemplate } from "@anhourmail/shared/dns";
import type { Platform } from "@anhourmail/shared/platform";

/** Record types we look up. */
export type LookupType = "TXT" | "MX" | "CNAME" | "SRV";

/**
 * DNS lookups (adapter: node:dns in production; a dev resolver that answers for `.test` names).
 * Answers are normalised strings: TXT chunks joined; `MX` "10 host."; `CNAME` "host."; `SRV` "0 1 465 host.".
 * `[]` when the name or record type doesn't exist; throws when the lookup itself failed (timeout, SERVFAIL).
 */
export type DnsResolver = {
  lookup(type: LookupType, fqdn: string): Promise<string[]>;
};

/** `ok`: as expected. `missing`: nothing there. `wrong`: something else is there. `error`: lookup failed. */
export type RecordState = "ok" | "missing" | "wrong" | "error";

/** `problem`: a plain-language reason shown next to the record when it doesn't pass (DKIM only, for now). */
export type CheckedRecord = DnsRecordTemplate & { fqdn: string; state: RecordState; found: string[]; problem?: string };

export const DKIM_NOT_FOUND = "DKIM not found in DNS — mail will fail DKIM.";
export const DKIM_KEY_NOT_PUBLISHED =
  "DKIM not found in DNS — mail will fail DKIM. Your record is right; the key it points to isn't published yet.";

/** A published DKIM public key: a `v=DKIM1` TXT (the tag is optional) with a non-empty `p=` (empty means revoked). */
export function isDkimKey(answer: string): boolean {
  const tags = new Map(
    answer
      .split(";")
      .map((t) => t.trim())
      .filter((t) => t.includes("="))
      .map((t) => {
        const i = t.indexOf("=");
        return [t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).replace(/\s+/g, "")] as const;
      }),
  );
  const v = tags.get("v");
  if (v !== undefined && v.toUpperCase() !== "DKIM1") return false;
  return (tags.get("p") ?? "") !== "";
}

const lower = (s: string) => s.trim().toLowerCase();
const host = (s: string) => lower(s).replace(/\.?$/, ".");
const fqdnOf = (name: string, domain: string) => (name === "@" ? domain : `${name}.${domain}`);

/** Does one answer satisfy the record we asked for? Priorities and weights don't matter; hosts and ports do. */
export function matches(record: DnsRecordTemplate, answer: string): boolean {
  switch (record.purpose) {
    case "spf": {
      // One SPF record per name: ours may be merged into the customer's own. Ours is the include in the template.
      const include = lower(record.value)
        .split(/\s+/)
        .find((t) => t.startsWith("include:"));
      return /^v=spf1\s/i.test(answer) && include !== undefined && lower(answer).split(/\s+/).includes(include);
    }
    case "dmarc":
      // Recommended; any DMARC policy of their own counts.
      return /^v=dmarc1;/i.test(answer.replace(/\s+/g, ""));
    case "ownership":
      return answer.trim() === record.value;
    default:
      break;
  }
  if (record.type === "MX") return host(answer.split(/\s+/).at(-1) ?? "") === host(record.value);
  if (record.type === "SRV") {
    const [, , port, target] = answer.split(/\s+/);
    const [, , wantPort, wantTarget] = record.value.split(/\s+/);
    return port === wantPort && host(target ?? "") === host(wantTarget ?? "");
  }
  return host(answer) === host(record.value);
}

/** Looks up every record for a domain in parallel and grades each one. */
export async function checkRecords(
  dns: DnsResolver,
  domain: string,
  verifyToken: string,
  platform: Platform,
): Promise<CheckedRecord[]> {
  return Promise.all(
    customerDomainRecords(domain, verifyToken, platform).map(async (r): Promise<CheckedRecord> => {
      const fqdn = fqdnOf(r.name, domain);
      try {
        const found = await dns.lookup(r.type, fqdn);
        const state: RecordState = found.length === 0 ? "missing" : found.some((a) => matches(r, a)) ? "ok" : "wrong";
        if (r.purpose !== "dkim") return { ...r, fqdn, state, found: found.slice(0, 5) };
        if (state !== "ok") return { ...r, fqdn, state, found: found.slice(0, 5), problem: DKIM_NOT_FOUND };
        // The CNAME is right; DKIM only passes if the key behind it resolves (a TXT lookup follows the CNAME).
        const keys = await dns.lookup("TXT", fqdn);
        return keys.some(isDkimKey)
          ? { ...r, fqdn, state: "ok", found: found.slice(0, 5) }
          : { ...r, fqdn, state: "missing", found: found.slice(0, 5), problem: DKIM_KEY_NOT_PUBLISHED };
      } catch {
        return { ...r, fqdn, state: "error", found: [] };
      }
    }),
  );
}

/** Every required record is in place (recommended ones only warn). */
export const requiredPass = (records: readonly CheckedRecord[]) =>
  records.every((r) => !r.required || r.state === "ok");
