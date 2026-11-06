// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Disposable email check (core `DisposableEmailCheck`, ADR-0033). Two checks, one verdict:
 *
 * 1. **Domain list:** the address's domain or any parent domain (never the bare top-level label) is on the vendored
 *    list (`data.generated.ts`) or the deployment's extra list, and not on its allow list. Local; no network.
 * 2. **Mail server:** the domain's MX hosts (or the domain itself when it has none, RFC 5321 §5.1) resolve to an IPv4
 *    address on the vendored disposable mail-server list. MX hosts on a shared provider's suffix (`shared-hosts.ts`)
 *    are skipped (their addresses are never on the list anyway), and reserved or internal names are never looked up.
 *
 * Fails open: a lookup error or a check slower than the budget counts as not disposable, logged with the domain only.
 * The mail-server answer for a domain is cached (positive and negative) through `cache`, a day by default.
 */
import { Resolver } from "node:dns/promises";

import type { DisposableEmailCheck, DisposableVerdict } from "@anhourmail/core/security";
import { DISPOSABLE_EMAIL } from "@anhourmail/shared/security";

import { DISPOSABLE_DOMAINS, DISPOSABLE_MAIL_SERVERS, DISPOSABLE_SOURCE } from "./data.generated";
import { isSharedMailHost } from "./shared-hosts";

export { DISPOSABLE_SOURCE };
export { isSharedMailHost, isSharedOrReservedIp, SHARED_MAIL_SUFFIXES } from "./shared-hosts";

const lines = (text: string): Set<string> =>
  new Set(
    text
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );

const LISTED = lines(DISPOSABLE_DOMAINS);
const SERVERS = lines(DISPOSABLE_MAIL_SERVERS);

/** The domain of an address, lowercased, without a trailing dot; null when it isn't one. */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const d = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 253 ? d : null;
}

/** `a.b.example.com` → `a.b.example.com`, `b.example.com`, `example.com` (never `com`). */
export function domainAndParents(domain: string): string[] {
  const labels = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** Comma- or whitespace-separated domains from a setting, lowercased. */
export function domainList(setting: string | undefined): Set<string> {
  return new Set(
    (setting ?? "")
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean),
  );
}

/** Whether the domain (or a parent) is on the list, honouring the extra and allow lists. */
export function listedDomain(
  domain: string,
  extra: ReadonlySet<string> = new Set(),
  allow: ReadonlySet<string> = new Set(),
): boolean {
  const names = domainAndParents(domain);
  if (names.some((n) => allow.has(n))) return false;
  return names.some((n) => LISTED.has(n) || extra.has(n));
}

/** Whether an IPv4 address is on the vendored disposable mail-server list. */
export const disposableMailServer = (ip: string): boolean => SERVERS.has(ip);

export type MailServerLookup = {
  /** MX host names for a domain ([] when it has none); throws on failure. */
  mx(domain: string): Promise<string[]>;
  /** IPv4 addresses for a host ([] when it has none); throws on failure. */
  ipv4(host: string): Promise<string[]>;
};

const EMPTY = new Set(["ENOTFOUND", "ENODATA", "ENONAME"]);
const empty = (err: unknown): boolean => EMPTY.has((err as { code?: string }).code ?? "");

/** Real DNS (the system's resolvers), 1 s per query, one try. */
export function dnsMailServerLookup(timeoutMs = 1000): MailServerLookup {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return {
    async mx(domain) {
      try {
        return (await resolver.resolveMx(domain))
          .map((m) => m.exchange.toLowerCase().replace(/\.$/, ""))
          .filter(Boolean);
      } catch (err) {
        if (empty(err)) return [];
        throw err;
      }
    },
    async ipv4(host) {
      try {
        return await resolver.resolve4(host);
      } catch (err) {
        if (empty(err)) return [];
        throw err;
      }
    },
  };
}

/** A small key-value cache for the mail-server answer ("1" disposable, "0" not); failures are the caller's problem. */
export type VerdictCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
};

export type WarnLogger = { warn(msg: string, ctx?: Record<string, unknown>): void };

export type DisposableEmailOptions = {
  log: WarnLogger;
  /** DNS for the mail-server check; omit to check the domain list only. */
  lookup?: MailServerLookup;
  cache?: VerdictCache;
  /** Seconds a mail-server answer is kept (default a day). */
  cacheTtlSec?: number;
  /** Budget for the whole mail-server check (default `DISPOSABLE_EMAIL.timeoutMs`). */
  timeoutMs?: number;
  /** The deployment's extra domains and allowed domains (`DISPOSABLE_EXTRA_DOMAINS`, `DISPOSABLE_ALLOW_DOMAINS`). */
  extraDomains?: string | undefined;
  allowDomains?: string | undefined;
};

/**
 * Names never looked up (RFC 2606 / 6761 / 6762 and common internal suffixes): asking our resolvers about them would
 * reach internal DNS, and none of them is a public mail domain.
 */
const PRIVATE_SUFFIXES = [
  "internal",
  "local",
  "localhost",
  "lan",
  "home",
  "corp",
  "test",
  "example",
  "invalid",
  "onion",
  "arpa",
];

/** Whether a name is single-label or ends in a reserved or internal suffix. */
export function privateName(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, "");
  if (!n.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((s) => n === s || n.endsWith(`.${s}`));
}

/**
 * Whether the domain's mail is received by a disposable mail server (see the module comment). Shared providers' hosts
 * are skipped, not trusted: adding a dummy `mx.google.com` to a temporary-inbox domain doesn't hide its real server.
 * Reserved and internal names are never looked up.
 */
export async function onDisposableMailServer(lookup: MailServerLookup, domain: string): Promise<boolean> {
  if (privateName(domain)) return false;
  const mx = await lookup.mx(domain);
  const hosts = (mx.length > 0 ? mx : [domain]).filter((h) => !isSharedMailHost(h) && !privateName(h));
  for (const host of hosts.slice(0, 5)) {
    if ((await lookup.ipv4(host)).some(disposableMailServer)) return true;
  }
  return false;
}

export function disposableEmailCheck(opts: DisposableEmailOptions): DisposableEmailCheck {
  const extra = domainList(opts.extraDomains);
  const allow = domainList(opts.allowDomains);
  const ttl = opts.cacheTtlSec ?? 24 * 3600;
  const budget = opts.timeoutMs ?? DISPOSABLE_EMAIL.timeoutMs;

  async function mailServer(domain: string): Promise<boolean> {
    const lookup = opts.lookup;
    if (!lookup) return false;
    const key = `am:disposable-mx:${domain}`;
    const cached = await opts.cache?.get(key).catch(() => null);
    if (cached === "1" || cached === "0") return cached === "1";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, budget);
    });
    try {
      const answer = await Promise.race([onDisposableMailServer(lookup, domain), timeout]);
      if (answer === "timeout") {
        opts.log.warn("disposable email check timed out", { component: "disposable-email", domain });
        return false;
      }
      await opts.cache?.set(key, answer ? "1" : "0", ttl).catch(() => undefined);
      return answer;
    } catch (err) {
      opts.log.warn("disposable email check failed", {
        component: "disposable-email",
        domain,
        reason: (err as { code?: string }).code ?? "error",
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(address: string): Promise<DisposableVerdict> {
      const domain = domainOf(address);
      if (domain === null) return { disposable: false };
      if (domainAndParents(domain).some((n) => allow.has(n))) return { disposable: false };
      if (listedDomain(domain, extra, allow)) return { disposable: true, via: "listed" };
      return (await mailServer(domain)) ? { disposable: true, via: "mail_server" } : { disposable: false };
    },
  };
}

/** The memory fake: disposable when the domain (or a parent) is in `domains`. */
export function fakeDisposableEmailCheck(domains: readonly string[] = ["mailinator.com"]): DisposableEmailCheck {
  const set = new Set(domains.map((d) => d.toLowerCase()));
  return {
    check(address) {
      const domain = domainOf(address);
      const hit = domain !== null && domainAndParents(domain).some((n) => set.has(n));
      return Promise.resolve(hit ? { disposable: true, via: "listed" } : { disposable: false });
    },
  };
}
