// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";

import {
  type AccountTrust,
  type MailboxSendingRestriction,
  type MailboxStandingRow,
  type MailboxTrust,
  type PromotionCriteria,
  SEND_HELD_ACTION,
  storedRestriction,
  type TrustRepository,
  type TrustTierChange,
} from "@anhourmail/core/trust";
import { isSuspensionReason, type SuspensionReason } from "@anhourmail/shared/platform";
import { isTrustTier, isTrustTierSource, type TrustTier } from "@anhourmail/shared/sending";

import type { Executor } from "./client";
import { accountBilling, accountMembership, auditLog, authUser, customerAccount, mailbox, userProfile } from "./schema";

const isId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** A value the database check refused to store reads as the strictest safe value, never as a laxer one. */
const tierOf = (v: string): TrustTier => (isTrustTier(v) ? v : "restricted");
const reasonOf = (v: string | null): SuspensionReason | null => (v !== null && isSuspensionReason(v) ? v : null);

type MailboxRow = {
  id: string;
  accountId: string;
  address: string;
  at: Date | null;
  reason: string | null;
  note: string | null;
  by: string | null;
};

/** Restricted whenever `sending_restricted_at` is set (`storedRestriction`), as `standingByAddress` reads it. */
const toMailboxTrust = (r: MailboxRow): MailboxTrust => ({
  mailboxId: r.id,
  accountId: r.accountId,
  address: r.address,
  restriction: storedRestriction({ at: r.at, reason: r.reason, note: r.note, byUserId: r.by }),
});

const mailboxColumns = {
  id: mailbox.id,
  accountId: mailbox.accountId,
  address: mailbox.address,
  at: mailbox.sendingRestrictedAt,
  reason: mailbox.sendingRestrictedReason,
  note: mailbox.sendingRestrictedNote,
  by: mailbox.sendingRestrictedBy,
};

/**
 * Every condition an account must meet to be promoted automatically (ADR-0034 §2), for `promotionCandidates` and,
 * under the account lock, `qualifiesForPromotion`. The query joins `account_billing` on the account.
 */
const promotable = (c: Omit<PromotionCriteria, "limit">) => {
  const a = customerAccount;
  return and(
    // The partial index `customer_account_trust_promote_idx` covers this filter and the candidates' order.
    eq(a.trustTier, "new"),
    ne(a.trustTierSource, "staff"),
    isNull(a.lastRestrictedAt),
    sql`${a.createdAt} < ${c.createdBefore.toISOString()}::timestamptz`,
    eq(a.status, "active"),
    isNull(a.suspendedAt),
    sql`coalesce(${accountBilling.state}, 'free') not in ('restricted', 'lapsed')`,
    sql`not exists (
      select 1 from ${accountMembership} m join ${userProfile} p on p.user_id = m.user_id
      where m.account_id = ${a.id} and p.suspended
    )`,
    sql`exists (select 1 from ${accountMembership} m where m.account_id = ${a.id} and m.role = 'owner')`,
    sql`not exists (
      select 1 from ${accountMembership} m join ${authUser} u on u.id = m.user_id
      where m.account_id = ${a.id} and m.role = 'owner' and not u.email_verified
    )`,
    sql`(
      select count(*) from ${auditLog} l
      where l.scope = 'account:' || ${a.id}::text and l.action = ${SEND_HELD_ACTION}
        and l.at >= ${c.heldSince.toISOString()}::timestamptz
    ) < ${c.maxHeld}`,
  );
};

/** Trust tiers on `customer_account` and `mailbox` (ADR-0034); every statement is scoped to one account. */
export class PgTrustRepository implements TrustRepository {
  constructor(private readonly x: Executor) {}

  async get(accountId: string): Promise<AccountTrust | null> {
    if (!isId(accountId)) return null;
    const [r] = await this.x
      .select({
        tier: customerAccount.trustTier,
        since: customerAccount.trustTierSince,
        source: customerAccount.trustTierSource,
        reason: customerAccount.trustReason,
        note: customerAccount.trustNote,
        setBy: customerAccount.trustSetBy,
        lastRestrictedAt: customerAccount.lastRestrictedAt,
      })
      .from(customerAccount)
      .where(eq(customerAccount.id, accountId));
    if (!r) return null;
    return {
      accountId,
      tier: tierOf(r.tier),
      since: r.since,
      source: isTrustTierSource(r.source) ? r.source : "staff",
      reason: reasonOf(r.reason),
      note: r.note,
      setBy: r.setBy,
      lastRestrictedAt: r.lastRestrictedAt,
    };
  }

  async setTier(accountId: string, change: TrustTierChange): Promise<boolean> {
    if (!isId(accountId)) return false;
    const rows = await this.x
      .update(customerAccount)
      .set({
        trustTier: change.tier,
        trustTierSince: change.since,
        trustTierSource: change.source,
        trustReason: change.reason,
        trustNote: change.note,
        trustSetBy: change.setBy,
      })
      .where(eq(customerAccount.id, accountId))
      .returning({ id: customerAccount.id });
    return rows.length > 0;
  }

  async markRestricted(accountId: string, at: Date): Promise<void> {
    if (!isId(accountId)) return;
    await this.x
      .update(customerAccount)
      .set({ lastRestrictedAt: sql`greatest(${customerAccount.lastRestrictedAt}, ${at.toISOString()}::timestamptz)` })
      .where(eq(customerAccount.id, accountId));
  }

  async promotionCandidates(c: PromotionCriteria): Promise<{ accountId: string; createdAt: Date }[]> {
    if (c.limit <= 0) return [];
    const rows = await this.x
      .select({ accountId: customerAccount.id, createdAt: customerAccount.createdAt })
      .from(customerAccount)
      .leftJoin(accountBilling, eq(accountBilling.accountId, customerAccount.id))
      .where(promotable(c))
      .orderBy(asc(customerAccount.createdAt), asc(customerAccount.id))
      .limit(c.limit);
    return rows;
  }

  async qualifiesForPromotion(accountId: string, c: Omit<PromotionCriteria, "limit">): Promise<boolean> {
    if (!isId(accountId)) return false;
    const rows = await this.x
      .select({ id: customerAccount.id })
      .from(customerAccount)
      .leftJoin(accountBilling, eq(accountBilling.accountId, customerAccount.id))
      .where(and(eq(customerAccount.id, accountId), promotable(c)));
    return rows.length > 0;
  }

  async mailboxes(accountId: string): Promise<MailboxTrust[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .select(mailboxColumns)
      .from(mailbox)
      .where(eq(mailbox.accountId, accountId))
      .orderBy(mailbox.address);
    return rows.map(toMailboxTrust);
  }

  async mailbox(accountId: string, mailboxId: string): Promise<MailboxTrust | null> {
    if (!isId(accountId) || !isId(mailboxId)) return null;
    const [r] = await this.x
      .select(mailboxColumns)
      .from(mailbox)
      .where(and(eq(mailbox.id, mailboxId), eq(mailbox.accountId, accountId)));
    return r ? toMailboxTrust(r) : null;
  }

  async setMailboxRestriction(
    accountId: string,
    mailboxId: string,
    restriction: MailboxSendingRestriction | null,
  ): Promise<boolean> {
    if (!isId(accountId) || !isId(mailboxId)) return false;
    const rows = await this.x
      .update(mailbox)
      .set({
        sendingRestrictedAt: restriction?.at ?? null,
        sendingRestrictedReason: restriction?.reason ?? null,
        sendingRestrictedNote: restriction?.note ?? null,
        sendingRestrictedBy: restriction?.byUserId ?? null,
      })
      .where(and(eq(mailbox.id, mailboxId), eq(mailbox.accountId, accountId)))
      .returning({ id: mailbox.id });
    return rows.length > 0;
  }

  async standingByAddress(address: string): Promise<MailboxStandingRow | null> {
    const [r] = await this.x
      .select({
        accountId: mailbox.accountId,
        mailboxId: mailbox.id,
        tier: customerAccount.trustTier,
        tierSince: customerAccount.trustTierSince,
        restrictedAt: mailbox.sendingRestrictedAt,
      })
      .from(mailbox)
      .innerJoin(customerAccount, eq(customerAccount.id, mailbox.accountId))
      .where(eq(mailbox.address, address.trim().toLowerCase()))
      .limit(1);
    if (!r) return null;
    return {
      accountId: r.accountId,
      mailboxId: r.mailboxId,
      accountTier: tierOf(r.tier),
      tierSince: r.tierSince,
      mailboxRestricted: r.restrictedAt !== null,
    };
  }

  async changedSince(since: Date, limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    const at = since.toISOString();
    const rows = await this.x
      .select({ id: customerAccount.id })
      .from(customerAccount)
      .where(
        sql`${customerAccount.trustTierSince} >= ${at}::timestamptz
          or ${customerAccount.lastRestrictedAt} >= ${at}::timestamptz
          or exists (
            select 1 from ${mailbox} m
            where m.account_id = ${customerAccount.id} and m.sending_restricted_at >= ${at}::timestamptz
          )`,
      )
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
