// SPDX-License-Identifier: AGPL-3.0-only
import type { ProfileDetails } from "@anhourmail/shared/profile";
import type { AccountRole } from "@anhourmail/shared/rbac";

import type { Invite, MemberRecord } from "./entity";

/** People in an account. Every read and write is scoped to the account, so another account's people are not found. */
export type PeopleRepository = {
  /** Members of the account, by email. */
  list(accountId: string): Promise<MemberRecord[]>;
  /** Conditional: false when the person isn't in the account. */
  setRole(accountId: string, userId: string, role: AccountRole): Promise<boolean>;
  /** Conditional: false when the person isn't in the account. */
  remove(accountId: string, userId: string): Promise<boolean>;
  /** The console login with this (normalised) email, if any. */
  userByEmail(email: string): Promise<{ id: string; name: string } | null>;
  /**
   * Creates a console login with a password (already hashed, argon2id) and a verified email: the invite link proved
   * the address. Throws `ConflictError` when a login with the email already exists.
   */
  createLogin(input: {
    email: string;
    name: string;
    firstName: string;
    lastName: string | null;
    passwordHash: string;
    /** "Add a user": the password was chosen by an admin and the person must choose their own at first sign-in. */
    mustChangePassword?: boolean;
  }): Promise<{ id: string }>;
  /**
   * Sets the person's name (`auth_user.name`, already checked by the name rules): the name the console shows and, for
   * every mailbox of theirs without a custom display name, the sender name on their mail (`people/names.ts`).
   */
  setName(userId: string, name: string): Promise<void>;
  /** Replaces the person's optional profile details (only the given fields are kept). */
  setProfile(userId: string, details: ProfileDetails): Promise<void>;
  /** The person's optional profile details. */
  profile(userId: string): Promise<ProfileDetails>;
  /** Whether the person must choose a new console password before anything else. */
  passwordChangeRequired(userId: string): Promise<boolean>;
  setPasswordChangeRequired(userId: string, required: boolean): Promise<void>;
};

/** Account invites. Only token hashes are stored; reads by id are scoped to the account. */
export type InviteRepository = {
  /** Pending invites (expired ones included), newest first. */
  listPending(accountId: string): Promise<Invite[]>;
  get(accountId: string, id: string): Promise<Invite | null>;
  /** Any invite with this token hash, whatever its status. */
  findByToken(tokenHash: string): Promise<Invite | null>;
  create(input: Omit<Invite, "id" | "status"> & { tokenHash: string }): Promise<Invite>;
  /** New token and expiry for a pending invite (resend). Conditional: false unless still pending. */
  reissue(id: string, tokenHash: string, expiresAt: Date): Promise<boolean>;
  /** pending → revoked. Conditional. */
  revoke(id: string): Promise<boolean>;
  /** pending and unexpired at `at` → accepted by `userId`. Conditional, so a link is used at most once. */
  accept(id: string, userId: string, at: Date): Promise<boolean>;
  /** Logs one invite email sent for the account (first send or resend), for the daily cap. */
  recordSend(accountId: string, inviteId: string, at: Date): Promise<void>;
  /** Invite emails the account sent at or after `since`. */
  sendsSince(accountId: string, since: Date): Promise<number>;
};
