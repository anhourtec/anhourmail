// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import {
  type AccountBilling,
  BILLING_STATES,
  type BillingDispute,
  type BillingDisputeStatus,
  type BillingEvent,
  BILLING_EVENT_STATUSES,
  type BillingEventStatus,
  type BillingRepository,
  type BillingState,
  DISPUTE_STATUSES,
  type HoldSubject,
  HOLD_SUBJECTS,
  type InviteCode,
  type InviteCodeRepository,
  INVOICE_STATUSES,
  type InvoiceStatus,
  PLAN_SOURCES,
  type PlanHold,
  type PlanHoldInput,
  type PlanSource,
} from "@anhourmail/core/billing";
import { BILLING, type Currency, isPaidPlan, type PaidPlanId } from "@anhourmail/shared/plans";

import type { Executor } from "./client";
import { accountBilling, billingDispute, billingEvent, inviteCode, planHold } from "./schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: string) => UUID.test(v);

const oneOf = <T extends string>(values: readonly T[], v: string | null, fallback: T): T =>
  v !== null && (values as readonly string[]).includes(v) ? (v as T) : fallback;
const maybeOf = <T extends string>(values: readonly T[], v: string | null): T | null =>
  v !== null && (values as readonly string[]).includes(v) ? (v as T) : null;
const paidPlan = (v: string | null): PaidPlanId | null => (v !== null && isPaidPlan(v) ? v : null);

type BillingRow = typeof accountBilling.$inferSelect;

/** Values this release doesn't know (written by a newer one) read as the safest meaning, never guessed upward. */
function toBilling(r: BillingRow): AccountBilling {
  return {
    accountId: r.accountId,
    state: oneOf<BillingState>(BILLING_STATES, r.state, "free"),
    stateSince: r.stateSince,
    planSource: oneOf<PlanSource>(PLAN_SOURCES, r.planSource, "none"),
    paidPlan: paidPlan(r.paidPlan),
    providerCustomerId: r.providerCustomerId,
    providerSubscriptionId: r.providerSubscriptionId,
    currency: maybeOf<Currency>(BILLING.currencies, r.currency),
    planAmountMinor: r.planAmountMinor,
    storageBlocks: r.storageBlocks,
    extraMailboxes: r.extraMailboxes,
    periodPaidStorageBlocks: r.periodPaidStorageBlocks,
    periodPaidExtraMailboxes: r.periodPaidExtraMailboxes,
    currentPeriodEnd: r.currentPeriodEnd,
    cancelAt: r.cancelAt,
    restrictedAt: r.restrictedAt,
    disputedAt: r.disputedAt,
    lapsedAt: r.lapsedAt,
    compUntil: r.compUntil,
    lastInvoiceId: r.lastInvoiceId,
    lastInvoiceStatus: maybeOf<InvoiceStatus>(INVOICE_STATUSES, r.lastInvoiceStatus),
    checkoutPendingUntil: r.checkoutPendingUntil,
    addressCeilingOverride: r.addressCeilingOverride,
    lastSyncedAt: r.lastSyncedAt,
    updatedAt: r.updatedAt,
  };
}

function toEvent(r: typeof billingEvent.$inferSelect): BillingEvent {
  return {
    id: r.id,
    providerEventId: r.providerEventId,
    type: r.type,
    accountId: r.accountId,
    objectId: r.objectId,
    providerCreatedAt: r.providerCreatedAt,
    status: oneOf<BillingEventStatus>(BILLING_EVENT_STATUSES, r.status, "queued"),
    error: r.error,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt,
  };
}

const holdOrder = sql`array_position(array['mailbox', 'domain', 'alias']::text[], ${planHold.subjectType})`;

const toHolds = (rows: (typeof planHold.$inferSelect)[]): PlanHold[] =>
  rows.flatMap((r) => {
    const subjectType = maybeOf<HoldSubject>(HOLD_SUBJECTS, r.subjectType);
    return subjectType
      ? [
          {
            id: r.id,
            accountId: r.accountId,
            subjectType,
            subjectId: r.subjectId,
            heldAt: r.heldAt,
            receiveUntil: r.receiveUntil,
          },
        ]
      : [];
  });

/** Account billing, provider events and plan holds (ADR-0029 §11); account-scoped except the webhook's lookups. */
export class PgBillingRepository implements BillingRepository {
  constructor(private readonly x: Executor) {}

  async get(accountId: string): Promise<AccountBilling | null> {
    if (!isId(accountId)) return null;
    const [r] = await this.x.select().from(accountBilling).where(eq(accountBilling.accountId, accountId));
    return r ? toBilling(r) : null;
  }

  async save(row: AccountBilling): Promise<void> {
    const { accountId, ...rest } = row;
    await this.x
      .insert(accountBilling)
      .values({ accountId, ...rest })
      .onConflictDoUpdate({ target: accountBilling.accountId, set: rest });
  }

  async byCustomerId(customerId: string): Promise<AccountBilling | null> {
    if (customerId === "") return null;
    const [r] = await this.x.select().from(accountBilling).where(eq(accountBilling.providerCustomerId, customerId));
    return r ? toBilling(r) : null;
  }

  async listByState(state: BillingState, limit: number): Promise<AccountBilling[]> {
    const rows = await this.x
      .select()
      .from(accountBilling)
      .where(eq(accountBilling.state, state))
      .orderBy(asc(accountBilling.stateSince), asc(accountBilling.accountId))
      .limit(limit);
    return rows.map(toBilling);
  }

  async compsEnded(at: Date, limit: number): Promise<string[]> {
    const rows = await this.x
      .select({ id: accountBilling.accountId })
      .from(accountBilling)
      .where(and(eq(accountBilling.planSource, "comp"), lte(accountBilling.compUntil, at)))
      .orderBy(asc(accountBilling.compUntil), asc(accountBilling.accountId))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async dueForSync(before: Date, limit: number): Promise<string[]> {
    const rows = await this.x
      .select({ id: accountBilling.accountId })
      .from(accountBilling)
      .where(
        and(
          sql`${accountBilling.providerCustomerId} is not null`,
          or(isNull(accountBilling.lastSyncedAt), lt(accountBilling.lastSyncedAt, before)),
        ),
      )
      .orderBy(sql`${accountBilling.lastSyncedAt} asc nulls first`, asc(accountBilling.accountId))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async recordEvent(input: {
    providerEventId: string;
    type: string;
    accountId: string | null;
    objectId: string;
    providerCreatedAt: Date;
    receivedAt: Date;
  }): Promise<string | null> {
    const [row] = await this.x
      .insert(billingEvent)
      .values({ ...input, status: input.accountId === null ? "orphan" : "queued" })
      .onConflictDoNothing({ target: billingEvent.providerEventId })
      .returning({ id: billingEvent.id });
    return row?.id ?? null;
  }

  async pendingEvents(accountId: string): Promise<BillingEvent[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .select()
      .from(billingEvent)
      .where(and(eq(billingEvent.accountId, accountId), eq(billingEvent.status, "queued")))
      .orderBy(asc(billingEvent.providerCreatedAt), asc(billingEvent.id));
    return rows.map(toEvent);
  }

  async markEventsProcessed(accountId: string, ids: readonly string[], at: Date, error?: string): Promise<number> {
    const wanted = ids.filter(isId);
    if (!isId(accountId) || wanted.length === 0) return 0;
    const rows = await this.x
      .update(billingEvent)
      .set({ status: "processed", processedAt: at, error: error ?? null })
      .where(
        and(eq(billingEvent.accountId, accountId), eq(billingEvent.status, "queued"), inArray(billingEvent.id, wanted)),
      )
      .returning({ id: billingEvent.id });
    return rows.length;
  }

  async getEvent(id: string): Promise<BillingEvent | null> {
    if (!isId(id)) return null;
    const [r] = await this.x.select().from(billingEvent).where(eq(billingEvent.id, id));
    return r ? toEvent(r) : null;
  }

  async listEvents(status: BillingEventStatus, limit: number): Promise<BillingEvent[]> {
    const rows = await this.x
      .select()
      .from(billingEvent)
      .where(eq(billingEvent.status, status))
      .orderBy(desc(billingEvent.receivedAt), desc(billingEvent.id))
      .limit(limit);
    return rows.map(toEvent);
  }

  async adoptOrphan(id: string, accountId: string): Promise<boolean> {
    if (!isId(id) || !isId(accountId)) return false;
    const rows = await this.x
      .update(billingEvent)
      .set({ status: "queued", accountId })
      .where(and(eq(billingEvent.id, id), eq(billingEvent.status, "orphan")))
      .returning({ id: billingEvent.id });
    return rows.length > 0;
  }

  async dismissOrphan(id: string, at: Date): Promise<boolean> {
    if (!isId(id)) return false;
    const rows = await this.x
      .update(billingEvent)
      .set({ status: "dismissed", processedAt: at })
      .where(and(eq(billingEvent.id, id), eq(billingEvent.status, "orphan")))
      .returning({ id: billingEvent.id });
    return rows.length > 0;
  }

  async pruneEvents(before: Date): Promise<number> {
    const rows = await this.x
      .delete(billingEvent)
      .where(and(inArray(billingEvent.status, ["processed", "dismissed"]), lt(billingEvent.receivedAt, before)))
      .returning({ id: billingEvent.id });
    return rows.length;
  }

  async disputes(accountId: string): Promise<BillingDispute[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .select()
      .from(billingDispute)
      .where(eq(billingDispute.accountId, accountId))
      .orderBy(asc(billingDispute.openedAt), asc(billingDispute.disputeId));
    return rows.map((r) => ({
      accountId: r.accountId,
      disputeId: r.disputeId,
      // A status this release doesn't know (a newer one wrote it) restricts: never read as lifted.
      status: oneOf<BillingDisputeStatus>(DISPUTE_STATUSES, r.status, "open"),
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      updatedAt: r.updatedAt,
    }));
  }

  async saveDisputes(accountId: string, rows: readonly BillingDispute[]): Promise<void> {
    if (!isId(accountId)) throw new Error("not an account id");
    for (const d of rows) {
      const set = { status: d.status, closedAt: d.closedAt, updatedAt: d.updatedAt };
      await this.x
        .insert(billingDispute)
        .values({ disputeId: d.disputeId, accountId, openedAt: d.openedAt, ...set })
        // Only the account's own row is updated: a dispute id tracked for another account is never moved or changed.
        .onConflictDoUpdate({
          target: billingDispute.disputeId,
          set,
          setWhere: eq(billingDispute.accountId, accountId),
        });
    }
  }

  async holds(accountId: string): Promise<PlanHold[]> {
    if (!isId(accountId)) return [];
    const rows = await this.x
      .select()
      .from(planHold)
      .where(eq(planHold.accountId, accountId))
      .orderBy(asc(holdOrder), asc(planHold.heldAt), asc(planHold.subjectId));
    return toHolds(rows);
  }

  async heldIds(accountId: string, subjectType: HoldSubject, ids: readonly string[]): Promise<string[]> {
    const wanted = ids.filter(isId);
    if (!isId(accountId) || wanted.length === 0) return [];
    const rows = await this.x
      .select({ id: planHold.subjectId })
      .from(planHold)
      .where(
        and(
          eq(planHold.accountId, accountId),
          eq(planHold.subjectType, subjectType),
          inArray(planHold.subjectId, wanted),
        ),
      );
    return rows.map((r) => r.id);
  }

  async replaceHolds(accountId: string, holds: readonly PlanHoldInput[], at: Date): Promise<void> {
    if (!isId(accountId)) throw new Error("not an account id");
    await this.x.delete(planHold).where(eq(planHold.accountId, accountId));
    if (holds.length === 0) return;
    await this.x.insert(planHold).values(
      holds.map((h) => ({
        accountId,
        subjectType: h.subjectType,
        subjectId: h.subjectId,
        heldAt: at,
        receiveUntil: h.receiveUntil,
      })),
    );
  }

  async clearHolds(accountId: string): Promise<number> {
    if (!isId(accountId)) return 0;
    const rows = await this.x.delete(planHold).where(eq(planHold.accountId, accountId)).returning({ id: planHold.id });
    return rows.length;
  }
}

function toCode(r: typeof inviteCode.$inferSelect): InviteCode {
  return {
    id: r.id,
    codeHash: r.codeHash,
    label: r.label,
    grantsSignup: r.grantsSignup,
    compPlan: paidPlan(r.compPlan),
    compDays: r.compDays,
    email: r.email,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    redeemedAt: r.redeemedAt,
    redeemedBy: r.redeemedBy,
    redeemedAccountId: r.redeemedAccountId,
    revokedAt: r.revokedAt,
    revokedBy: r.revokedBy,
  };
}

/** A code that can be redeemed now by `email`: unused, not revoked, not expired, and unbound or bound to that email. */
const redeemable = (codeHash: string, email: string, now: Date) =>
  and(
    eq(inviteCode.codeHash, codeHash),
    isNull(inviteCode.redeemedAt),
    isNull(inviteCode.revokedAt),
    gt(inviteCode.expiresAt, now),
    or(isNull(inviteCode.email), eq(inviteCode.email, email.trim().toLowerCase())),
  );

/** Staff-made invite codes (ADR-0029 §8); redemption is one conditional update, so exactly one claimer wins. */
export class PgInviteCodeRepository implements InviteCodeRepository {
  constructor(private readonly x: Executor) {}

  async create(input: {
    codeHash: string;
    label: string;
    grantsSignup: boolean;
    compPlan: PaidPlanId | null;
    compDays: number | null;
    email: string | null;
    createdBy: string | null;
    expiresAt: Date;
    at: Date;
  }): Promise<InviteCode> {
    const { at, email, ...rest } = input;
    const [r] = await this.x
      .insert(inviteCode)
      .values({ ...rest, email: email === null ? null : email.trim().toLowerCase(), createdAt: at })
      .returning();
    if (!r) throw new Error("invite code not created");
    return toCode(r);
  }

  async get(id: string): Promise<InviteCode | null> {
    if (!isId(id)) return null;
    const [r] = await this.x.select().from(inviteCode).where(eq(inviteCode.id, id));
    return r ? toCode(r) : null;
  }

  async list(limit: number): Promise<InviteCode[]> {
    const rows = await this.x
      .select()
      .from(inviteCode)
      .orderBy(desc(inviteCode.createdAt), desc(inviteCode.id))
      .limit(limit);
    return rows.map(toCode);
  }

  async findRedeemable(codeHash: string, email: string, now: Date): Promise<InviteCode | null> {
    const [r] = await this.x
      .select()
      .from(inviteCode)
      .where(redeemable(codeHash, email, now));
    return r ? toCode(r) : null;
  }

  async claim(input: {
    codeHash: string;
    email: string;
    userId: string;
    accountId: string | null;
    now: Date;
  }): Promise<InviteCode | null> {
    if (input.accountId !== null && !isId(input.accountId)) return null;
    const [r] = await this.x
      .update(inviteCode)
      .set({ redeemedAt: input.now, redeemedBy: input.userId, redeemedAccountId: input.accountId })
      .where(redeemable(input.codeHash, input.email, input.now))
      .returning();
    return r ? toCode(r) : null;
  }

  async revoke(id: string, by: string, at: Date): Promise<boolean> {
    if (!isId(id)) return false;
    const rows = await this.x
      .update(inviteCode)
      .set({ revokedAt: at, revokedBy: by })
      .where(and(eq(inviteCode.id, id), isNull(inviteCode.redeemedAt), isNull(inviteCode.revokedAt)))
      .returning({ id: inviteCode.id });
    return rows.length > 0;
  }
}
