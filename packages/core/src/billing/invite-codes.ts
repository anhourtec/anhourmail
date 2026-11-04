// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Staff-made invite codes (ADR-0029 §8): beta waves (`signup`) and comped accounts (`comp`). Codes are random, shown
 * once, stored as sha256 only. Customers can't issue codes in v1 (maintainer default 2026-11-04: staff only).
 */
import { createHash, randomBytes } from "node:crypto";

import { isPaidPlan, type PaidPlanId } from "@anhourmail/shared/plans";
import type { Permission } from "@anhourmail/shared/rbac";

import type { InviteCode, InviteCodeStatus } from "./entity";

const DAY_MS = 86_400_000;

/** Crockford base32: no I, L, O or U, so a code read aloud or typed from paper is unambiguous. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 20 random bytes = 160 bits (above the ADR's 128-bit floor) = exactly 32 characters, shown as 8 groups of 4. */
const CODE_BYTES = 20;
const CODE_CHARS = 32;

export const INVITE_CODE_MAX_DAYS = 90;
export const INVITE_CODE_COMP_MAX_DAYS = 365;
export const INVITE_CODE_LABEL_MAX = 200;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

const group = (code: string): string => code.replace(/(.{4})(?!$)/g, "$1-");

/** A new code as it is shown once (`XXXX-XXXX-…`) and its hash for storage. */
export function newInviteCode(random: (n: number) => Uint8Array = randomBytes): { code: string; codeHash: string } {
  const canonical = base32(random(CODE_BYTES));
  return { code: group(canonical), codeHash: hashInviteCode(canonical) };
}

/**
 * The canonical form of what someone typed: upper case, without spaces or dashes, with Crockford's look-alikes mapped
 * (I and L → 1, O → 0). Null when it can't be a code (wrong length or characters): answered like any wrong code.
 */
export function normaliseInviteCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== CODE_CHARS) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export const hashInviteCode = (canonical: string): string => createHash("sha256").update(canonical).digest("hex");

export function inviteCodeStatus(
  c: Pick<InviteCode, "redeemedAt" | "revokedAt" | "expiresAt">,
  now: Date,
): InviteCodeStatus {
  if (c.redeemedAt !== null) return "redeemed";
  if (c.revokedAt !== null) return "revoked";
  return c.expiresAt <= now ? "expired" : "active";
}

export type InviteCodeSpec = {
  label: string;
  grantsSignup: boolean;
  compPlan: PaidPlanId | null;
  compDays: number | null;
  email: string | null;
  expiresAt: Date;
};

/** What's wrong with a code to create, or null. A code grants sign-up, a comp, or both; it always expires. */
export function inviteCodeSpecProblem(spec: InviteCodeSpec, now: Date): string | null {
  if (!spec.grantsSignup && spec.compPlan === null) return "A code must grant sign-up, a comped plan, or both.";
  if ((spec.compPlan === null) !== (spec.compDays === null)) return "A comped plan needs its number of days.";
  if (spec.compPlan !== null && !isPaidPlan(spec.compPlan)) return "Comp Plus or Supporter.";
  if (
    spec.compDays !== null &&
    (!Number.isSafeInteger(spec.compDays) || spec.compDays < 1 || spec.compDays > INVITE_CODE_COMP_MAX_DAYS)
  ) {
    return `Comp from 1 to ${String(INVITE_CODE_COMP_MAX_DAYS)} days.`;
  }
  if (spec.expiresAt <= now) return "The expiry must be in the future.";
  if (spec.expiresAt.getTime() - now.getTime() > INVITE_CODE_MAX_DAYS * DAY_MS) {
    return `A code expires within ${String(INVITE_CODE_MAX_DAYS)} days.`;
  }
  if (spec.label.length > INVITE_CODE_LABEL_MAX)
    return `Keep the note under ${String(INVITE_CODE_LABEL_MAX)} characters.`;
  if (spec.email !== null && !/^[^\s@]+@[^\s@]+$/.test(spec.email)) return "Bind the code to an email address.";
  return null;
}

/** Sign-up-only codes need `platform.invites.manage`; any code that comps a plan needs `platform.billing.manage`. */
export const inviteCodePermission = (spec: Pick<InviteCodeSpec, "compPlan">): Permission =>
  spec.compPlan === null ? "platform.invites.manage" : "platform.billing.manage";

/** Bound emails are compared lower-cased and trimmed (the column holds the normalised form). */
export const normaliseCodeEmail = (email: string): string => email.trim().toLowerCase();
