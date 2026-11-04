// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import type {
  AccountBilling,
  BillingDispute,
  BillingEvent,
  BillingRepository,
  HoldSubject,
  InviteCode,
  InviteCodeRepository,
  PlanHold,
} from "@anhourmail/core/billing";

/** What the billing repositories read from the rest of the in-memory state. */
type State = {
  accounts: { id: string }[];
  userEmails: Record<string, string>;
  billing: AccountBilling[];
  billingEvents: BillingEvent[];
  billingDisputes: BillingDispute[];
  planHolds: PlanHold[];
  inviteCodes: InviteCode[];
};

const clone = <T>(v: T): T => structuredClone(v);
const HOLD_ORDER: readonly HoldSubject[] = ["mailbox", "domain", "alias"];
const byEventTime = (a: BillingEvent, b: BillingEvent) =>
  a.providerCreatedAt.getTime() - b.providerCreatedAt.getTime() || a.id.localeCompare(b.id);
const newestReceived = (a: BillingEvent, b: BillingEvent) =>
  b.receivedAt.getTime() - a.receivedAt.getTime() || b.id.localeCompare(a.id);

/**
 * In-memory billing (ADR-0029 §11); same contract as Postgres (src/contract), including its constraints: unique
 * provider ids, one hold per subject, and the account foreign keys (rows go with their account in
 * `memoryDataLifecycle`).
 */
export function memoryBilling(s: State): BillingRepository {
  const accountExists = (id: string) => s.accounts.some((a) => a.id === id);
  return {
    get: async (accountId) => clone(s.billing.find((b) => b.accountId === accountId) ?? null),

    save: async (row) => {
      if (!accountExists(row.accountId)) throw new Error(`no account ${row.accountId}`);
      const clash = (key: "providerCustomerId" | "providerSubscriptionId") =>
        row[key] !== null && s.billing.some((b) => b.accountId !== row.accountId && b[key] === row[key]);
      if (clash("providerCustomerId") || clash("providerSubscriptionId")) {
        throw new Error("duplicate provider id (unique constraint)");
      }
      s.billing = [...s.billing.filter((b) => b.accountId !== row.accountId), clone(row)];
    },

    byCustomerId: async (customerId) =>
      clone(s.billing.find((b) => customerId !== "" && b.providerCustomerId === customerId) ?? null),

    listByState: async (state, limit) =>
      clone(
        s.billing
          .filter((b) => b.state === state)
          .sort((a, b) => a.stateSince.getTime() - b.stateSince.getTime() || a.accountId.localeCompare(b.accountId))
          .slice(0, limit),
      ),

    dueForSync: async (before, limit) =>
      s.billing
        .filter((b) => b.providerCustomerId !== null && (b.lastSyncedAt === null || b.lastSyncedAt < before))
        .sort(
          (a, b) =>
            (a.lastSyncedAt?.getTime() ?? -Infinity) - (b.lastSyncedAt?.getTime() ?? -Infinity) ||
            a.accountId.localeCompare(b.accountId),
        )
        .slice(0, limit)
        .map((b) => b.accountId),

    recordEvent: async (input) => {
      if (s.billingEvents.some((e) => e.providerEventId === input.providerEventId)) return null;
      if (input.accountId !== null && !accountExists(input.accountId)) throw new Error(`no account ${input.accountId}`);
      const id = randomUUID();
      s.billingEvents.push({
        id,
        providerEventId: input.providerEventId,
        type: input.type,
        accountId: input.accountId,
        objectId: input.objectId,
        providerCreatedAt: clone(input.providerCreatedAt),
        status: input.accountId === null ? "orphan" : "queued",
        error: null,
        receivedAt: clone(input.receivedAt),
        processedAt: null,
      });
      return id;
    },

    pendingEvents: async (accountId) =>
      clone(s.billingEvents.filter((e) => e.accountId === accountId && e.status === "queued").sort(byEventTime)),

    markEventsProcessed: async (accountId, ids, at, error) => {
      let n = 0;
      for (const e of s.billingEvents) {
        if (e.accountId === accountId && e.status === "queued" && ids.includes(e.id)) {
          Object.assign(e, { status: "processed", processedAt: clone(at), error: error ?? null });
          n++;
        }
      }
      return n;
    },

    getEvent: async (id) => clone(s.billingEvents.find((e) => e.id === id) ?? null),

    listEvents: async (status, limit) =>
      clone(
        s.billingEvents
          .filter((e) => e.status === status)
          .sort(newestReceived)
          .slice(0, limit),
      ),

    adoptOrphan: async (id, accountId) => {
      const e = s.billingEvents.find((x) => x.id === id && x.status === "orphan");
      if (!e) return false;
      if (!accountExists(accountId)) throw new Error(`no account ${accountId}`); // the foreign key
      Object.assign(e, { status: "queued", accountId });
      return true;
    },

    dismissOrphan: async (id, at) => {
      const e = s.billingEvents.find((x) => x.id === id && x.status === "orphan");
      if (!e) return false;
      Object.assign(e, { status: "dismissed", processedAt: clone(at) });
      return true;
    },

    pruneEvents: async (before) => {
      const keep = (e: BillingEvent) =>
        !((e.status === "processed" || e.status === "dismissed") && e.receivedAt < before);
      const n = s.billingEvents.filter((e) => !keep(e)).length;
      s.billingEvents = s.billingEvents.filter(keep);
      return n;
    },

    disputes: async (accountId) =>
      clone(
        s.billingDisputes
          .filter((d) => d.accountId === accountId)
          .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.disputeId.localeCompare(b.disputeId)),
      ),

    saveDisputes: async (accountId, rows) => {
      if (!accountExists(accountId)) throw new Error(`no account ${accountId}`);
      for (const r of rows) {
        const cur = s.billingDisputes.find((d) => d.disputeId === r.disputeId);
        if (cur && cur.accountId !== accountId) continue; // never moved between accounts
        const row = { ...clone(r), accountId };
        s.billingDisputes = [...s.billingDisputes.filter((d) => d.disputeId !== r.disputeId), row];
      }
    },

    holds: async (accountId) =>
      clone(
        s.planHolds
          .filter((h) => h.accountId === accountId)
          .sort(
            (a, b) =>
              HOLD_ORDER.indexOf(a.subjectType) - HOLD_ORDER.indexOf(b.subjectType) ||
              a.heldAt.getTime() - b.heldAt.getTime() ||
              a.subjectId.localeCompare(b.subjectId),
          ),
      ),

    heldIds: async (accountId, subjectType, ids) =>
      s.planHolds
        .filter((h) => h.accountId === accountId && h.subjectType === subjectType && ids.includes(h.subjectId))
        .map((h) => h.subjectId),

    replaceHolds: async (accountId, holds, at) => {
      if (!accountExists(accountId)) throw new Error(`no account ${accountId}`);
      const others = s.planHolds.filter((h) => h.accountId !== accountId);
      const seen = new Set(others.map((h) => `${h.subjectType}:${h.subjectId}`));
      const added: PlanHold[] = [];
      for (const h of holds) {
        const key = `${h.subjectType}:${h.subjectId}`;
        if (seen.has(key)) throw new Error("duplicate hold (unique constraint)");
        if (h.receiveUntil !== null && h.subjectType !== "mailbox") throw new Error("receive window on a non-mailbox");
        seen.add(key);
        added.push({ id: randomUUID(), accountId, ...clone(h), heldAt: clone(at) });
      }
      s.planHolds = [...others, ...added];
    },

    clearHolds: async (accountId) => {
      const n = s.planHolds.filter((h) => h.accountId === accountId).length;
      s.planHolds = s.planHolds.filter((h) => h.accountId !== accountId);
      return n;
    },
  };
}

const usable = (c: InviteCode, codeHash: string, email: string, now: Date) =>
  c.codeHash === codeHash &&
  c.redeemedAt === null &&
  c.revokedAt === null &&
  c.expiresAt > now &&
  (c.email === null || c.email === email.trim().toLowerCase());

/** In-memory invite codes (ADR-0029 §8). Units of work run one at a time, so a claim is atomic. */
export function memoryInviteCodes(s: State): InviteCodeRepository {
  return {
    create: async ({ at, email, ...input }) => {
      if (s.inviteCodes.some((c) => c.codeHash === input.codeHash))
        throw new Error("duplicate code (unique constraint)");
      if (input.expiresAt <= at) throw new Error("expiry before creation (check constraint)");
      if (input.createdBy !== null && s.userEmails[input.createdBy] === undefined) {
        throw new Error(`no user ${input.createdBy}`);
      }
      const code: InviteCode = {
        id: randomUUID(),
        ...clone(input),
        email: email === null ? null : email.trim().toLowerCase(),
        createdAt: clone(at),
        redeemedAt: null,
        redeemedBy: null,
        redeemedAccountId: null,
        revokedAt: null,
        revokedBy: null,
      };
      s.inviteCodes.push(code);
      return clone(code);
    },
    get: async (id) => clone(s.inviteCodes.find((c) => c.id === id) ?? null),
    list: async (limit) =>
      clone(
        [...s.inviteCodes]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, limit),
      ),
    findRedeemable: async (codeHash, email, now) =>
      clone(s.inviteCodes.find((c) => usable(c, codeHash, email, now)) ?? null),
    claim: async ({ codeHash, email, userId, accountId, now }) => {
      const c = s.inviteCodes.find((x) => usable(x, codeHash, email, now));
      if (!c) return null;
      Object.assign(c, { redeemedAt: clone(now), redeemedBy: userId, redeemedAccountId: accountId });
      return clone(c);
    },
    revoke: async (id, by, at) => {
      const c = s.inviteCodes.find((x) => x.id === id && x.redeemedAt === null && x.revokedAt === null);
      if (!c) return false;
      Object.assign(c, { revokedAt: clone(at), revokedBy: by });
      return true;
    },
  };
}
