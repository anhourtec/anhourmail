// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import type { Utm } from "@anhourmail/shared/schemas";

export type WaitlistStatus = "pending" | "confirmed" | "invited";

export type WaitlistEntry = {
  id: string;
  email: string;
  /** sha256 of the normalised address: dedupe key and what logs may carry. */
  emailHash: string;
  community: string | null;
  ref: string | null;
  utm: Utm | null;
  status: WaitlistStatus;
  createdAt: Date;
  /** Double opt-in bookkeeping (the token itself is never stored, only its hash in the adapter). */
  confirmSentAt: Date | null;
  confirmedAt: Date | null;
};

/** Confirmation links work for 48 hours; a repeat sign-up re-sends at most every 10 minutes. */
export const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
export const CONFIRM_RESEND_MS = 10 * 60 * 1000;

/** Forms filled faster than this are treated as bots (BookYourPTO pattern, enforced server-side). */
export const MIN_FILL_MS = 3_000;

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

export const hashEmail = (email: string) => createHash("sha256").update(normaliseEmail(email)).digest("hex");

/** True when the submission looks automated: honeypot filled or submitted implausibly fast. */
export function looksAutomated(input: { website?: string | undefined; startedAt: number }, now: Date): boolean {
  if (input.website !== undefined && input.website !== "") return true;
  const elapsed = now.getTime() - input.startedAt;
  return elapsed < MIN_FILL_MS || elapsed > 24 * 60 * 60 * 1000;
}
