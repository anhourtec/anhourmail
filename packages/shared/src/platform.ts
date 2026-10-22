// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public platform facts: product domains, the hostnames customers and mail clients see, and client ports.
 * Two ways in (docs/internal/01-architecture.md "Platform hostnames"):
 *   - server code (console, webmail, API, worker) builds `platformFacts(PLATFORM_DOMAIN)` from configuration;
 *   - the marketing site and public docs render the product's published names (`PUBLIC_PLATFORM`, anhourmail.com).
 * Internal hostnames, IPs and admin endpoints never go here (CLAUDE.md rule 33).
 */

/**
 * The product's public domain: what the marketing site, the public docs and the legal pages publish. A deployment's
 * own hostnames come from configuration instead (`PLATFORM_DOMAIN`, read on the server; see `platformFacts`), so a
 * staging or self-hosted install never tells its customers to point DNS at production names.
 */
export const PRODUCT_DOMAIN = "anhourmail.com";

/** `PLATFORM_DOMAIN` when it isn't set. */
export const DEFAULT_PLATFORM_DOMAIN = PRODUCT_DOMAIN;

/** Company domain. Staff mail only — never customer or free accounts (ADR-0006). */
export const COMPANY_DOMAIN = "anhourtec.com";

export const BRAND = {
  product: "AnhourMail",
  company: "Anhourtec",
  location: "British Columbia, Canada",
} as const;

/** Public hostnames under a platform domain. */
export type PlatformHosts = {
  site: string;
  /** Console (account, domains, billing). */
  app: string;
  /**
   * Webmail. Same app as the console, routed by host, but a separate origin with its own host-only session
   * cookie: untrusted email HTML never shares an origin with billing or account deletion (ADR-0003).
   */
  webmail: string;
  docs: string;
  status: string;
  /** Inbound MX for every hosted domain. */
  mx: readonly [string, ...string[]];
  /** Client submission (SMTP AUTH). */
  smtp: string;
  /** Client access (IMAP, POP3, JMAP for third-party clients). */
  imap: string;
  /** Autoconfig (`config-v1.1.xml` client-setup convention); customer domains CNAME `autoconfig.<domain>` here. */
  autoconfig: string;
  /** Autodiscover (`autodiscover.xml` client-setup protocol); customer domains CNAME `autodiscover.<domain>` here. */
  autodiscover: string;
  /** MTA-STS policy host for the platform domain. */
  mtaSts: string;
};

export function platformHosts(domain: string): PlatformHosts {
  return {
    site: domain,
    app: `app.${domain}`,
    webmail: `mail.${domain}`,
    docs: `docs.${domain}`,
    status: `status.${domain}`,
    mx: [`mx1.${domain}`],
    smtp: `smtp.${domain}`,
    imap: `imap.${domain}`,
    autoconfig: `autoconfig.${domain}`,
    autodiscover: `autodiscover.${domain}`,
    mtaSts: `mta-sts.${domain}`,
  };
}

export type Security = "SSL/TLS" | "STARTTLS";

export type ClientEndpoint = {
  protocol: "IMAP" | "POP3" | "SMTP" | "JMAP";
  host: string;
  port: number;
  security: Security;
  /** Shown first in setup guides. */
  recommended: boolean;
};

/**
 * What a mail client connects to: IMAP, POP3, SMTP submission and JMAP. Production ports are the standard ones
 * (CLAUDE.md rule 18 exception), and only the published ones: IMAP and POP3 over implicit TLS (993, 995), submission
 * over implicit TLS (465) or STARTTLS (587), JMAP over HTTPS. The cleartext-upgrade ports 143 and 110 are not
 * published in production, so they are never advertised. IMAP is recommended over POP3 (POP3 downloads, no folder
 * sync). ManageSieve (4190) isn't offered: customer mailboxes can't write their own Sieve (server rules are managed in
 * webmail settings), so the mail server refuses customer ManageSieve sign-ins.
 */
export function clientEndpoints(hosts: Pick<PlatformHosts, "imap" | "smtp">): readonly ClientEndpoint[] {
  return [
    { protocol: "IMAP", host: hosts.imap, port: 993, security: "SSL/TLS", recommended: true },
    { protocol: "POP3", host: hosts.imap, port: 995, security: "SSL/TLS", recommended: false },
    { protocol: "SMTP", host: hosts.smtp, port: 465, security: "SSL/TLS", recommended: true },
    { protocol: "SMTP", host: hosts.smtp, port: 587, security: "STARTTLS", recommended: false },
    { protocol: "JMAP", host: hosts.imap, port: 443, security: "SSL/TLS", recommended: false },
  ];
}

/**
 * Contacts sync (CardDAV, RFC 6352) for phones and desktop apps: served by the mail server on the same host as JMAP.
 * Apps that find the address book themselves only need the server name; others take the full address-book URL.
 */
export type CardDav = { host: string; port: number; url: string };

const cardDav = (hosts: Pick<PlatformHosts, "imap">): CardDav => ({
  host: hosts.imap,
  port: 443,
  /** The address-book home; the app appends the mailbox address. */
  url: `https://${hosts.imap}/dav/card/`,
});

/**
 * Everything customers are told about one deployment's hostnames: the console and webmail screens, the DNS records a
 * custom domain publishes (and that verification checks), and mail-app settings. Built from one domain.
 */
export type Platform = {
  domain: string;
  /**
   * Where free `@…` addresses live. By design this is the platform domain itself (anhourmail.com in production, the
   * deployment's own domain elsewhere); kept as its own fact so screens say "free address domain", not "platform".
   */
  freeAddressDomain: string;
  hosts: PlatformHosts;
  /** SPF include published on our side; lists every outbound IP. */
  spfInclude: string;
  /** Zone the per-customer DKIM CNAME targets live under (`<selector>.<customer domain>.<dkimZone>`). */
  dkimZone: string;
  clientEndpoints: readonly ClientEndpoint[];
  carddav: CardDav;
};

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A usable platform domain: lowercase ASCII (punycode for internationalised names), at least two labels, no trailing
 * dot, no IP address, short enough to leave room for the per-customer DKIM names under it.
 */
export function isPlatformDomain(value: string): boolean {
  if (value.length < 3 || value.length > 120) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels.at(-1) ?? "");
}

/**
 * `app.example.org` is directly under `example.org`; `app.staging.example.org` and `example.org` itself are not. The
 * console and webmail must sit directly under the platform domain in production (`app.<domain>`, `mail.<domain>`).
 */
export function isHostDirectlyUnder(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h.endsWith(`.${domain}`) && !h.slice(0, -domain.length - 1).includes(".");
}

/**
 * Production start-up checks shared by the web app and the worker: `PLATFORM_DOMAIN` must be set explicitly (a box
 * that forgot it would otherwise tell customers production's names) and each URL must be a host directly under it.
 * Returns the problems, each naming the setting; empty when fine. Never echoes secret values.
 */
export function productionPlatformProblems(input: {
  platformDomainSetting: string | undefined;
  domain: string;
  urls: Record<string, string | undefined>;
}): string[] {
  const problems: string[] = [];
  if ((input.platformDomainSetting ?? "").trim() === "") {
    problems.push("PLATFORM_DOMAIN must be set explicitly in production");
  }
  for (const [key, url] of Object.entries(input.urls)) {
    let host: string | null;
    try {
      host = url ? new URL(url).hostname : null;
    } catch {
      host = null;
    }
    if (host === null || !isHostDirectlyUnder(host, input.domain)) {
      problems.push(
        `${key} must be a host directly under PLATFORM_DOMAIN (${input.domain}); set PLATFORM_DOMAIN for this deployment`,
      );
    }
  }
  return problems;
}

/** Facts for one platform domain. Throws on a domain `isPlatformDomain` refuses. */
export function platformFacts(domain: string): Platform {
  if (!isPlatformDomain(domain)) throw new Error(`Not a usable platform domain: "${domain}"`);
  const hosts = platformHosts(domain);
  return {
    domain,
    freeAddressDomain: domain,
    hosts,
    spfInclude: `_spf.${domain}`,
    dkimZone: `dkim.${domain}`,
    clientEndpoints: clientEndpoints(hosts),
    carddav: cardDav(hosts),
  };
}

/**
 * Reads a `PLATFORM_DOMAIN` setting: unset or blank means `DEFAULT_PLATFORM_DOMAIN`; otherwise trimmed, lowercased and
 * validated. Throws with the setting's name on a bad value so a deployment fails at start, not in front of customers.
 */
export function parsePlatformDomain(value: string | undefined): string {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return DEFAULT_PLATFORM_DOMAIN;
  if (!isPlatformDomain(v)) {
    throw new Error("PLATFORM_DOMAIN must be a domain name like example.org (lowercase, no scheme, no trailing dot)");
  }
  return v;
}

/**
 * The product's published facts (anhourmail.com). For the marketing site, the public docs and their build checks only:
 * server code (console, webmail, API, worker) uses the configured platform instead (`deps.platform`, the web app's
 * `platform()`), enforced by ESLint.
 */
export const PUBLIC_PLATFORM: Platform = platformFacts(PRODUCT_DOMAIN);
export const HOSTS: PlatformHosts = PUBLIC_PLATFORM.hosts;
export const CLIENT_ENDPOINTS: readonly ClientEndpoint[] = PUBLIC_PLATFORM.clientEndpoints;
export const CARDDAV: CardDav = PUBLIC_PLATFORM.carddav;

/** Mail clients sign in with the full email address and an app password, never the account password. */
export const CLIENT_USERNAME_HINT = "Your full email address";
