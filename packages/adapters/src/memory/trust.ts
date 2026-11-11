// SPDX-License-Identifier: AGPL-3.0-only
import type { AuditEntry } from "@anhourmail/core/audit";
import type { AccountBilling } from "@anhourmail/core/billing";
import type { Mailbox } from "@anhourmail/core/mailboxes";
import type { SuspensionRecord } from "@anhourmail/core/platform";
import {
  type AccountTrust,
  type MailboxSendingRestriction,
  type MailboxTrust,
  SEND_HELD_ACTION,
  storedRestriction,
  type TrustRepository,
} from "@anhourmail/core/trust";
import type { AccountRole } from "@anhourmail/shared/rbac";

/** One account's trust columns (Postgres: on `customer_account`); an account without a row reads as the defaults. */
export type MemoryTrustRow = AccountTrust;
/** One mailbox's sending restriction (Postgres: `mailbox.sending_restricted_*`). */
export type MemoryMailboxRestriction = MailboxSendingRestriction & { mailboxId: string };

/** What the trust repository reads from the rest of the in-memory state. */
type State = {
  accounts: { id: string; status?: string; createdAt?: Date }[];
  mailboxes: Mailbox[];
  memberships: { userId: string; accountId: string; role: AccountRole }[];
  unverifiedEmails: string[];
  personSuspensions: Record<string, SuspensionRecord>;
  accountSuspensions: Record<string, SuspensionRecord>;
  billing: AccountBilling[];
  audit: AuditEntry[];
  trust: MemoryTrustRow[];
  mailboxRestrictions: MemoryMailboxRestriction[];
};

const EPOCH = new Date(0);
const clone = <T>(v: T): T => structuredClone(v);

/** In-memory trust tiers (ADR-0034); same contract as Postgres (src/contract), scoping included. */
export function memoryTrust(s: State): TrustRepository {
  const account = (id: string) => s.accounts.find((a) => a.id === id);
  const rowOf = (accountId: string): AccountTrust | null => {
    const a = account(accountId);
    if (!a) return null;
    const row = s.trust.find((t) => t.accountId === accountId);
    return clone(
      row ?? {
        accountId,
        tier: "new",
        since: a.createdAt ?? EPOCH,
        source: "default",
        reason: null,
        note: null,
        setBy: null,
        lastRestrictedAt: null,
      },
    );
  };
  const write = (row: AccountTrust) => {
    s.trust = [...s.trust.filter((t) => t.accountId !== row.accountId), clone(row)];
  };
  const restrictionOf = (mailboxId: string): MailboxSendingRestriction | null => {
    const r = s.mailboxRestrictions.find((x) => x.mailboxId === mailboxId);
    // Restricted whenever it has a time, as in Postgres (`storedRestriction`).
    return r ? clone(storedRestriction({ at: r.at, reason: r.reason, note: r.note, byUserId: r.byUserId })) : null;
  };
  const toTrust = (m: Mailbox): MailboxTrust => ({
    mailboxId: m.id,
    accountId: m.accountId,
    address: m.address,
    restriction: restrictionOf(m.id),
  });
  const ownMailbox = (accountId: string, mailboxId: string) =>
    s.mailboxes.find((m) => m.id === mailboxId && m.accountId === accountId);

  return {
    get: async (accountId) => rowOf(accountId),

    setTier: async (accountId, change) => {
      const current = rowOf(accountId);
      if (!current) return false;
      write({ ...current, ...clone(change), accountId });
      return true;
    },

    markRestricted: async (accountId, at) => {
      const current = rowOf(accountId);
      if (!current) return;
      if (current.lastRestrictedAt && current.lastRestrictedAt >= at) return;
      write({ ...current, lastRestrictedAt: new Date(at) });
    },

    promotionCandidates: async ({ createdBefore, heldSince, maxHeld, limit }) => {
      const out: { accountId: string; createdAt: Date }[] = [];
      for (const a of s.accounts) {
        const t = rowOf(a.id);
        const createdAt = a.createdAt ?? EPOCH;
        if (t?.tier !== "new" || t.source === "staff" || t.lastRestrictedAt !== null) continue;
        if (createdAt >= createdBefore) continue;
        if ((a.status ?? "active") !== "active" || s.accountSuspensions[a.id] !== undefined) continue;
        const members = s.memberships.filter((m) => m.accountId === a.id);
        if (members.some((m) => s.personSuspensions[m.userId] !== undefined)) continue;
        const owners = members.filter((m) => m.role === "owner");
        if (owners.length === 0 || owners.some((o) => s.unverifiedEmails.includes(o.userId))) continue;
        const state = s.billing.find((b) => b.accountId === a.id)?.state ?? "free";
        if (state === "restricted" || state === "lapsed") continue;
        const held = s.audit.filter(
          (e) =>
            e.scope === `account:${a.id}` && e.action === SEND_HELD_ACTION && Date.parse(e.at) >= heldSince.getTime(),
        ).length;
        if (held >= maxHeld) continue;
        out.push({ accountId: a.id, createdAt: new Date(createdAt) });
      }
      return out
        .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.accountId.localeCompare(y.accountId))
        .slice(0, Math.max(0, limit));
    },

    mailboxes: async (accountId) =>
      s.mailboxes
        .filter((m) => m.accountId === accountId)
        .sort((a, b) => a.address.localeCompare(b.address))
        .map(toTrust),

    mailbox: async (accountId, mailboxId) => {
      const m = ownMailbox(accountId, mailboxId);
      return m ? toTrust(m) : null;
    },

    setMailboxRestriction: async (accountId, mailboxId, restriction) => {
      if (!ownMailbox(accountId, mailboxId)) return false;
      s.mailboxRestrictions = s.mailboxRestrictions.filter((r) => r.mailboxId !== mailboxId);
      if (restriction) s.mailboxRestrictions.push({ ...clone(restriction), mailboxId });
      return true;
    },

    standingByAddress: async (address) => {
      const key = address.toLowerCase();
      const m = s.mailboxes.find((x) => x.address.toLowerCase() === key);
      const t = m ? rowOf(m.accountId) : null;
      if (!m || !t) return null;
      return {
        accountId: m.accountId,
        mailboxId: m.id,
        accountTier: t.tier,
        mailboxRestricted: s.mailboxRestrictions.some((r) => r.mailboxId === m.id),
      };
    },
  };
}
