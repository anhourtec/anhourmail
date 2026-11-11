// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The promotion job racing a person's staff suspension (Postgres only: the in-memory adapter runs one unit of work at
 * a time). Security review of ADR-0034 slices 1–11, finding 5.
 *
 * - A suspension of a member (no mailbox in the account) uncommitted while the job promotes the account: the
 *   promotion used to check only the tier, the account's status and billing under its lock. The suspension now locks
 *   every account of the person first, and the promotion checks every condition again under the same lock, so it waits
 *   and then skips the account.
 * - The promotion holding the lock first: the suspension (the real service) waits for it, then marks the account, so
 *   the job never promotes it again.
 */
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { suspendPerson } from "@anhourmail/core/platform";
import { promoteEstablished } from "@anhourmail/core/trust";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { createDb, schema } from "./client";
import { PgUnitOfWork } from "./repositories";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (integration tests need the compose stack)");

const { db, pool } = createDb(url);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const meta = { requestId: "int-trust-race", ip: null, userAgent: null };
const tag = randomUUID().slice(0, 8);
const staffId = `ga-trust-race-${tag}`;
const staffSession = `s-ga-trust-race-${tag}`;
const userIds: string[] = [staffId];
const accountIds: string[] = [];

const staff: Actor = {
  kind: "user",
  userId: staffId,
  email: `${staffId}@example.test`,
  platformRoles: ["global_admin"],
  memberships: [],
  suspended: false,
};

/** The job's criteria: every account created up to now, fewer than three held sends in the last hour. */
const criteria = () => ({
  createdBefore: new Date(Date.now() + 60_000),
  heldSince: new Date(Date.now() - 3_600_000),
  maxHeld: 3,
});

afterAll(async () => {
  if (accountIds.length > 0)
    await db.delete(schema.customerAccount).where(inArray(schema.customerAccount.id, accountIds));
  await db.delete(schema.authUser).where(inArray(schema.authUser.id, userIds));
  await pool.end();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const settledWithin = async (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => {
      setTimeout(() => {
        r(false);
      }, ms);
    }),
  ]);

let staffReady = false;
async function ensureStaff(): Promise<void> {
  if (staffReady) return;
  await db
    .insert(schema.authUser)
    .values({ id: staffId, name: "Staff", email: `${staffId}@example.test`, emailVerified: true });
  await db.insert(schema.platformRoleAssignment).values({ userId: staffId, role: "global_admin", grantedBy: "int" });
  await db.insert(schema.authVerification).values({
    id: randomUUID(),
    identifier: `step-up-${staffSession}`,
    value: staffId,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  staffReady = true;
}

/** A `new` account that qualifies for promotion: a confirmed Owner and a Member with no mailbox in it. */
async function promotableAccount(): Promise<{ accountId: string; memberId: string }> {
  await ensureStaff();
  const n = randomUUID().slice(0, 8);
  const ownerId = `trust-race-owner-${n}`;
  const memberId = `trust-race-member-${n}`;
  userIds.push(ownerId, memberId);
  await db.insert(schema.authUser).values([
    { id: ownerId, name: "Owner", email: `${ownerId}@example.test`, emailVerified: true },
    { id: memberId, name: "Member", email: `${memberId}@example.test`, emailVerified: true },
  ]);
  const [account] = await db
    .insert(schema.customerAccount)
    .values({ name: `trust race ${n}`, plan: "free" })
    .returning();
  if (!account) throw new Error("account not created");
  accountIds.push(account.id);
  await db.insert(schema.accountMembership).values([
    { accountId: account.id, userId: ownerId, role: "owner" },
    { accountId: account.id, userId: memberId, role: "member" },
  ]);
  return { accountId: account.id, memberId };
}

const trustOf = async (accountId: string) =>
  (
    await db
      .select({
        tier: schema.customerAccount.trustTier,
        source: schema.customerAccount.trustTierSource,
        lastRestrictedAt: schema.customerAccount.lastRestrictedAt,
      })
      .from(schema.customerAccount)
      .where(eq(schema.customerAccount.id, accountId))
  )[0];

it("qualifies before the race: the account is a promotion candidate", async () => {
  const a = await promotableAccount();
  expect(await deps.uow.run((r) => r.trust.qualifiesForPromotion(a.accountId, criteria()))).toBe(true);
});

it("a member's suspension uncommitted while the job promotes: the promotion waits, then skips the account", async () => {
  const a = await promotableAccount();
  // The suspension's unit of work as suspendPerson writes it (every account of the person locked first), held open
  // after the person is marked suspended and before its account mark: the promotion must not get past it.
  const wrote = deferred();
  const gate = deferred();
  const suspension = deps.uow.run(async (r) => {
    await r.accounts.lock(a.accountId);
    await r.suspensions.setPerson(a.memberId, { reason: "spam", note: null, at: new Date(), byUserId: staffId });
    wrote.resolve();
    await gate.promise;
  });
  await wrote.promise;

  const promotion = deps.uow.run((r) => promoteEstablished(deps, r, a.accountId, criteria()));
  expect(await settledWithin(promotion, 300)).toBe(false); // waits for the account's lock
  gate.resolve();
  await suspension;
  expect(await promotion).toEqual([]);
  expect(await trustOf(a.accountId)).toMatchObject({ tier: "new", source: "default" });
});

it("the promotion holding the lock first: the person's suspension waits, then marks the account", async () => {
  const a = await promotableAccount();
  const promoted = deferred();
  const gate = deferred();
  const promotion = deps.uow.run(async (r) => {
    const changes = await promoteEstablished(deps, r, a.accountId, criteria());
    promoted.resolve();
    await gate.promise;
    return changes;
  });
  await promoted.promise;

  const suspension = suspendPerson(deps, staff, a.memberId, { reason: "spam" }, { sessionId: staffSession }, meta);
  // It takes the account's lock before writing anything (the member has no mailbox in the account).
  expect(await settledWithin(suspension, 300)).toBe(false);
  gate.resolve();
  expect(await promotion).toHaveLength(1);
  await suspension;
  const after = await trustOf(a.accountId);
  expect(after).toMatchObject({ tier: "standard", source: "automatic" });
  expect(after?.lastRestrictedAt).toBeInstanceOf(Date);
  // Never a candidate again.
  expect(await deps.uow.run((r) => r.trust.qualifiesForPromotion(a.accountId, criteria()))).toBe(false);
});
