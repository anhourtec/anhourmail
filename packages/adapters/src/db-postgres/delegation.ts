// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, sql } from "drizzle-orm";

import type { DelegationGrant, DelegationRepository } from "@anhourmail/core/delegation";
import { DELEGATION_RIGHTS, type DelegationRight, isDelegationRight } from "@anhourmail/shared/delegation";

import type { Executor } from "./client";
import { mailboxDelegation } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: string) => UUID.test(v);

type Row = typeof mailboxDelegation.$inferSelect;

/** Rows whose `right` isn't one we know (written by a newer release) are left out rather than guessed at. */
const toGrants = (rows: Row[]): DelegationGrant[] =>
  rows.flatMap((r) =>
    isDelegationRight(r.right)
      ? [
          {
            id: r.id,
            accountId: r.accountId,
            mailboxId: r.mailboxId,
            granteeUserId: r.granteeUserId,
            right: r.right,
            grantedBy: r.grantedBy,
            createdAt: r.createdAt,
          },
        ]
      : [],
  );

/** By right in `DELEGATION_RIGHTS` order, then oldest first (the same order as the memory adapter). */
const rightOrder = sql`array_position(array[${sql.join(
  DELEGATION_RIGHTS.map((r) => sql`${r}`),
  sql`, `,
)}]::text[], ${mailboxDelegation.right})`;
const byRight = [asc(rightOrder), asc(mailboxDelegation.createdAt), asc(mailboxDelegation.id)];

/** Mailbox delegation grants (ADR-0026); every query is scoped to the account. */
export class PgDelegationRepository implements DelegationRepository {
  constructor(private readonly x: Executor) {}

  async listForMailbox(accountId: string, mailboxId: string): Promise<DelegationGrant[]> {
    if (!isId(accountId) || !isId(mailboxId)) return [];
    const rows = await this.x
      .select()
      .from(mailboxDelegation)
      .where(and(eq(mailboxDelegation.accountId, accountId), eq(mailboxDelegation.mailboxId, mailboxId)))
      .orderBy(...byRight);
    return toGrants(rows);
  }

  async listForGrantee(accountId: string, userId: string): Promise<DelegationGrant[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .select()
      .from(mailboxDelegation)
      .where(and(eq(mailboxDelegation.accountId, accountId), eq(mailboxDelegation.granteeUserId, userId)))
      .orderBy(...byRight);
    return toGrants(rows);
  }

  async rightsOf(accountId: string, mailboxId: string, userId: string): Promise<DelegationRight[]> {
    if (!isId(accountId) || !isId(mailboxId)) return [];
    const rows = await this.x
      .select()
      .from(mailboxDelegation)
      .where(
        and(
          eq(mailboxDelegation.accountId, accountId),
          eq(mailboxDelegation.mailboxId, mailboxId),
          eq(mailboxDelegation.granteeUserId, userId),
        ),
      )
      .orderBy(...byRight);
    return toGrants(rows).map((g) => g.right);
  }

  async grant(input: {
    accountId: string;
    mailboxId: string;
    granteeUserId: string;
    right: DelegationRight;
    grantedBy: string | null;
    at: Date;
  }): Promise<boolean> {
    const rows = await this.x
      .insert(mailboxDelegation)
      .values({
        accountId: input.accountId,
        mailboxId: input.mailboxId,
        granteeUserId: input.granteeUserId,
        right: input.right,
        grantedBy: input.grantedBy,
        createdAt: input.at,
      })
      .onConflictDoNothing({
        target: [mailboxDelegation.mailboxId, mailboxDelegation.granteeUserId, mailboxDelegation.right],
      })
      .returning({ id: mailboxDelegation.id });
    return rows.length > 0;
  }

  async revoke(accountId: string, mailboxId: string, granteeUserId: string, right: DelegationRight): Promise<boolean> {
    if (!isId(accountId) || !isId(mailboxId)) return false;
    const rows = await this.x
      .delete(mailboxDelegation)
      .where(
        and(
          eq(mailboxDelegation.accountId, accountId),
          eq(mailboxDelegation.mailboxId, mailboxId),
          eq(mailboxDelegation.granteeUserId, granteeUserId),
          eq(mailboxDelegation.right, right),
        ),
      )
      .returning({ id: mailboxDelegation.id });
    return rows.length > 0;
  }

  async revokeAllForMailbox(accountId: string, mailboxId: string): Promise<DelegationGrant[]> {
    if (!isId(accountId) || !isId(mailboxId)) return [];
    const rows = await this.x
      .delete(mailboxDelegation)
      .where(and(eq(mailboxDelegation.accountId, accountId), eq(mailboxDelegation.mailboxId, mailboxId)))
      .returning();
    return sorted(toGrants(rows));
  }

  async revokeAllForGrantee(accountId: string, userId: string): Promise<DelegationGrant[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .delete(mailboxDelegation)
      .where(and(eq(mailboxDelegation.accountId, accountId), eq(mailboxDelegation.granteeUserId, userId)))
      .returning();
    return sorted(toGrants(rows));
  }
}

/** `DELETE … RETURNING` has no order: the same order as the lists. */
const sorted = (grants: DelegationGrant[]): DelegationGrant[] =>
  [...grants].sort(
    (a, b) =>
      DELEGATION_RIGHTS.indexOf(a.right) - DELEGATION_RIGHTS.indexOf(b.right) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
