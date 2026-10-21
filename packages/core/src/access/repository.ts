// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole, PlatformRole } from "@anhourmail/shared/rbac";

/** Roles and memberships for building an Actor. Read-only port. */
export type AccessRepository = {
  platformRoles(userId: string): Promise<PlatformRole[]>;
  memberships(userId: string): Promise<{ accountId: string; role: AccountRole }[]>;
  isSuspended(userId: string): Promise<boolean>;
  /** Display names for accounts, keyed by id (unknown ids are omitted). */
  accountNames(accountIds: readonly string[]): Promise<Record<string, string>>;
  /** People in an account with their sign-in email and role, by email. */
  members(accountId: string): Promise<{ userId: string; email: string; role: AccountRole }[]>;
};
