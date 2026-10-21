// SPDX-License-Identifier: AGPL-3.0-only
import type { PlanId } from "@anhourmail/shared/plans";
import type { AccountRole, UserState } from "@anhourmail/shared/rbac";

/** Customer accounts, memberships and per-person state. Write port used by sign-up and (later) invites. */
export type AccountRepository = {
  create(input: { name: string; plan: PlanId }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string; name: string; plan: PlanId; status: string } | null>;
  addMember(input: { accountId: string; userId: string; role: AccountRole }): Promise<void>;
  setUserState(input: { userId: string; state: UserState }): Promise<void>;
  /** Accounts the user already belongs to (sign-up must be idempotent). */
  membershipCount(userId: string): Promise<number>;
};
