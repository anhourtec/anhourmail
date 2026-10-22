// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox suspend / resume, delete with a grace period, restore and the scheduled purge, end to end: core services
 * write intent, provisioning jobs apply it to the real Stalwart (compose stack), and the purge destroys the account.
 * A known password is set on the test account (hashed here, never stored) so sign-in can be checked over JMAP.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, ConflictError, systemClock } from "@anhourmail/core";
import {
  deleteMailbox,
  purgeDueMailboxes,
  restoreMailbox,
  resumeMailbox,
  suspendMailbox,
} from "@anhourmail/core/mailboxes";
import { enqueueProvisioning, reconcile, runNextJob } from "@anhourmail/core/provisioning";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

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
const deps = { uow: new PgUnitOfWork(db), clock: systemClock };
const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const mail = stalwartMailServer(mgmt);
const system: Actor = { kind: "system", name: "lifecycle-int-test" };
const meta = { requestId: "int-lifecycle", ip: null, userAgent: null };

const tag = randomUUID().slice(0, 8);
const domain = `life-${tag}.test`;
const address = `owner@${domain}`;
const alias = `hello@${domain}`;
const password = randomBytes(18).toString("base64url");
let accountId = "";

afterAll(async () => {
  const users = await mgmt.listUsers();
  for (const u of users.filter((x) => x.address.endsWith(`@${domain}`))) await mgmt.destroy("x:Account", u.id);
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  await pool.end();
});

const mailboxRow = async (id: string) => (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, id)))[0];

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
    if (!(await runNextJob(deps, mail))) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jobs for ${subjectId} did not finish`);
}

const basic = `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;
const sessionStatus = async () =>
  (await fetch(`${stalwartUrl}/jmap/session`, { headers: { Authorization: basic } })).status;

/** JMAP as the mailbox itself. */
async function jmap(calls: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${stalwartUrl}/jmap`, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/json" },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: calls }),
  });
  if (!res.ok) throw new Error(`JMAP HTTP ${String(res.status)}`);
  const body = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
  return body.methodResponses.map(([, args]) => args);
}

async function emailCount(jmapAccountId: string): Promise<number> {
  const [q] = await jmap([["Email/query", { accountId: jmapAccountId }, "q"]]);
  return (q?.ids as string[] | undefined)?.length ?? -1;
}

describe("mailbox lifecycle against Stalwart", () => {
  it("suspends and resumes (mail kept), deletes with aliases off, restores, then purges the account", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `life ${tag}` })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, address, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
      .returning();
    if (!d || !m) throw new Error("rows not created");
    await db.insert(schema.mailAlias).values({ accountId, mailboxId: m.id, address: alias, kind: "alias" });
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id);
    await drain(m.id);
    const stalwartId = (await mailboxRow(m.id))?.stalwartId ?? "";
    expect(await mailboxRow(m.id)).toMatchObject({ status: "active", lastError: null });

    // A password we know, so sign-in can be checked (the control plane itself never sets or keeps one).
    await mgmt.upsertUser({
      name: "owner",
      domain,
      password: await hashPassword(password),
      resetPassword: true,
      quotaBytes: 50 * 1024 * 1024,
      aliases: [{ name: "hello", domain, enabled: true }],
    });
    expect(await sessionStatus()).toBe(200);
    const session = (await (
      await fetch(`${stalwartUrl}/jmap/session`, { headers: { Authorization: basic } })
    ).json()) as { primaryAccounts: Record<string, string> };
    const jmapAccountId = session.primaryAccounts["urn:ietf:params:jmap:mail"] ?? "";
    const [boxes] = await jmap([["Mailbox/get", { accountId: jmapAccountId, ids: null }, "b"]]);
    const inbox = (boxes?.list as { id: string; role: string | null }[]).find((b) => b.role === "inbox");
    await jmap([
      [
        "Email/set",
        {
          accountId: jmapAccountId,
          create: {
            e: {
              mailboxIds: { [inbox?.id ?? ""]: true },
              from: [{ email: address }],
              subject: "kept through suspension",
              bodyValues: { t: { value: "x" } },
              textBody: [{ partId: "t", type: "text/plain" }],
            },
          },
        },
        "s",
      ],
    ]);
    expect(await emailCount(jmapAccountId)).toBe(1);

    // Suspend: no sign-in (403), account and mail kept, aliases kept.
    await suspendMailbox(deps, system, accountId, m.id, meta);
    await drain(m.id);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "suspended", lastError: null });
    expect(await mgmt.getUser(stalwartId)).toMatchObject({ address, suspended: true });
    expect(await sessionStatus()).toBe(403);
    expect((await mgmt.listUsers()).find((u) => u.address === address)?.aliases).toContain(alias);

    // Drift: the account is opened again behind our back (e.g. by hand); the reconciler reports it and re-queues the
    // job, which suspends it again. Nothing is deleted.
    await mgmt.upsertUser({
      name: "owner",
      domain,
      password: "unused",
      quotaBytes: 50 * 1024 * 1024,
      suspended: false,
      aliases: [{ name: "hello", domain, enabled: true }],
    });
    expect(await sessionStatus()).toBe(200);
    const drift = await reconcile(deps, mail);
    expect(drift.suspensionMismatch).toContainEqual({ address, desired: true, actual: false });
    await drain(m.id);
    expect(await mgmt.getUser(stalwartId)).toMatchObject({ suspended: true });
    expect(await sessionStatus()).toBe(403);
    expect((await reconcile(deps, mail)).suspensionMismatch.map((x) => x.address)).not.toContain(address);

    // Resume: sign-in works again and the message is still there.
    await resumeMailbox(deps, system, accountId, m.id, meta);
    await drain(m.id);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "active", lastError: null });
    expect(await mgmt.getUser(stalwartId)).toMatchObject({ suspended: false });
    expect(await sessionStatus()).toBe(200);
    expect(await emailCount(jmapAccountId)).toBe(1);

    // Delete: suspended on the server and its aliases taken off; reconciler sees no drift for it.
    await deleteMailbox(deps, system, accountId, m.id, meta);
    await drain(m.id);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "deleting", lastError: null });
    expect(await mgmt.getUser(stalwartId)).toMatchObject({ suspended: true });
    expect((await mgmt.listUsers()).find((u) => u.address === address)?.aliases).toEqual([]);
    expect(await sessionStatus()).toBe(403);
    const report = await reconcile(deps, mail);
    expect(report.missingOnMailServer.mailboxes).not.toContain(address);
    expect(report.unknownOnMailServer.mailboxes).not.toContain(address);

    // Restore: back on, aliases back, mail still there.
    await restoreMailbox(deps, system, accountId, m.id, meta);
    await drain(m.id);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "active", purgeAfter: null });
    expect((await mgmt.listUsers()).find((u) => u.address === address)?.aliases).toContain(alias);
    expect(await sessionStatus()).toBe(200);
    expect(await emailCount(jmapAccountId)).toBe(1);

    // Delete again; nothing happens before the grace period ends.
    await deleteMailbox(deps, system, accountId, m.id, meta);
    await drain(m.id);
    await purgeDueMailboxes(deps, mail);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "deleting" });
    expect(await mgmt.getUser(stalwartId)).toBeDefined();

    // Grace period over (moved into the past here): the purge destroys the account, then the rows.
    await db
      .update(schema.mailbox)
      .set({ purgeAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.mailbox.id, m.id));
    const { purged } = await purgeDueMailboxes(deps, mail);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await mgmt.getUser(stalwartId)).toBeUndefined();
    expect((await mgmt.listUsers()).some((u) => u.address === address)).toBe(false);
    expect(await mailboxRow(m.id)).toBeUndefined();
    expect(await db.select().from(schema.mailAlias).where(eq(schema.mailAlias.address, alias))).toEqual([]);
    expect(await sessionStatus()).toBe(401);
    const audit = await deps.uow.run((r) => r.audit.chain(`account:${accountId}`));
    expect(audit.map((e) => `${e.action}:${e.result}`)).toEqual([
      "mailbox.suspended:success",
      "mailbox.unsuspended:success",
      "mailbox.deletion_scheduled:success",
      "mailbox.restored:success",
      "mailbox.deletion_scheduled:success",
      "platform.mailbox_purged:success",
    ]);
  });

  it("a restore that races the purge waits for the purge's row lock, then gets 409", async () => {
    const [acct] = await db
      .insert(schema.customerAccount)
      .values({ name: `race ${tag}` })
      .returning();
    if (!acct) throw new Error("account not created");
    try {
      const purgeAfter = new Date(Date.now() + 3600_000);
      const [m] = await db
        .insert(schema.mailbox)
        .values({ accountId: acct.id, address: `race@${tag}.example`, quotaBytes: 1, status: "deleting", purgeAfter })
        .returning();
      if (!m) throw new Error("mailbox not created");
      let release = (): void => undefined;
      const gate = new Promise<void>((r) => (release = r));
      let locked = (): void => undefined;
      const holding = new Promise<void>((r) => (locked = r));
      // The purge's unit of work: deletes the due row (and holds its lock) while "talking to the mail server".
      const purge = deps.uow.run(async (r) => {
        expect(await r.mailboxes.deleteIfDue(m.id, new Date(purgeAfter.getTime() + 1))).toBe(true);
        locked();
        await gate;
      });
      await holding;
      const restore = restoreMailbox(deps, system, acct.id, m.id, meta);
      await new Promise((r) => setTimeout(r, 300));
      release();
      await purge;
      await expect(restore).rejects.toBeInstanceOf(ConflictError);
      expect(await mailboxRow(m.id)).toBeUndefined();
    } finally {
      await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, acct.id));
    }
  });
});
