// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from "@anhourmail/shared/rbac";

export type InviteSource = "waitlist" | "staff" | "referral";

export type Invite = {
  id: string;
  email: string;
  accountId: string | null;
  role: AccountRole | null;
  source: InviteSource;
  expiresAt: Date;
};

export type InviteRepository = {
  create(input: {
    email: string;
    tokenHash: string;
    expiresAt: Date;
    source: InviteSource;
    createdBy: string | null;
    waitlistEntryId: string | null;
    accountId: string | null;
    role: AccountRole | null;
  }): Promise<{ id: string }>;
  /** A pending, unexpired invite with this token hash. */
  findValid(tokenHash: string, now: Date): Promise<Invite | null>;
  markAccepted(id: string, userId: string, at: Date): Promise<void>;
};
