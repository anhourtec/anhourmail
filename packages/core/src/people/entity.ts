// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from "@anhourmail/shared/rbac";
import { ACCOUNT_ROLES } from "@anhourmail/shared/rbac";
import { nameProblem } from "@anhourmail/shared/names";

import { ValidationError } from "../errors";

/** `pending` until accepted or revoked; a pending invite past `expiresAt` is expired (shown, but can't be used). */
export type InviteStatus = "pending" | "accepted" | "revoked";

/** An invitation to join one account with one role. The token is only in the emailed link; its hash is stored. */
export type Invite = {
  id: string;
  accountId: string;
  /** Normalised (trimmed, lower-case). */
  email: string;
  role: AccountRole;
  status: InviteStatus;
  expiresAt: Date;
  createdBy: string | null;
  createdAt: Date;
};

/** A person in an account, with the console identity's name and email. */
export type MemberRecord = {
  userId: string;
  name: string;
  email: string;
  role: AccountRole;
  joinedAt: Date;
  /** The person's console sign-in is suspended (platform-wide). */
  suspended: boolean;
};

const EMAIL =
  /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** An email address to invite: trimmed and lower-cased; anything that doesn't look like one is refused. */
export function normaliseEmail(input: unknown): string {
  const v = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (v === "" || v.length > 254 || !EMAIL.test(v)) throw new ValidationError("Enter a valid email address.");
  return v;
}

export const isAccountRole = (v: unknown): v is AccountRole =>
  typeof v === "string" && (ACCOUNT_ROLES as readonly string[]).includes(v);

const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";

/** Names for a login created from an invite: first name required, last name optional, display name "First Last". */
export function loginNames(input: { firstName?: unknown; lastName?: unknown }): {
  firstName: string;
  lastName: string | null;
  name: string;
} {
  const firstName = clean(input.firstName, 60);
  if (firstName === "") throw new ValidationError("Enter your first name.");
  const lastName = clean(input.lastName, 60);
  // The shared name rules (control and text-direction characters, `@`, web addresses), as at sign-up.
  const problem = nameProblem(firstName) ?? nameProblem(lastName);
  if (problem) throw new ValidationError(problem);
  return {
    firstName,
    lastName: lastName === "" ? null : lastName,
    name: [firstName, lastName].filter(Boolean).join(" ").slice(0, 80),
  };
}

/** Same bounds as the console sign-up (packages/adapters/src/auth). */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function checkPassword(input: unknown): string {
  if (typeof input !== "string" || input.length < PASSWORD_MIN) {
    throw new ValidationError(`Use at least ${String(PASSWORD_MIN)} characters for your password.`);
  }
  if (input.length > PASSWORD_MAX) {
    throw new ValidationError(`Use at most ${String(PASSWORD_MAX)} characters for your password.`);
  }
  return input;
}
