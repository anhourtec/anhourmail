// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DNS records a customer domain publishes to use AnhourMail. One template, rendered by the console
 * (guided setup + live per-record verification), the docs (per-provider guides) and the worker (checks).
 * Every target is under the deployment's platform domain (`Platform`, from `PLATFORM_DOMAIN` on the server;
 * `PUBLIC_PLATFORM` for the public docs). Design: docs/internal/02-mail-infrastructure.md "Customer domain records".
 */
import type { Platform } from "./platform";

export type DnsRecordType = "MX" | "TXT" | "CNAME" | "SRV";

export type DnsRecordPurpose =
  "ownership" | "inbound" | "spf" | "dkim" | "dmarc" | "autoconfig" | "autodiscover" | "client-srv";

export type DnsRecordTemplate = {
  purpose: DnsRecordPurpose;
  type: DnsRecordType;
  /** Relative name as most DNS providers expect it: "@" for the apex. */
  name: string;
  value: string;
  priority?: number;
  /** Required records gate activation; recommended ones only show a warning. */
  required: boolean;
  /** Short plain-language reason, shown next to the record. */
  why: string;
};

/** DKIM selectors. Two are published at once so keys can rotate without customer DNS changes. */
export const DKIM_SELECTORS = ["am1", "am2"] as const;

/** Customer DKIM CNAME target: we publish and rotate the key behind it. */
export const dkimTarget = (selector: string, domain: string, platform: Platform) =>
  `${selector}.${domain}.${platform.dkimZone}`;

/** Ownership-check TXT host and value prefix. */
export const VERIFY_HOST = "_anhourmail";
export const VERIFY_PREFIX = "anhourmail-verify=";

export function customerDomainRecords(domain: string, verifyToken: string, platform: Platform): DnsRecordTemplate[] {
  const { hosts } = platform;
  const [mx] = hosts.mx;
  return [
    {
      purpose: "ownership",
      type: "TXT",
      name: VERIFY_HOST,
      value: `${VERIFY_PREFIX}${verifyToken}`,
      required: true,
      why: "Proves you control this domain.",
    },
    {
      purpose: "inbound",
      type: "MX",
      name: "@",
      value: `${mx}.`,
      priority: 10,
      required: true,
      why: "Delivers mail for your domain to AnhourMail.",
    },
    {
      purpose: "spf",
      type: "TXT",
      name: "@",
      value: `v=spf1 include:${platform.spfInclude} ~all`,
      required: true,
      why: "Tells other servers that AnhourMail may send mail for your domain.",
    },
    ...DKIM_SELECTORS.map((selector): DnsRecordTemplate => ({
      purpose: "dkim",
      type: "CNAME",
      name: `${selector}._domainkey`,
      value: `${dkimTarget(selector, domain, platform)}.`,
      required: true,
      why: "Lets AnhourMail sign your outgoing mail so it isn't marked as spam.",
    })),
    {
      purpose: "dmarc",
      type: "TXT",
      name: "_dmarc",
      value: "v=DMARC1; p=quarantine; adkim=s; aspf=r",
      required: false,
      why: "Asks receivers to quarantine mail that fails SPF and DKIM. Keep yours if you already have one.",
    },
    {
      purpose: "autoconfig",
      type: "CNAME",
      name: "autoconfig",
      value: `${hosts.autoconfig}.`,
      required: false,
      why: "Lets Thunderbird and other apps set themselves up.",
    },
    {
      purpose: "autodiscover",
      type: "CNAME",
      name: "autodiscover",
      value: `${hosts.autodiscover}.`,
      required: false,
      why: "Lets Outlook set itself up.",
    },
    {
      purpose: "client-srv",
      type: "SRV",
      name: "_submissions._tcp",
      value: `0 1 465 ${hosts.smtp}.`,
      priority: 0,
      required: false,
      why: "Helps mail apps find the sending server.",
    },
    {
      purpose: "client-srv",
      type: "SRV",
      name: "_imaps._tcp",
      value: `0 1 993 ${hosts.imap}.`,
      priority: 0,
      required: false,
      why: "Helps mail apps find the IMAP server.",
    },
    {
      purpose: "client-srv",
      type: "SRV",
      name: "_jmap._tcp",
      value: `0 1 443 ${hosts.imap}.`,
      priority: 0,
      required: false,
      why: "Helps JMAP apps find the server.",
    },
  ];
}
