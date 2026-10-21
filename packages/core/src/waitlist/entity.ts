// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import type { Utm } from "@anhourmail/shared/schemas";

export type WaitlistStatus = "pending" | "invited";

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
};

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
