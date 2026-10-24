// SPDX-License-Identifier: AGPL-3.0-only
import { ValidationError } from "../errors";

/**
 * `provisioning` until the worker has applied it to the mail server (a new or resumed mailbox); `failed` after
 * retries ran out. `suspended`: nobody can sign in to it and its mail is refused, but everything it holds is kept.
 * `deleting`: suspended, its aliases taken off the mail server, and permanently removed at `purgeAfter` unless
 * restored first; its address stays reserved until then.
 */
export type MailboxStatus = "provisioning" | "active" | "failed" | "suspended" | "deleting";

export const MAILBOX_STATUSES: readonly MailboxStatus[] = ["provisioning", "active", "failed", "suspended", "deleting"];

export type Mailbox = {
  id: string;
  accountId: string;
  /** The person it belongs to (a member of the account), or null for an unassigned mailbox. */
  userId: string | null;
  address: string;
  status: MailboxStatus;
  quotaBytes: number;
  stalwartId: string | null;
  lastError: string | null;
  /** Set while `deleting`: when the scheduler removes it for good. */
  purgeAfter: Date | null;
  createdAt: Date;
  /** The sender name ("Name <address>"), also the mail server account's description. Absent or null: none. */
  displayName?: string | null;
  /** Set by "Add a user": the webmail asks for a new password before the inbox (cleared by the person's change). */
  mustChangePassword?: boolean;
};

export const GB = 1024 ** 3;

/**
 * The part before the @: lowercase letters, digits, dots, hyphens and underscores; 1–64 characters; no leading,
 * trailing or doubled dots. `+` is refused: it's for subaddressing (you+anything@ reaches you).
 */
export function normaliseLocalPart(input: unknown): string {
  const v = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(v) || v.includes("..")) {
    throw new ValidationError("Use letters, numbers, dots, hyphens or underscores, like jane.doe.");
  }
  return v;
}

/**
 * Role addresses (RFC 2142, plus the ones certificate authorities mail to prove domain control): whoever holds
 * one can receive a domain's abuse reports or get a TLS certificate for it, so only account admins may claim them.
 */
const RESERVED_LOCAL_PARTS = new Set([
  "abuse",
  "admin",
  "administrator",
  "hostmaster",
  "info",
  "mailer-daemon",
  "marketing",
  "noc",
  "no-reply",
  "noreply",
  "postmaster",
  "root",
  "sales",
  "security",
  "support",
  "webmaster",
]);

export function isReservedLocalPart(local: string): boolean {
  return RESERVED_LOCAL_PARTS.has(local);
}
