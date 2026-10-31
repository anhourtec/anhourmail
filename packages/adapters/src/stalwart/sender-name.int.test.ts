// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Names as one source (rule 61; core `people/names.ts`) against Postgres and the real dev Stalwart (`npm run
 * test:int`): "Add a user" gives the mailbox its person's name as its sender name; a Profile edit reaches the mail
 * server's account description through the worker's job; an admin's custom display name wins, and clearing it goes
 * back to the person's name. Stalwart names new identities after the description but doesn't rename ones that exist
 * (verified here) — the webmail renames those (`apps/web/.../sender-name.int.test.ts`). A throwaway domain per run.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { addUser, renameMailbox } from "@anhourmail/core/mailboxes";
import { updatePersonProfile } from "@anhourmail/core/people";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword, mailboxPasswordHasher } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartMailServer } from ".";

const dbUrl = process.env.TEST_DATABASE_URL;
const STALWART_URL = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!dbUrl || !STALWART_URL || !admin || !adminPassword) {
  throw new Error("integration tests need TEST_DATABASE_URL, STALWART_URL and the dev Stalwart admin");
}

const { db, pool } = createDb(dbUrl);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: STALWART_URL, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const mail = stalwartMailServer(mgmt);
const system: Actor = { kind: "system", name: "sender-name-int-test" };
const req = { requestId: "int-sender-name", ip: null, userAgent: "vitest" };

const tag = randomUUID().slice(0, 8);
const domain = `names-${tag}.test`;
const address = `jane@${domain}`;
let accountId = "";

afterAll(async () => {
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  await db.delete(schema.authUser).where(eq(schema.authUser.email, address));
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  await pool.end();
});

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

async function description(stalwartId: string): Promise<string | undefined> {
  const [a] = await mgmt.transport.getAll<{ id: string; description?: string }>(
    "x:Account",
    ["description"],
    [stalwartId],
  );
  return a?.description;
}

/** The identity names as the mail server has them, read with the mailbox's own password (what other apps see). */
async function serverNames(password: string): Promise<Record<string, string>> {
  const basic = `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;
  const session = await fetch(`${STALWART_URL}/jmap/session`, { headers: { Authorization: basic } });
  const { primaryAccounts } = (await session.json()) as { primaryAccounts: Record<string, string> };
  const res = await fetch(`${STALWART_URL}/jmap`, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:submission"],
      methodCalls: [
        ["Identity/get", { accountId: primaryAccounts["urn:ietf:params:jmap:submission"], ids: null }, "i"],
      ],
    }),
  });
  const body = (await res.json()) as { methodResponses: [string, { list?: { name: string; email: string }[] }][] };
  return Object.fromEntries((body.methodResponses[0]?.[1].list ?? []).map((i) => [i.email, i.name]));
}

describe("names as one source on Postgres and Stalwart", () => {
  it("follows the person's name to the mail server's description, and a custom name wins", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `names ${tag}`, plan: "plus" })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    if (!d) throw new Error("domain not created");
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await drain(d.id);

    const added = await addUser(
      deps,
      system,
      accountId,
      { firstName: "Jane", lastName: "Doe", displayName: "Jane Doe", localPart: "jane", domainId: d.id, quotaGb: 1 },
      req,
      mailboxPasswordHasher,
      hashPassword,
    );
    const password = added.password ?? "";
    await drain(added.mailbox.id);
    const [row] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, added.mailbox.id));
    const stalwartId = row?.stalwartId ?? "";
    // The mailbox follows its person (no copy of the name), and the mail server has that name.
    expect(row?.displayName).toBeNull();
    expect(await description(stalwartId)).toBe("Jane Doe");
    expect((await serverNames(password))[address]).toBe("Jane Doe");

    // Console Profile (an admin here): the worker writes the new description; the existing identity keeps its name.
    await updatePersonProfile(deps, system, accountId, added.userId, { name: "Jane Q. Doe" }, req);
    await drain(added.mailbox.id);
    expect(await description(stalwartId)).toBe("Jane Q. Doe");
    expect((await serverNames(password))[address]).toBe("Jane Doe");

    // An admin's custom display name wins; clearing it ("Use the person's name") goes back to the person's.
    await renameMailbox(deps, system, accountId, added.mailbox.id, { displayName: "Jane at the desk" }, req);
    await drain(added.mailbox.id);
    expect(await description(stalwartId)).toBe("Jane at the desk");
    await renameMailbox(deps, system, accountId, added.mailbox.id, { displayName: "" }, req);
    await drain(added.mailbox.id);
    expect(await description(stalwartId)).toBe("Jane Q. Doe");
    const [person] = await db.select().from(schema.authUser).where(eq(schema.authUser.id, added.userId));
    expect(person?.name).toBe("Jane Q. Doe");
  });
});
