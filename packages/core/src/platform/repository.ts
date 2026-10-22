// SPDX-License-Identifier: AGPL-3.0-only
import type { PlanId } from "@anhourmail/shared/plans";

/** One customer account as staff see it: counts and metadata, never mail content. */
export type AccountSummary = {
  id: string;
  name: string;
  plan: PlanId;
  status: string;
  members: number;
  mailboxes: number;
  domains: number;
  createdAt: Date;
};

/** Staff look-up across every customer account (`platform.accounts.read`). Read-only. */
export type PlatformAccountRepository = {
  /**
   * Newest first. `query` matches the account name (contains, case-insensitive), its id exactly, or a member's
   * sign-in email (contains). `total` counts every match.
   */
  search(q: {
    query: string | null;
    limit: number;
    offset: number;
  }): Promise<{ total: number; rows: AccountSummary[] }>;
  summary(id: string): Promise<AccountSummary | null>;
};
