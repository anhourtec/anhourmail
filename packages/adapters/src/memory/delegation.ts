// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import type { DelegationGrant, DelegationRepository } from "@anhourmail/core/delegation";
import { DELEGATION_RIGHTS } from "@anhourmail/shared/delegation";

/** What the delegation repository reads from the rest of the in-memory state. */
type State = {
  delegations: DelegationGrant[];
  mailboxes: { id: string; accountId: string }[];
  memberships: { userId: string; accountId: string }[];
};

const clone = <T>(v: T): T => structuredClone(v);

/** Mirrors the Postgres order: by right (`DELEGATION_RIGHTS` order), then oldest first, then id. */
const ordered = (rows: DelegationGrant[]): DelegationGrant[] =>
  clone(
    [...rows].sort(
      (a, b) =>
        DELEGATION_RIGHTS.indexOf(a.right) - DELEGATION_RIGHTS.indexOf(b.right) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    ),
  );

/**
 * In-memory mailbox delegation (ADR-0026); same contract as Postgres (src/contract). Rows go with their mailbox, their
 * membership and their account (`people.remove`, `mailboxes.deleteIfDue` and the data-lifecycle deletions drop them,
 * like the foreign keys' cascades).
 */
export function memoryDelegation(s: State): DelegationRepository {
  const take = (keep: (g: DelegationGrant) => boolean): DelegationGrant[] => {
    const gone = s.delegations.filter((g) => !keep(g));
    s.delegations = s.delegations.filter(keep);
    return ordered(gone);
  };
  return {
    listForMailbox: async (accountId, mailboxId) =>
      ordered(s.delegations.filter((g) => g.accountId === accountId && g.mailboxId === mailboxId)),
    listForGrantee: async (accountId, userId) =>
      ordered(s.delegations.filter((g) => g.accountId === accountId && g.granteeUserId === userId)),
    rightsOf: async (accountId, mailboxId, userId) =>
      ordered(
        s.delegations.filter(
          (g) => g.accountId === accountId && g.mailboxId === mailboxId && g.granteeUserId === userId,
        ),
      ).map((g) => g.right),
    grant: async ({ accountId, mailboxId, granteeUserId, right, grantedBy, at }) => {
      // The composite foreign keys: the mailbox and the membership exist, both in this account.
      if (!s.mailboxes.some((m) => m.id === mailboxId && m.accountId === accountId)) {
        throw new Error(`no mailbox ${mailboxId} in ${accountId}`);
      }
      if (!s.memberships.some((m) => m.accountId === accountId && m.userId === granteeUserId)) {
        throw new Error(`${granteeUserId} is not a member of ${accountId}`);
      }
      if (
        s.delegations.some((g) => g.mailboxId === mailboxId && g.granteeUserId === granteeUserId && g.right === right)
      )
        return false;
      s.delegations.push({
        id: randomUUID(),
        accountId,
        mailboxId,
        granteeUserId,
        right,
        grantedBy,
        createdAt: clone(at),
      });
      return true;
    },
    revoke: async (accountId, mailboxId, granteeUserId, right) =>
      take(
        (g) =>
          !(
            g.accountId === accountId &&
            g.mailboxId === mailboxId &&
            g.granteeUserId === granteeUserId &&
            g.right === right
          ),
      ).length > 0,
    revokeAllForMailbox: async (accountId, mailboxId) =>
      take((g) => !(g.accountId === accountId && g.mailboxId === mailboxId)),
    revokeAllForGrantee: async (accountId, userId) =>
      take((g) => !(g.accountId === accountId && g.granteeUserId === userId)),
  };
}
