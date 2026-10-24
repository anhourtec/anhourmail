// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from "@anhourmail/shared/rbac";
import { ACCOUNT_ROLES } from "@anhourmail/shared/rbac";
import { nameProblem } from "@anhourmail/shared/names";
import {
  isCountryCode,
  PHONE_PATTERN,
  PROFILE_FIELD_INFO,
  PROFILE_FIELDS,
  type ProfileDetails,
} from "@anhourmail/shared/profile";

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

/** A display name (the sender name in "Name <address>"): required, 1–80 characters, by the shared name rules. */
export function displayName(input: unknown): string {
  const v = clean(input, 200);
  if (v === "") throw new ValidationError("Enter a display name.");
  if (v.length > 80) throw new ValidationError("Use at most 80 characters for the display name.");
  const problem = nameProblem(v);
  if (problem) throw new ValidationError(problem);
  return v;
}

/**
 * Optional profile details ("Add a user", step 3): known fields only, trimmed, empty ones left out. Free-text fields
 * follow the shared name rules except that web addresses and `@` are allowed nowhere either; phones take digits and
 * + ( ) - . / and spaces; the country is an ISO 3166-1 alpha-2 code from the static list. Never logged or audited.
 */
export function profileDetails(input: unknown): ProfileDetails {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError("Check the profile details.");
  const raw = input as Record<string, unknown>;
  const out: ProfileDetails = {};
  for (const field of PROFILE_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string")
      throw new ValidationError(`Check the ${PROFILE_FIELD_INFO[field].label.toLowerCase()}.`);
    const v = value.trim().replace(/\s+/g, " ");
    if (v === "") continue;
    const { label, max } = PROFILE_FIELD_INFO[field];
    if (v.length > max) throw new ValidationError(`${label} is too long.`);
    if (field === "country") {
      if (!isCountryCode(v)) throw new ValidationError("Choose a country or region from the list.");
    } else if (field === "officePhone" || field === "mobilePhone") {
      if (!PHONE_PATTERN.test(v)) throw new ValidationError(`${label}: use digits, spaces and + ( ) - only.`);
    } else {
      const problem = nameProblem(v);
      if (problem) throw new ValidationError(`${label}: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
    }
    out[field] = v;
  }
  return out;
}
