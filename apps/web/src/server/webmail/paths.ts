// SPDX-License-Identifier: AGPL-3.0-only
import { hostKind } from "../host-routing";

/**
 * Where the webmail lives on this host: at the root of the webmail origin (mail.* or the dev webmail port), or
 * under `/webmail` on a dev bare host (ADR-0003). Links and redirects are built from it.
 */
export function webmailBasePath(host: string | null, production: boolean, webmailDevPort?: string): string {
  return hostKind(host ?? "", production ? undefined : webmailDevPort) === "mail" ? "" : "/webmail";
}

/** Only an address may be pre-filled from the console link; anything else is ignored. */
export function prefillAddress(value: string | string[] | undefined): string {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : "";
}
