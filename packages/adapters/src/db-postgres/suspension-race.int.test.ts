// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Staff person suspensions racing other changes (Postgres only: the in-memory adapter runs one unit of work at a time).
 *
 * - An account suspension still uncommitted while the person's suspension is lifted: the lift used to read the holds
 *   without the account's lock, see only its own, and resume the mailbox while the account went suspended. The person
 *   paths lock the accounts of the person's mailboxes first, so the lift waits and sees the account's hold.
 * - Two staff clicks on "Suspend" at once: both used to pass the "already suspended?" check (two emails, two audit
 *   entries). The person's login row is locked first, so the second waits and answers 409.
 * - A mailbox created for the person in another account while the suspension is uncommitted: the create waits for the
 *   person's login lock, then sees the suspension and makes the mailbox suspended with a `person` hold.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";

import { type Actor, ConflictError, systemClock } from "@anhourmail/core";
import { createMailbox } from "@anhourmail/core/mailboxes";
import { liftPersonSuspension, suspendPerson } from "@anhourmail/core/platform";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "./client";
import { PgUnitOfWork } from "./repositories";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (integration tests need the compose stack)");

const { db, pool } = createDb(url);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const meta = { requestId: "int-suspension-race", ip: null, userAgent: null };
const tag = randomUUID().slice(0, 8);
const staffId = `ga-race-${tag}`;
const staffSession = `s-ga-race-${tag}`;
const session = { sessionId: staffSession };
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

/** A person with one active mailbox in a fresh account. */
async function personWithMailbox(): Promise<{ userId: string; accountId: string; mailboxId: string }> {
  await ensureStaff();
  const n = randomUUID().slice(0, 8);
  const userId = `race-${n}`;
  userIds.push(userId);
  await db
    .insert(schema.authUser)
    .values({ id: userId, name: "Member", email: `${userId}@example.test`, emailVerified: true });
  const [account] = await db
    .insert(schema.customerAccount)
    .values({ name: `race ${n}`, plan: "plus" })
    .returning();
  if (!account) throw new Error("account not created");
  accountIds.push(account.id);
  await db.insert(schema.accountMembership).values({ accountId: account.id, userId, role: "member" });
  const [m] = await db
    .insert(schema.mailbox)
    .values({ accountId: account.id, userId, address: `m@race-${n}.test`, quotaBytes: 1024, status: "active" })
    .returning();
  if (!m) throw new Error("mailbox not created");
  return { userId, accountId: account.id, mailboxId: m.id };
}

const mailboxStatus = async (id: string) =>
  (await db.select({ status: schema.mailbox.status }).from(schema.mailbox).where(eq(schema.mailbox.id, id)))[0]?.status;

it("an account suspension uncommitted while a person's suspension is lifted keeps their mailbox suspended", async () => {
  const p = await personWithMailbox();
  await suspendPerson(deps, staff, p.userId, { reason: "spam" }, session, meta);
  expect(await mailboxStatus(p.mailboxId)).toBe("suspended");

  // The account suspension's unit of work (as suspendAccount writes it), held open after its writes.
  const wrote = deferred();
  const gate = deferred();
  const accountSuspension = deps.uow.run(async (r) => {
    await r.accounts.lock(p.accountId);
    await r.suspensions.setAccount(p.accountId, { reason: "spam", note: null, at: new Date(), byUserId: staffId });
    await r.suspensions.addHold(p.mailboxId, "account");
    wrote.resolve();
    await gate.promise;
  });
  await wrote.promise;

  const lift = liftPersonSuspension(deps, staff, p.userId, session, meta);
  expect(await settledWithin(lift, 300)).toBe(false); // waits for the account's lock
  gate.resolve();
  await accountSuspension;
  const out = await lift;

  expect(out.mailboxes).toBe(0);
  expect(await mailboxStatus(p.mailboxId)).toBe("suspended");
  const holds = await db
    .select({ kind: schema.mailboxStaffHold.kind })
    .from(schema.mailboxStaffHold)
    .where(eq(schema.mailboxStaffHold.mailboxId, p.mailboxId));
  expect(holds.map((h) => h.kind)).toEqual(["account"]);
});

it("two concurrent suspensions of one person: one goes through, the other is 409 (one success entry)", async () => {
  const p = await personWithMailbox();
  const results = await Promise.allSettled([
    suspendPerson(deps, staff, p.userId, { reason: "abuse" }, session, meta),
    suspendPerson(deps, staff, p.userId, { reason: "abuse" }, session, meta),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(results.find((r) => r.status === "rejected")?.reason).toMatchObject({ code: "conflict" });
  const entries = await db
    .select({ result: schema.auditLog.result })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.scope, "platform"),
        eq(schema.auditLog.action, "trust.suspended"),
        eq(schema.auditLog.targetId, p.userId),
      ),
    );
  expect(entries.filter((e) => e.result === "success")).toHaveLength(1);
  const jobs = await db
    .select({ id: schema.provisioningJob.id })
    .from(schema.provisioningJob)
    .where(eq(schema.provisioningJob.subjectId, p.mailboxId));
  expect(jobs).toHaveLength(1);
});

it("a deadlock Postgres breaks answers 409 (try again), not a 500, and rolls that unit of work back", async () => {
  const a = await personWithMailbox();
  const b = await personWithMailbox();
  const first = deferred();
  const second = deferred();
  // Opposite orders on purpose (no service does this): one of the two is chosen as the deadlock victim.
  const one = deps.uow.run(async (r) => {
    await r.accounts.lock(a.accountId);
    first.resolve();
    await second.promise;
    await r.accounts.lock(b.accountId);
  });
  const two = deps.uow.run(async (r) => {
    await r.accounts.lock(b.accountId);
    second.resolve();
    await first.promise;
    await r.accounts.lock(a.accountId);
  });
  const results = await Promise.allSettled([one, two]);
  expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
  const failed = results.find((x) => x.status === "rejected");
  expect(failed?.reason).toMatchObject({ code: "deadlock" });
  expect(failed?.reason).toBeInstanceOf(ConflictError);
});

it("a mailbox created for a person while their suspension is uncommitted starts suspended with a person hold", async () => {
  const p = await personWithMailbox();
  // A second account where the person is a member, with an active domain and an Owner who adds the mailbox.
  const n = randomUUID().slice(0, 8);
  const [other] = await db
    .insert(schema.customerAccount)
    .values({ name: `race b ${n}`, plan: "plus" })
    .returning();
  if (!other) throw new Error("account not created");
  accountIds.push(other.id);
  const ownerId = `race-owner-${n}`;
  userIds.push(ownerId);
  await db
    .insert(schema.authUser)
    .values({ id: ownerId, name: "Owner", email: `${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.accountMembership).values([
    { accountId: other.id, userId: ownerId, role: "owner" },
    { accountId: other.id, userId: p.userId, role: "member" },
  ]);
  const [dom] = await db
    .insert(schema.customerDomain)
    .values({ accountId: other.id, name: `race-b-${n}.test`, status: "active", verifyToken: "t" })
    .returning();
  if (!dom) throw new Error("domain not created");
  const owner: Actor = {
    kind: "user",
    userId: ownerId,
    email: `${ownerId}@example.test`,
    platformRoles: [],
    memberships: [{ accountId: other.id, role: "owner" }],
    suspended: false,
  };
  const hasher = { hash: hashPassword };

  // The person suspension's unit of work (as lockPerson + setPerson leave it), held open.
  const wrote = deferred();
  const gate = deferred();
  const suspension = deps.uow.run(async (r) => {
    await r.accounts.lock(p.accountId);
    await r.dataLifecycle.lockLogin(p.userId);
    await r.suspensions.setPerson(p.userId, { reason: "abuse", note: null, at: new Date(), byUserId: staffId });
    wrote.resolve();
    await gate.promise;
  });
  await wrote.promise;
  const created = createMailbox(
    deps,
    owner,
    other.id,
    { localPart: "late", domainId: dom.id, ownerUserId: p.userId, password: "a long enough passphrase 42" },
    meta,
    hasher,
  );
  expect(await settledWithin(created, 300)).toBe(false); // waits for the person's login lock
  gate.resolve();
  await suspension;
  const m = await created;
  expect(m.status).toBe("suspended");
  expect(await mailboxStatus(m.id)).toBe("suspended");
  const holds = await db
    .select({ kind: schema.mailboxStaffHold.kind })
    .from(schema.mailboxStaffHold)
    .where(eq(schema.mailboxStaffHold.mailboxId, m.id));
  expect(holds.map((h) => h.kind)).toEqual(["person"]);
});
