// SPDX-License-Identifier: AGPL-3.0-only
import { domainToASCII } from "node:url";

import { COMPANY_DOMAIN, PRODUCT_DOMAIN } from "@anhourmail/shared/platform";

import { ValidationError } from "../errors";

/**
 * A customer domain. `pending_dns` until the required records check out, then `active` (the worker adds it to the
 * mail server). `removing` while the worker takes it off the mail server; the row goes once that succeeds.
 */
export type DomainStatus = "pending_dns" | "active" | "removing";

export type CustomerDomain = {
  id: string;
  accountId: string;
  /** ASCII (punycode) form, lowercase, no trailing dot. */
  name: string;
  status: DomainStatus;
  /** Public value the customer publishes in the ownership TXT record (not a secret). */
  verifyToken: string;
  stalwartId: string | null;
  lastError: string | null;
  createdAt: Date;
};

/** Names we never accept as customer domains: ours, and their subdomains. */
const RESERVED = [PRODUCT_DOMAIN, COMPANY_DOMAIN, "localhost", "example.com", "example.net", "example.org"];

/**
 * Special-use and private top-level names: they never resolve publicly, and looking them up could reach an internal
 * zone. (`.test` stays allowed: it's reserved for testing, resolves nowhere, and development uses it.)
 */
const RESERVED_TLDS = new Set([
  "local",
  "localhost",
  "internal",
  "invalid",
  "arpa",
  "onion",
  "alt",
  "lan",
  "home",
  "corp",
  "intranet",
  "private",
]);

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Normalises and validates a domain a customer typed: trims, lowercases, drops a trailing dot, converts
 * internationalised names to punycode. Refuses IPs, single-label names, our own domains and their subdomains.
 */
export function normaliseDomain(input: unknown): string {
  if (typeof input !== "string") throw new ValidationError("Enter a domain name, like example.org.");
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253) throw new ValidationError("Enter a domain name, like example.org.");
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1) ?? "")) {
    throw new ValidationError("Enter a domain name, like example.org.");
  }
  if (RESERVED_TLDS.has(labels.at(-1) ?? "") || RESERVED.some((r) => ascii === r || ascii.endsWith(`.${r}`))) {
    throw new ValidationError("That domain can't be added.");
  }
  return ascii;
}
