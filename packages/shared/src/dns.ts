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
  /**
   * DKIM only: the keys aren't known yet (the domain isn't on the mail server). Name and value are placeholders
   * (`DKIM_PLACEHOLDER`): nothing to copy or look up, and the record can't pass.
   */
  placeholder?: true;
};

/**
 * One DKIM key the mail server signs a customer domain's mail with: published as TXT at `<selector>._domainkey`
 * with `value` (`v=DKIM1; k=rsa|ed25519; …; p=<public key>`). The keys are created by the mail server when the
 * domain is added there and read from its zone file (`x:Domain/get` → `dnsZoneFile`); the control plane caches them.
 */
export type DkimKey = { selector: string; value: string };

/** Name and value shown in place of the DKIM keys before the mail server has created them (and in the public docs). */
export const DKIM_PLACEHOLDER = { name: "<selector>._domainkey", value: "v=DKIM1; k=rsa; p=<public key>" } as const;

const DKIM_WHY = "Lets AnhourMail sign your outgoing mail so it isn't marked as spam.";

/** Ownership-check TXT host and value prefix. */
export const VERIFY_HOST = "_anhourmail";
export const VERIFY_PREFIX = "anhourmail-verify=";

/**
 * The records for `domain`. `dkim`: the domain's keys from the mail server, one required TXT each; null or empty (not
 * created yet, or the public docs) renders one `placeholder` DKIM record instead.
 */
export function customerDomainRecords(
  domain: string,
  verifyToken: string,
  platform: Platform,
  dkim: readonly DkimKey[] | null = null,
): DnsRecordTemplate[] {
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
    ...(dkim === null || dkim.length === 0
      ? [
          {
            purpose: "dkim",
            type: "TXT",
            ...DKIM_PLACEHOLDER,
            required: true,
            why: DKIM_WHY,
            placeholder: true,
          } as const,
        ]
      : dkim.map((k): DnsRecordTemplate => ({
          purpose: "dkim",
          type: "TXT",
          name: `${k.selector}._domainkey`,
          value: k.value,
          required: true,
          why: DKIM_WHY,
        }))),
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
