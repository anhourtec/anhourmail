// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public platform facts: product domains, the hostnames customers and mail clients see, and client ports.
 * Rendered into the docs site (client setup pages), the console (domain setup) and autoconfig.
 * Internal hostnames, IPs and admin endpoints never go here (CLAUDE.md rule 33).
 */

/** Consumer product domain: free addresses, marketing site, webmail, console. */
export const PRODUCT_DOMAIN = "anhourmail.com";

/** Company domain. Staff mail only — never customer or free accounts (ADR-0006). */
export const COMPANY_DOMAIN = "anhourtec.com";

export const BRAND = {
  product: "AnhourMail",
  company: "Anhourtec",
  location: "British Columbia, Canada",
} as const;

/** Public hostnames on the product domain. */
export const HOSTS = {
  site: PRODUCT_DOMAIN,
  /** Console (account, domains, billing). */
  app: `app.${PRODUCT_DOMAIN}`,
  /**
   * Webmail. Same app as the console, routed by host, but a separate origin with its own host-only session
   * cookie: untrusted email HTML never shares an origin with billing or account deletion (ADR-0003).
   */
  webmail: `mail.${PRODUCT_DOMAIN}`,
  docs: `docs.${PRODUCT_DOMAIN}`,
  status: `status.${PRODUCT_DOMAIN}`,
  /** Inbound MX for every hosted domain. */
  mx: [`mx1.${PRODUCT_DOMAIN}`] as const,
  /** Client submission (SMTP AUTH). */
  smtp: `smtp.${PRODUCT_DOMAIN}`,
  /** Client access (IMAP, POP3, JMAP for third-party clients). */
  imap: `imap.${PRODUCT_DOMAIN}`,
  /** Autoconfig (`config-v1.1.xml` client-setup convention); customer domains CNAME `autoconfig.<domain>` here. */
  autoconfig: `autoconfig.${PRODUCT_DOMAIN}`,
  /** Autodiscover (`autodiscover.xml` client-setup protocol); customer domains CNAME `autodiscover.<domain>` here. */
  autodiscover: `autodiscover.${PRODUCT_DOMAIN}`,
  /** MTA-STS policy host for the product domain. */
  mtaSts: `mta-sts.${PRODUCT_DOMAIN}`,
} as const;

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
 * (CLAUDE.md rule 18 exception). IMAP is recommended over POP3 (POP3 downloads, no folders sync). ManageSieve (4190)
 * isn't offered: customer mailboxes can't write their own Sieve (server rules are managed in webmail settings), so the
 * mail server refuses customer ManageSieve sign-ins.
 */
export const CLIENT_ENDPOINTS: readonly ClientEndpoint[] = [
  { protocol: "IMAP", host: HOSTS.imap, port: 993, security: "SSL/TLS", recommended: true },
  { protocol: "IMAP", host: HOSTS.imap, port: 143, security: "STARTTLS", recommended: false },
  { protocol: "POP3", host: HOSTS.imap, port: 995, security: "SSL/TLS", recommended: false },
  { protocol: "POP3", host: HOSTS.imap, port: 110, security: "STARTTLS", recommended: false },
  { protocol: "SMTP", host: HOSTS.smtp, port: 465, security: "SSL/TLS", recommended: true },
  { protocol: "SMTP", host: HOSTS.smtp, port: 587, security: "STARTTLS", recommended: false },
  { protocol: "JMAP", host: HOSTS.imap, port: 443, security: "SSL/TLS", recommended: false },
] as const;

/**
 * Contacts sync (CardDAV, RFC 6352) for phones and desktop apps: served by the mail server on the same host as JMAP.
 * Apps that find the address book themselves only need the server name; others take the full address-book URL.
 */
export const CARDDAV = {
  host: HOSTS.imap,
  port: 443,
  /** The address-book home; the app appends the mailbox address. */
  url: `https://${HOSTS.imap}/dav/card/`,
} as const;

/** Mail clients sign in with the full email address and an app password, never the account password. */
export const CLIENT_USERNAME_HINT = "Your full email address";
