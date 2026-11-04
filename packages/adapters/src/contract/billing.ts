// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing repository contract (ADR-0029 §10–§11), part of the adapter contract: memory in `npm test`, Postgres in
 * `npm run test:int`. Includes the scoping rule: another account's rows are never read, changed or removed.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { UnitOfWork } from "@anhourmail/core";
import { type AccountBilling, defaultBilling } from "@anhourmail/core/billing";
import type { PlanId } from "@anhourmail/shared/plans";

import type { AdapterFactory } from ".";

const DAY = 86_400_000;
const T = new Date("2026-11-04T12:00:00.000Z");
const at = (days: number) => new Date(T.getTime() + days * DAY);

const newAccount = (uow: UnitOfWork, plan: PlanId = "free") =>
  uow.run(async (r) => (await r.accounts.create({ name: `Billing contract ${randomUUID()}`, plan })).id);

const row = (accountId: string, over: Partial<AccountBilling> = {}): AccountBilling => ({
  ...defaultBilling(accountId, "free", T),
  updatedAt: T,
  ...over,
});

export function describeBillingContract(name: string, factory: AdapterFactory): void {
  describe(`${name} billing repositories`, () => {
    it("account creation writes the billing row: Free, or a staff grant on a paid plan; unknown ids are null", async () => {
      const { uow, cleanup } = await factory();
      try {
        const free = await newAccount(uow);
        const plus = await newAccount(uow, "plus");
        expect(await uow.run((r) => r.billing.get(free))).toMatchObject({
          accountId: free,
          state: "free",
          planSource: "none",
          paidPlan: null,
          storageBlocks: 0,
        });
        expect(await uow.run((r) => r.billing.get(plus))).toMatchObject({
          state: "active",
          planSource: "staff",
          paidPlan: "plus",
        });
        expect(await uow.run((r) => r.billing.get(randomUUID()))).toBeNull();
        expect(await uow.run((r) => r.billing.get("not-an-id"))).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it("save writes the whole row and reads it back; lookups by provider customer; provider ids are unique", async () => {
      const { uow, cleanup } = await factory();
      try {
        const a = await newAccount(uow);
        const b = await newAccount(uow);
        const customer = `cus_${randomUUID()}`;
        const saved = row(a, {
          state: "past_due",
          stateSince: at(1),
          planSource: "stripe",
          paidPlan: "supporter",
          providerCustomerId: customer,
          providerSubscriptionId: `sub_${randomUUID()}`,
          currency: "CAD",
          planAmountMinor: 5400,
          storageBlocks: 2,
          extraMailboxes: 3,
          periodPaidStorageBlocks: 1,
          periodPaidExtraMailboxes: 4,
          periodPaidFor: at(300),
          currentPeriodEnd: at(300),
          cancelAt: at(300),
          restrictedAt: null,
          disputedAt: at(2),
          lapsedAt: null,
          compUntil: null,
          lastInvoiceId: "in_1",
          lastInvoiceStatus: "open",
          checkoutPendingUntil: at(0.04),
          selfServiceRefundAt: at(0.5),
          addressCeilingOverride: 9000,
          lastSyncedAt: at(1),
          updatedAt: at(1),
        });
        await uow.run((r) => r.billing.save(saved));
        expect(await uow.run((r) => r.billing.get(a))).toEqual(saved);
        expect(await uow.run((r) => r.billing.byCustomerId(customer))).toEqual(saved);
        expect(await uow.run((r) => r.billing.byCustomerId(`cus_${randomUUID()}`))).toBeNull();
        expect(await uow.run((r) => r.billing.byCustomerId(""))).toBeNull();
        // Another account is untouched, and can't take the same provider customer.
        expect((await uow.run((r) => r.billing.get(b)))?.providerCustomerId).toBeNull();
        await expect(uow.run((r) => r.billing.save(row(b, { providerCustomerId: customer })))).rejects.toThrow();
        const lapsed = row(a, { state: "lapsed", providerCustomerId: customer, lapsedAt: at(5), updatedAt: at(5) });
        await uow.run((r) => r.billing.save(lapsed));
        expect(await uow.run((r) => r.billing.get(a))).toEqual(lapsed);
      } finally {
        await cleanup();
      }
    });

    it("lists accounts by state (oldest change first) and those due for a sync (never synced first)", async () => {
      const { uow, cleanup } = await factory();
      try {
        const ids = [await newAccount(uow), await newAccount(uow), await newAccount(uow)];
        const [a, b, c] = ids as [string, string, string];
        // Far-future times so rows left by other runs in a shared database sort before these.
        const far = (d: number) => at(100_000 + d);
        await uow.run(async (r) => {
          await r.billing.save(
            row(a, { state: "restricted", stateSince: far(2), providerCustomerId: `cus_${randomUUID()}` }),
          );
          await r.billing.save(
            row(b, {
              state: "restricted",
              stateSince: far(1),
              providerCustomerId: `cus_${randomUUID()}`,
              lastSyncedAt: far(0),
            }),
          );
          await r.billing.save(row(c, { state: "lapsed", providerCustomerId: null, lastSyncedAt: null }));
        });
        const restricted = await uow.run((r) => r.billing.listByState("restricted", 10_000));
        const mine = restricted.map((x) => x.accountId).filter((id) => ids.includes(id));
        expect(mine).toEqual([b, a]);
        const due = await uow.run((r) => r.billing.dueForSync(far(1), 10_000));
        expect(due).toContain(a);
        expect(due).toContain(b);
        expect(due).not.toContain(c); // no provider customer: nothing to sync
        expect(due.indexOf(a)).toBeLessThan(due.indexOf(b)); // never synced before synced
        expect(await uow.run((r) => r.billing.dueForSync(far(-1), 10_000))).not.toContain(b);
        // Comps whose free period has ended (billing.timers), earliest first; a comp still running isn't listed.
        await uow.run(async (r) => {
          await r.billing.save(row(a, { state: "active", planSource: "comp", paidPlan: "plus", compUntil: far(-2) }));
          await r.billing.save(row(b, { state: "active", planSource: "comp", paidPlan: "plus", compUntil: far(-3) }));
          await r.billing.save(row(c, { state: "active", planSource: "comp", paidPlan: "plus", compUntil: far(5) }));
        });
        const ended = (await uow.run((r) => r.billing.compsEnded(far(0), 10_000))).filter((id) => ids.includes(id));
        expect(ended).toEqual([b, a]);
      } finally {
        await cleanup();
      }
    });

    it("events: recorded once; orphans; pending oldest first and scoped; processed, dismissed, pruned", async () => {
      const { uow, cleanup } = await factory();
      try {
        const a = await newAccount(uow);
        const b = await newAccount(uow);
        const evt = (accountId: string | null, created: Date, id = `evt_${randomUUID()}`) => ({
          providerEventId: id,
          type: "invoice.paid",
          accountId,
          objectId: "in_1",
          providerCreatedAt: created,
          receivedAt: T,
        });
        const dup = `evt_${randomUUID()}`;
        expect(await uow.run((r) => r.billing.recordEvent(evt(a, at(2), dup)))).toEqual(expect.any(String));
        expect(await uow.run((r) => r.billing.recordEvent(evt(a, at(2), dup)))).toBeNull();
        await uow.run((r) => r.billing.recordEvent(evt(a, at(1))));
        await uow.run((r) => r.billing.recordEvent(evt(b, at(0))));
        const orphanId = `evt_${randomUUID()}`;
        await uow.run((r) => r.billing.recordEvent(evt(null, at(0), orphanId)));

        const pending = await uow.run((r) => r.billing.pendingEvents(a));
        expect(pending.map((e) => e.providerCreatedAt)).toEqual([at(1), at(2)]);
        expect(pending.every((e) => e.accountId === a && e.status === "queued" && e.processedAt === null)).toBe(true);
        const [otherEvent] = await uow.run((r) => r.billing.pendingEvents(b));
        // Marking is scoped: b's event id passed for account a changes nothing.
        expect(
          await uow.run((r) =>
            r.billing.markEventsProcessed(a, [...pending.map((e) => e.id), otherEvent?.id ?? ""], at(3)),
          ),
        ).toBe(2);
        expect(await uow.run((r) => r.billing.pendingEvents(a))).toEqual([]);
        expect(await uow.run((r) => r.billing.pendingEvents(b))).toHaveLength(1);
        expect(
          await uow.run((r) => r.billing.markEventsProcessed(b, [otherEvent?.id ?? ""], at(3), "SyncFailed")),
        ).toBe(1);
        expect(await uow.run((r) => r.billing.markEventsProcessed(b, [otherEvent?.id ?? ""], at(4)))).toBe(0);

        const orphans = await uow.run((r) => r.billing.listEvents("orphan", 10_000));
        const orphan = orphans.find((e) => e.providerEventId === orphanId);
        expect(orphan).toMatchObject({ accountId: null, status: "orphan" });
        // A dispute event resolved later is adopted by its account and queued; adopting twice does nothing.
        const disputeOrphan = `evt_${randomUUID()}`;
        await uow.run((r) =>
          r.billing.recordEvent({ ...evt(null, at(0.5), disputeOrphan), type: "charge.dispute.created" }),
        );
        const adoptable = (await uow.run((r) => r.billing.listEvents("orphan", 10_000))).find(
          (e) => e.providerEventId === disputeOrphan,
        );
        expect(await uow.run((r) => r.billing.adoptOrphan(adoptable?.id ?? "", b))).toBe(true);
        expect(await uow.run((r) => r.billing.adoptOrphan(adoptable?.id ?? "", b))).toBe(false);
        expect(await uow.run((r) => r.billing.adoptOrphan("not-an-id", b))).toBe(false);
        expect((await uow.run((r) => r.billing.pendingEvents(b))).map((e) => e.providerEventId)).toContain(
          disputeOrphan,
        );
        expect(await uow.run((r) => r.billing.dismissOrphan(orphan?.id ?? "", at(5)))).toBe(true);
        expect(await uow.run((r) => r.billing.dismissOrphan(orphan?.id ?? "", at(5)))).toBe(false);
        const processed = await uow.run((r) => r.billing.listEvents("processed", 10_000));
        expect(processed.find((e) => e.id === otherEvent?.id)).toMatchObject({
          error: "SyncFailed",
          processedAt: at(3),
        });

        // Pruning removes processed and dismissed events received before the cut-off, never queued ones or orphans.
        await uow.run((r) => r.billing.recordEvent({ ...evt(a, at(6)), receivedAt: at(-100) }));
        const keptOrphan = `evt_${randomUUID()}`;
        await uow.run((r) => r.billing.recordEvent({ ...evt(null, at(6), keptOrphan), receivedAt: at(-100) }));
        expect(await uow.run((r) => r.billing.pruneEvents(at(1)))).toBeGreaterThanOrEqual(4);
        expect(await uow.run((r) => r.billing.pendingEvents(a))).toHaveLength(1);
        expect(
          (await uow.run((r) => r.billing.listEvents("orphan", 10_000))).some((e) => e.providerEventId === keptOrphan),
        ).toBe(true);
        expect((await uow.run((r) => r.billing.listEvents("processed", 10_000))).some((e) => e.accountId === a)).toBe(
          false,
        );
      } finally {
        await cleanup();
      }
    });

    it("disputes: tracked per id, updated in place, scoped; never moved to another account; getEvent by id", async () => {
      const { uow, cleanup } = await factory();
      try {
        const a = await newAccount(uow);
        const b = await newAccount(uow);
        const d1 = `dp_${randomUUID()}`;
        const d2 = `dp_${randomUUID()}`;
        const dispute = (disputeId: string, status: "open" | "lost" | "won", opened: Date) => ({
          accountId: a,
          disputeId,
          status,
          openedAt: opened,
          closedAt: status === "open" ? null : at(3),
          updatedAt: at(3),
        });
        await uow.run((r) => r.billing.saveDisputes(a, [dispute(d2, "open", at(2)), dispute(d1, "open", at(1))]));
        await uow.run((r) => r.billing.saveDisputes(a, [dispute(d1, "lost", at(1))]));
        expect(await uow.run((r) => r.billing.disputes(a))).toEqual([
          dispute(d1, "lost", at(1)),
          { ...dispute(d2, "open", at(2)), updatedAt: at(3) },
        ]);
        // Another account saving the same dispute id changes nothing, and reads only its own.
        await uow.run((r) => r.billing.saveDisputes(b, [{ ...dispute(d1, "won", at(1)), accountId: b }]));
        expect(await uow.run((r) => r.billing.disputes(b))).toEqual([]);
        expect((await uow.run((r) => r.billing.disputes(a)))[0]?.status).toBe("lost");
        expect(await uow.run((r) => r.billing.disputes("not-an-id"))).toEqual([]);

        const id = await uow.run((r) =>
          r.billing.recordEvent({
            providerEventId: `evt_${randomUUID()}`,
            type: "charge.dispute.created",
            accountId: null,
            objectId: d1,
            providerCreatedAt: T,
            receivedAt: T,
          }),
        );
        expect(await uow.run((r) => r.billing.getEvent(id ?? ""))).toMatchObject({ status: "orphan", objectId: d1 });
        expect(await uow.run((r) => r.billing.getEvent(randomUUID()))).toBeNull();
        expect(await uow.run((r) => r.billing.getEvent("not-an-id"))).toBeNull();

        // The effective plan the rest of the code reads; the billing sync is its only writer.
        await uow.run((r) => r.accounts.setPlan(a, "plus"));
        expect((await uow.run((r) => r.accounts.get(a)))?.plan).toBe("plus");
        expect((await uow.run((r) => r.accounts.get(b)))?.plan).toBe("free");

        expect(await uow.run((r) => r.dataLifecycle.deleteAccount(a))).toBe(true);
        expect(await uow.run((r) => r.billing.disputes(a))).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("plan holds: replaced as a whole, ordered, scoped to the account, one per subject", async () => {
      const { uow, cleanup } = await factory();
      try {
        const a = await newAccount(uow);
        const b = await newAccount(uow);
        const [m1, m2, d1, al1] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await uow.run((r) =>
          r.billing.replaceHolds(
            a,
            [
              { subjectType: "alias", subjectId: al1, receiveUntil: null },
              { subjectType: "domain", subjectId: d1, receiveUntil: null },
              { subjectType: "mailbox", subjectId: m1, receiveUntil: at(30) },
            ],
            T,
          ),
        );
        const bHold = randomUUID();
        await uow.run((r) =>
          r.billing.replaceHolds(b, [{ subjectType: "mailbox", subjectId: bHold, receiveUntil: at(30) }], T),
        );
        const holds = await uow.run((r) => r.billing.holds(a));
        expect(holds.map((h) => [h.subjectType, h.subjectId, h.receiveUntil])).toEqual([
          ["mailbox", m1, at(30)],
          ["domain", d1, null],
          ["alias", al1, null],
        ]);
        expect(holds.every((h) => h.accountId === a && h.heldAt.getTime() === T.getTime())).toBe(true);
        expect(await uow.run((r) => r.billing.heldIds(a, "mailbox", [m1, m2, bHold, "nope"]))).toEqual([m1]);
        expect(await uow.run((r) => r.billing.heldIds(b, "mailbox", [m1]))).toEqual([]);

        // The Owner's swap: m2 held instead of m1; b's holds untouched.
        await uow.run((r) =>
          r.billing.replaceHolds(a, [{ subjectType: "mailbox", subjectId: m2, receiveUntil: at(10) }], at(1)),
        );
        expect((await uow.run((r) => r.billing.holds(a))).map((h) => h.subjectId)).toEqual([m2]);
        expect(await uow.run((r) => r.billing.holds(b))).toHaveLength(1);
        // One hold per subject, across accounts; a receive window only on mailboxes.
        await expect(
          uow.run((r) =>
            r.billing.replaceHolds(a, [{ subjectType: "mailbox", subjectId: bHold, receiveUntil: null }], T),
          ),
        ).rejects.toThrow();
        await expect(
          uow.run((r) =>
            r.billing.replaceHolds(a, [{ subjectType: "alias", subjectId: randomUUID(), receiveUntil: T }], T),
          ),
        ).rejects.toThrow();
        expect((await uow.run((r) => r.billing.holds(a))).map((h) => h.subjectId)).toEqual([m2]); // rolled back
        expect(await uow.run((r) => r.billing.clearHolds(a))).toBe(1);
        expect(await uow.run((r) => r.billing.clearHolds(a))).toBe(0);
        expect(await uow.run((r) => r.billing.holds(b))).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it("an account's billing rows go with it; invite codes keep their history", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const staff = await createUser(`staff-${randomUUID()}@example.test`);
        const a = await newAccount(uow);
        await uow.run(async (r) => {
          await r.billing.recordEvent({
            providerEventId: `evt_${randomUUID()}`,
            type: "invoice.paid",
            accountId: a,
            objectId: "in_1",
            providerCreatedAt: T,
            receivedAt: T,
          });
          await r.billing.replaceHolds(a, [{ subjectType: "domain", subjectId: randomUUID(), receiveUntil: null }], T);
        });
        const hash = randomUUID().replaceAll("-", "").repeat(2);
        await uow.run((r) => r.inviteCodes.create({ ...codeInput(staff, hash), grantsSignup: true }));
        const claimed = await uow.run((r) =>
          r.inviteCodes.claim({ codeHash: hash, email: "any@example.test", userId: staff, accountId: a, now: T }),
        );
        expect(claimed?.redeemedAccountId).toBe(a);
        expect(await uow.run((r) => r.dataLifecycle.deleteAccount(a))).toBe(true);
        expect(await uow.run((r) => r.billing.get(a))).toBeNull();
        expect(await uow.run((r) => r.billing.pendingEvents(a))).toEqual([]);
        expect(await uow.run((r) => r.billing.holds(a))).toEqual([]);
        expect(await uow.run((r) => r.inviteCodes.get(claimed?.id ?? ""))).toMatchObject({
          redeemedAccountId: null,
          redeemedBy: staff,
        });
      } finally {
        await cleanup();
      }
    });

    it("invite codes: created with a lower-cased binding, listed newest first, found and claimed once", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const staff = await createUser(`staff-${randomUUID()}@example.test`);
        const redeemer = await createUser(`redeemer-${randomUUID()}@example.test`);
        const hash = randomUUID().replaceAll("-", "").repeat(2);
        const created = await uow.run((r) =>
          r.inviteCodes.create({
            ...codeInput(staff, hash),
            compPlan: "plus",
            compDays: 30,
            email: " Ana@Example.TEST ",
          }),
        );
        expect(created).toMatchObject({
          codeHash: hash,
          email: "ana@example.test",
          compPlan: "plus",
          compDays: 30,
          createdBy: staff,
          redeemedAt: null,
          revokedAt: null,
        });
        expect(await uow.run((r) => r.inviteCodes.get(created.id))).toEqual(created);
        expect(await uow.run((r) => r.inviteCodes.get("not-an-id"))).toBeNull();
        const newer = await uow.run((r) =>
          r.inviteCodes.create({
            ...codeInput(staff, randomUUID().replaceAll("-", "").repeat(2)),
            at: at(100_000),
            expiresAt: at(100_030),
          }),
        );
        const listed = await uow.run((r) => r.inviteCodes.list(10_000));
        expect(listed.findIndex((c) => c.id === newer.id)).toBeLessThan(listed.findIndex((c) => c.id === created.id));

        // Bound to one email: anyone else gets nothing (the same answer as a wrong code).
        expect(await uow.run((r) => r.inviteCodes.findRedeemable(hash, "other@example.test", T))).toBeNull();
        expect(await uow.run((r) => r.inviteCodes.findRedeemable(hash, "ANA@example.test", T))).toMatchObject({
          id: created.id,
        });
        expect(
          await uow.run((r) =>
            r.inviteCodes.claim({
              codeHash: hash,
              email: "other@example.test",
              userId: redeemer,
              accountId: null,
              now: T,
            }),
          ),
        ).toBeNull();

        // Two redeemers at once: exactly one wins.
        const results = await Promise.all(
          [0, 1].map(() =>
            uow.run((r) =>
              r.inviteCodes.claim({
                codeHash: hash,
                email: "ana@example.test",
                userId: redeemer,
                accountId: null,
                now: T,
              }),
            ),
          ),
        );
        expect(results.filter((x) => x !== null)).toHaveLength(1);
        expect(results.find((x) => x !== null)).toMatchObject({ redeemedBy: redeemer, redeemedAt: T });
        expect(await uow.run((r) => r.inviteCodes.findRedeemable(hash, "ana@example.test", T))).toBeNull();
        expect(await uow.run((r) => r.inviteCodes.revoke(created.id, staff, T))).toBe(false); // used: can't revoke
      } finally {
        await cleanup();
      }
    });

    it("invite codes: expired and revoked ones can't be claimed; revoking is once", async () => {
      const { uow, cleanup, createUser } = await factory();
      try {
        const staff = await createUser(`staff-${randomUUID()}@example.test`);
        const expiring = randomUUID().replaceAll("-", "").repeat(2);
        await uow.run((r) => r.inviteCodes.create({ ...codeInput(staff, expiring), expiresAt: at(1) }));
        const claim = (codeHash: string, now: Date) =>
          uow.run((r) =>
            r.inviteCodes.claim({ codeHash, email: "x@example.test", userId: staff, accountId: null, now }),
          );
        expect(await claim(expiring, at(1))).toBeNull(); // expires_at is exclusive
        const revoked = randomUUID().replaceAll("-", "").repeat(2);
        const code = await uow.run((r) => r.inviteCodes.create(codeInput(staff, revoked)));
        expect(await uow.run((r) => r.inviteCodes.revoke(code.id, staff, T))).toBe(true);
        expect(await uow.run((r) => r.inviteCodes.revoke(code.id, staff, T))).toBe(false);
        expect(await uow.run((r) => r.inviteCodes.revoke(randomUUID(), staff, T))).toBe(false);
        expect(await uow.run((r) => r.inviteCodes.revoke("nope", staff, T))).toBe(false);
        expect(await claim(revoked, T)).toBeNull();
        expect(await uow.run((r) => r.inviteCodes.get(code.id))).toMatchObject({ revokedAt: T, revokedBy: staff });
        expect(await claim("0".repeat(64), T)).toBeNull();
        // A code hash is unique.
        await expect(uow.run((r) => r.inviteCodes.create(codeInput(staff, revoked)))).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });
  });
}

const codeInput = (createdBy: string, codeHash: string) => ({
  codeHash,
  label: "Contract",
  grantsSignup: true,
  compPlan: null,
  compDays: null,
  email: null,
  createdBy,
  expiresAt: at(30),
  at: at(-1),
});
