// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Phase 1 exit check: provisioning a domain + mailbox + alias from jobs works against the real Stalwart and
 * Postgres (compose stack), and the reconciler sees no drift for them. Cleans up everything it creates.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { systemClock } from "@anhourmail/core";
import { enqueueProvisioning, reconcile, runNextJob } from "@anhourmail/core/provisioning";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

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

const tag = randomUUID().slice(0, 8);
const domain = `prov-${tag}.test`;
const address = `owner@${domain}`;
const alias = `hello@${domain}`;
let accountId = "";

afterAll(async () => {
  const users = await mgmt.listUsers();
  for (const u of users.filter((x) => x.address.endsWith(`@${domain}`))) await mgmt.destroy("x:Account", u.id);
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  await pool.end();
});

describe("provisioning against Stalwart", () => {
  it("applies domain + mailbox + alias from jobs and reconciles cleanly", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `prov ${tag}` })
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
    // Drain only our jobs: other suites share the test database.
    for (let i = 0; i < 20; i++) {
      const [domainRow] = await db.select().from(schema.customerDomain).where(eq(schema.customerDomain.id, d.id));
      const [mailboxRow] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id));
      if (domainRow?.stalwartId && mailboxRow?.status === "active") break;
      const job = await runNextJob(deps, mail);
      if (!job) await new Promise((r) => setTimeout(r, 100));
    }

    const [domainRow] = await db.select().from(schema.customerDomain).where(eq(schema.customerDomain.id, d.id));
    const [mailboxRow] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id));
    expect(domainRow?.stalwartId).toBeTruthy();
    expect(mailboxRow).toMatchObject({ status: "active", lastError: null });
    expect(mailboxRow?.stalwartId).toBeTruthy();

    const onServer = (await mgmt.listUsers()).find((u) => u.address === address);
    expect(onServer).toMatchObject({ quotaBytes: 50 * 1024 * 1024 });
    expect(onServer?.aliases).toContain(alias);

    // Re-running is idempotent.
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await runNextJob(deps, mail);
    expect((await mgmt.listUsers()).filter((u) => u.address === address)).toHaveLength(1);

    const report = await reconcile(deps, mail);
    expect(report.missingOnMailServer.domains).not.toContain(domain);
    expect(report.missingOnMailServer.mailboxes).not.toContain(address);
    expect(report.unknownOnMailServer.mailboxes).not.toContain(address);
    expect(report.quotaMismatch.map((q) => q.address)).not.toContain(address);
  });
});
