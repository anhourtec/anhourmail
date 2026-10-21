// SPDX-License-Identifier: AGPL-3.0-only
import { ValidationError } from "../errors";

/** `provisioning` until the worker has created it on the mail server; `failed` after retries ran out. */
export type MailboxStatus = "provisioning" | "active" | "failed" | "suspended";

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
  createdAt: Date;
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
