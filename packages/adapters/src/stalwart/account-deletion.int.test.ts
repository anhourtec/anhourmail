// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Data export and account deletion end to end (ADR-0025) on the compose stack: Postgres, the provisioning worker's jobs
 * and the real Stalwart. An Owner's account export is built, sealed with a key ring, downloaded and opened, and holds
 * this account's data only. Deleting the account suspends its mailbox on the mail server at once; nothing is removed
 * during the grace period; after it (the clock moved forward) the scheduler's steps purge the mailbox and its mail,
 * release the domain and delete the account, while its audit log stays.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Clock, type Deps, type UnitOfWork, type UserActor } from "@anhourmail/core";
import {
  buildNextExport,
  cancelAccountDeletion,
  downloadExport,
  requestAccountDeletion,
  requestExport,
  runDueDeletions,
} from "@anhourmail/core/data";
import { purgeDueMailboxes } from "@anhourmail/core/mailboxes";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { createKeyRing } from "@anhourmail/server/keyring";
import { ACCOUNT_DELETION_GRACE_DAYS } from "@anhourmail/shared/data-lifecycle";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { readZip } from "../../../../tests/support/zip";
import { sealedArchiver } from "../archive";
import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartMailServer } from ".";

const dbUrl = process.env.TEST_DATABASE_URL;
const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!dbUrl || !stalwartUrl || !admin || !adminPassword) {
  throw new Error("integration tests need TEST_DATABASE_URL, STALWART_URL and the dev Stalwart admin");
}

const { db, pool } = createDb(dbUrl);
const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const mail = stalwartMailServer(mgmt);
const tag = randomUUID().slice(0, 8);
const domain = `del-${tag}.test`;
const address = `owner@${domain}`;
const otherAddress = `someone@other-${tag}.test`;
const password = randomBytes(18).toString("base64url");
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;
let accountId = "";
let otherAccountId = "";
let userId = "";

/** A clock the test moves forward (the grace period), shared by every step. */
const now = { t: Date.now() };
const clock: Clock = { now: () => new Date(now.t) };
const base: Deps = { uow: new PgUnitOfWork(db), clock, platform: PUBLIC_PLATFORM };
/**
 * Other suites share the test database: the scheduler steps here only see this test's account and mailbox, so moving
 * the clock forward never touches anyone else's rows.
 */
/** `target` with some methods replaced (the Postgres repositories are classes, so a spread would drop the rest). */
function override<T extends object>(target: T, replace: Partial<T>): T {
  return new Proxy(target, {
    get(t, key) {
      if (key in replace) return replace[key as keyof T];
      const v: unknown = Reflect.get(t, key);
      return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(t) : v;
    },
  });
}
const scoped: UnitOfWork = {
  run: (fn) =>
    base.uow.run((r) =>
      fn({
        ...r,
        dataLifecycle: override(r.dataLifecycle, {
          dueDeletions: async (at, limit) =>
            (await r.dataLifecycle.dueDeletions(at, limit)).filter((d) => d.accountId === accountId),
        }),
        mailboxes: override(r.mailboxes, {
          dueForPurge: async (at, limit) =>
            (await r.mailboxes.dueForPurge(at, limit)).filter((m) => m.accountId === accountId),
        }),
      }),
    ),
};
const deps: Deps = { ...base, uow: scoped };
const meta = { requestId: "int-deletion", ip: null, userAgent: null };

afterAll(async () => {
  const users = await mgmt.listUsers();
  for (const u of users.filter((x) => x.address.endsWith(`@${domain}`))) await mgmt.destroy("x:Account", u.id);
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  for (const id of [accountId, otherAccountId]) {
    if (id) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, id));
  }
  if (userId) await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
  const bans = (await mgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"])).filter(
    (b) => b.address === clientAddress,
  );
  if (bans.length > 0) {
    await mgmt.transport.set("x:BlockedIp", { destroy: bans.map((b) => b.id) });
    await mgmt.transport.call([["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"]]);
  }
  await pool.end();
});

/** Runs queued jobs until none is left for this subject (other suites share the queue). */
async function drain(subjectId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const open = await db
      .select({ id: schema.provisioningJob.id })
      .from(schema.provisioningJob)
      .where(
        and(
          eq(schema.provisioningJob.subjectId, subjectId),
          sql`${schema.provisioningJob.status} in ('queued', 'running')`,
        ),
      );
    if (open.length === 0) return;
    if (!(await runNextJob(base, mail))) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jobs for ${subjectId} did not finish`);
}

const sessionStatus = async () =>
  (
    await fetch(`${stalwartUrl}/jmap/session`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`,
        "X-Forwarded-For": clientAddress,
      },
    })
  ).status;

describe("data export and account deletion against the stack", () => {
  it("exports the account sealed, then deletes it: suspended at once, purged only after the grace period", async () => {
    // --- an account with an Owner, an active domain and a mailbox on the mail server; and another account
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `deletion ${tag}`, plan: "plus" })
      .returning();
    const [other] = await db
      .insert(schema.customerAccount)
      .values({ name: `other ${tag}`, plan: "plus" })
      .returning();
    if (!account || !other) throw new Error("accounts not created");
    accountId = account.id;
    otherAccountId = other.id;
    userId = randomUUID();
    await db.insert(schema.authUser).values({ id: userId, name: "Owner", email: `owner-${tag}@example.com` });
    await db.insert(schema.accountMembership).values({ accountId, userId, role: "owner" });
    const sessionId = `int-${tag}`;
    const stepUp = () =>
      db.insert(schema.authVerification).values({
        id: randomUUID(),
        identifier: `step-up-${sessionId}`,
        value: userId,
        expiresAt: new Date(now.t + 5 * 60_000),
      });
    await stepUp();
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, userId, address, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
      .returning();
    await db
      .insert(schema.mailbox)
      .values({ accountId: otherAccountId, address: otherAddress, quotaBytes: 1024, status: "provisioning" });
    if (!d || !m) throw new Error("rows not created");
    await enqueueProvisioning(base, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(base, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id);
    await drain(m.id);
    const stalwartId = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id)))[0]?.stalwartId;
    expect(stalwartId).toBeTruthy();
    await mgmt.upsertUser({
      name: "owner",
      domain,
      password: await hashPassword(password),
      resetPassword: true,
      quotaBytes: 50 * 1024 * 1024,
    });
    expect(await sessionStatus()).toBe(200);
    const owner: UserActor = {
      kind: "user",
      userId,
      email: `owner-${tag}@example.com`,
      platformRoles: [],
      memberships: [{ accountId, role: "owner" }],
      suspended: false,
    };

    // --- export: built, sealed (not a ZIP at rest), opened for the requester only, this account's data only
    const ring = createKeyRing([{ id: "int", key: randomBytes(32) }]);
    const archiver = sealedArchiver(ring);
    const requested = await requestExport(deps, owner, { kind: "account", accountId }, meta);
    for (let i = 0; i < 10; i++) {
      const built = await buildNextExport(base, archiver);
      if (built === null || (typeof built === "object" && built.exportId === requested.id)) break;
    }
    const [row] = await db.select().from(schema.dataExport).where(eq(schema.dataExport.id, requested.id));
    expect(row?.status).toBe("ready");
    expect(
      Buffer.from(row?.archive ?? new Uint8Array())
        .subarray(0, 2)
        .toString(),
    ).toBe("v1");
    expect(Buffer.from(row?.archive ?? new Uint8Array()).includes(Buffer.from(address))).toBe(false);
    const got = await downloadExport(
      deps,
      archiver,
      owner,
      { kind: "account", accountId },
      requested.id,
      { sessionId },
      meta,
    );
    const files = readZip(Buffer.from(got.bytes));
    const all = files.map((f) => f.data.toString("utf8")).join("\n");
    expect(files.map((f) => f.name)).toContain("audit-log.csv");
    expect(all).toContain(address);
    expect(all).toContain(domain);
    expect(all).not.toContain(otherAddress);
    // Another key ring can't open it.
    await expect(
      sealedArchiver(createKeyRing([{ id: "int", key: randomBytes(32) }])).open(
        requested.id,
        row?.archive ?? new Uint8Array(),
      ),
    ).rejects.toThrow();

    // --- deletion: mailbox suspended on the mail server at once; cancel brings it back; ask again
    await requestAccountDeletion(deps, owner, accountId, { confirmName: account.name }, { sessionId }, meta);
    await drain(m.id);
    expect((await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id)))[0]?.status).toBe("suspended");
    expect(await sessionStatus()).toBe(403);
    await cancelAccountDeletion(deps, owner, accountId, meta);
    await drain(m.id);
    expect(await sessionStatus()).toBe(200);
    await requestAccountDeletion(deps, owner, accountId, { confirmName: account.name }, { sessionId }, meta);
    await drain(m.id);
    expect(await sessionStatus()).toBe(403);

    // --- during the grace period nothing is removed
    now.t += (ACCOUNT_DELETION_GRACE_DAYS * 86_400_000) / 2;
    expect(await runDueDeletions(deps)).toEqual([]);
    expect(await purgeDueMailboxes(deps, mail)).toEqual({ purged: 0, failed: 0, held: 0 });
    expect(await mgmt.getUser(stalwartId ?? "")).toBeDefined();

    // --- after it: start (mailbox deleting) → purge (mail-server account gone) → domain released → account deleted
    now.t += ACCOUNT_DELETION_GRACE_DAYS * 86_400_000;
    expect((await runDueDeletions(deps)).map((s) => s.step)).toEqual(["started"]);
    await drain(m.id);
    expect(await purgeDueMailboxes(deps, mail)).toEqual({ purged: 1, failed: 0, held: 0 });
    expect((await mgmt.listUsers()).some((u) => u.address === address)).toBe(false);
    expect((await runDueDeletions(deps)).map((s) => s.step)).toEqual(["releasing_domains"]);
    await drain(d.id);
    expect((await mgmt.listDomains()).some((x) => x.name === domain)).toBe(false);
    const done = await runDueDeletions(deps);
    expect(done.map((s) => s.step)).toEqual(["deleted"]);
    expect(await db.select().from(schema.customerAccount).where(eq(schema.customerAccount.id, accountId))).toEqual([]);
    // The other account, the login and the audit log stay.
    expect(
      await db.select().from(schema.customerAccount).where(eq(schema.customerAccount.id, otherAccountId)),
    ).toHaveLength(1);
    expect(await db.select().from(schema.authUser).where(eq(schema.authUser.id, userId))).toHaveLength(1);
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.scope, `account:${accountId}`));
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "data.export_requested",
        "data.export_ready",
        "data.export_downloaded",
        "data.deletion_requested",
        "data.deletion_cancelled",
        "data.deletion_started",
        "platform.mailbox_purged",
        "domain.removed",
        "account.deleted",
      ]),
    );
    expect(await runDueDeletions(deps)).toEqual([]);
  });
});
