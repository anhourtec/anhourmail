// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver } from "node:dns/promises";

import type { DnsResolver, LookupType } from "@anhourmail/core/domains";
import { customerDomainRecords } from "@anhourmail/shared/dns";
import type { Platform } from "@anhourmail/shared/platform";

/** "Doesn't exist" answers become `[]`; anything else (timeout, SERVFAIL, refused) is a failed lookup. */
const EMPTY = new Set(["ENOTFOUND", "ENODATA", "ENONAME"]);

const dot = (h: string) => `${h.replace(/\.$/, "")}.`;

/**
 * Real DNS through the system's configured servers, with a short timeout so a slow zone can't hold a request.
 * Answers are normalised to the `DnsResolver` string forms.
 */
export function systemResolver(opts: { timeoutMs?: number; servers?: string[] } = {}): DnsResolver {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? 3000, tries: 2 });
  if (opts.servers?.length) resolver.setServers(opts.servers);
  return {
    async lookup(type: LookupType, fqdn: string): Promise<string[]> {
      try {
        switch (type) {
          case "TXT":
            return (await resolver.resolveTxt(fqdn)).map((chunks) => chunks.join(""));
          case "MX":
            return (await resolver.resolveMx(fqdn)).map((r) => `${String(r.priority)} ${dot(r.exchange)}`);
          case "CNAME":
            return (await resolver.resolveCname(fqdn)).map(dot);
          case "SRV":
            return (await resolver.resolveSrv(fqdn)).map(
              (r) => `${String(r.priority)} ${String(r.weight)} ${String(r.port)} ${dot(r.name)}`,
            );
        }
      } catch (err) {
        if (EMPTY.has((err as { code?: string }).code ?? "")) return [];
        throw err;
      }
    },
  };
}

/**
 * Development only: `.test` names (a reserved TLD that can never resolve on the internet) answer as if the
 * customer published every record correctly — except names starting with `unverified-`, which have none, so both
 * console states can be tried. Records point at `platform` (the configured platform domain), so they pass the same
 * checks the console runs. Everything else goes to `fallback`. Never wired up in production.
 */
export function devResolver(
  fallback: DnsResolver,
  tokens: (domain: string) => Promise<string[]>,
  platform: Platform,
): DnsResolver {
  return {
    async lookup(type, fqdn) {
      const name = fqdn.replace(/\.$/, "").toLowerCase();
      if (!name.endsWith(".test")) return fallback.lookup(type, fqdn);
      const labels = name.split(".");
      // The customer domain is the last two labels (dev domains are always second-level under .test).
      const domain = labels.slice(-2).join(".");
      if (domain.startsWith("unverified-")) return [];
      // Every account that added the name gets its own ownership TXT (as if each had published it).
      const answers = new Set<string>();
      for (const token of await tokens(domain)) {
        for (const r of customerDomainRecords(domain, token, platform)) {
          if (r.type !== type || (r.name === "@" ? domain : `${r.name}.${domain}`) !== name) continue;
          answers.add(r.type === "MX" ? `${String(r.priority ?? 10)} ${r.value}` : r.value);
        }
      }
      return [...answers];
    },
  };
}
