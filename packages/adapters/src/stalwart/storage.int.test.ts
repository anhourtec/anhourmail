// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox storage used, end to end against the dev Stalwart: a message stored in a mailbox shows up as storage used
 * after `measureStorage` reads it with the real provisioning key (`x:Account/get` name + `usedDiskQuota`), and a
 * quota above the plan is capped through the provisioning queue without going below the mail it holds.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { systemClock } from "@anhourmail/core";
import { rebalanceStoragePools, GB, measureStorage } from "@anhourmail/core/mailboxes";
import { runNextJob } from "@anhourmail/core/provisioning";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartMailboxUsage, stalwartMailServer } from ".";
import { issueTestKeys } from "./int-keys";

const dbUrl = process.env.TEST_DATABASE_URL;
const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!dbUrl || !stalwartUrl || !admin || !adminPassword) {
  throw new Error("integration tests need TEST_DATABASE_URL, STALWART_URL and the dev Stalwart admin");
}

const { db, pool } = createDb(dbUrl);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const adminMgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const domain = `storage-${tag}.test`;
const keys = await issueTestKeys(adminMgmt, stalwartUrl, `svc-st-${tag}.test`);
let accountId = "";

afterAll(async () => {
  for (const u of (await adminMgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await adminMgmt.destroy("x:Account", u.id);
  }
  const d = (await adminMgmt.listDomains()).find((x) => x.name === domain);
  if (d) await adminMgmt.destroyDomain(d.id);
  await keys.cleanup();
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  await pool.end();
});

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";

/** Stores one message in the account's inbox (the dev admin imports it; the code under test never reads mail). */
async function storeMessage(stalwartId: string, address: string): Promise<void> {
  const body = `From: a@${domain}\r\nTo: ${address}\r\nSubject: size\r\n\r\n${"x".repeat(20_000)}\r\n`;
  const blobId = await adminMgmt.transport.uploadBlob(stalwartId, "message/rfc822", body);
  const boxes = await adminMgmt.transport.rawCall(
    [CORE, MAIL],
    [["Mailbox/get", { accountId: stalwartId, properties: ["role"] }, "m"]],
  );
  const inbox = ((boxes.get("m")?.list ?? []) as { id: string; role?: string }[]).find((b) => b.role === "inbox");
  await adminMgmt.transport.rawCall(
    [CORE, MAIL],
    [
      [
        "Email/import",
        { accountId: stalwartId, emails: { e: { blobId, mailboxIds: { [inbox?.id ?? ""]: true } } } },
        "i",
      ],
    ],
  );
}

const row = async (id: string) => (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, id)))[0];

describe("mailbox storage used against Stalwart", () => {
  it("measures a stored message with the provisioning key, and caps a quota above the plan", async () => {
    await adminMgmt.upsertDomain({ name: domain });
    const address = `owner@${domain}`;
    const stalwartId = await adminMgmt.upsertUser({
      name: "owner",
      domain,
      password: await hashPassword(randomUUID()),
      quotaBytes: 30 * GB,
    });
    await storeMessage(stalwartId, address);

    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `storage ${tag}`, plan: "free" })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, address, quotaBytes: 30 * GB, status: "active", stalwartId })
      .returning();
    if (!m) throw new Error("mailbox not created");
    expect(await row(m.id)).toMatchObject({ storageUsedBytes: null, storageCheckedAt: null });

    // The scheduler job's work, with the real provisioning key: the message's size is now on our row.
    const reader = stalwartMailboxUsage(keys.provisioning);
    const run = await measureStorage(deps, reader);
    expect(run.failedBatches).toBe(0);
    const measured = await row(m.id);
    expect(measured?.storageUsedBytes).toBeGreaterThan(20_000);
    expect(measured?.storageCheckedAt).toBeInstanceOf(Date);

    // An unreachable mail server keeps the last good value.
    const down = stalwartMailboxUsage(
      new StalwartManagement(
        new StalwartTransport({ baseUrl: "http://127.0.0.1:9", auth: { type: "bearer", token: "x" } }),
      ),
    );
    expect((await measureStorage(deps, down)).failedBatches).toBeGreaterThan(0);
    expect((await row(m.id))?.storageUsedBytes).toBe(measured?.storageUsedBytes);

    // Free's pool is 1 GB: the 30 GB quota comes down (it holds far less), and the worker applies it.
    await rebalanceStoragePools(deps, reader);
    expect((await row(m.id))?.quotaBytes).toBe(1 * GB);
    const mail = stalwartMailServer(keys.provisioning);
    for (let i = 0; i < 20 && (await runNextJob(deps, mail)); i++);
    const onServer = (await adminMgmt.listUsers()).find((u) => u.address === address);
    expect(onServer?.quotaBytes).toBe(1 * GB);
  });
});
