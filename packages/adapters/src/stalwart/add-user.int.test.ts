// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "Add a user" end to end: `addUser` writes the mailbox, the console login, the membership and the flags in Postgres;
 * the provisioning job creates the account on the real Stalwart (compose stack) with the person's name (the mailbox's
 * sender name, which it follows) as its description, and the generated password signs in to the mailbox, whose sending identity carries the name.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { addUser } from "@anhourmail/core/mailboxes";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { hashPassword, mailboxPasswordHasher, verifyPassword } from "../auth/password";
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
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const mail = stalwartMailServer(mgmt);
const system: Actor = { kind: "system", name: "add-user-int-test" };
const meta = { requestId: "int-add-user", ip: null, userAgent: null };

const tag = randomUUID().slice(0, 8);
const domain = `adduser-${tag}.test`;
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

describe("add a user against Postgres and Stalwart", () => {
  it("creates the login, membership and mailbox, and the mailbox signs in with the sender name", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `add user ${tag}`, plan: "plus" })
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
      {
        firstName: "Jane",
        lastName: "Doe",
        displayName: "Jane Doe",
        localPart: "jane",
        domainId: d.id,
        role: "member",
        quotaGb: 1,
        profile: { jobTitle: "Editor", country: "CA" },
      },
      meta,
      mailboxPasswordHasher,
      hashPassword,
    );
    const password = added.password ?? "";
    expect(password).not.toBe("");

    // Postgres: the login (verified, argon2id credential), the flag, the details and the membership.
    const [login] = await db.select().from(schema.authUser).where(eq(schema.authUser.id, added.userId));
    expect(login).toMatchObject({ email: address, name: "Jane Doe", firstName: "Jane", emailVerified: true });
    const [cred] = await db.select().from(schema.authAccount).where(eq(schema.authAccount.userId, added.userId));
    expect(await verifyPassword({ password, hash: cred?.password ?? "" })).toBe(true);
    const [profile] = await db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, added.userId));
    expect(profile).toMatchObject({ mustChangePassword: true, jobTitle: "Editor", country: "CA" });
    const [membership] = await db
      .select()
      .from(schema.accountMembership)
      .where(eq(schema.accountMembership.userId, added.userId));
    expect(membership).toMatchObject({ accountId, role: "member" });

    // Stalwart: the account exists with the display name as its description, and the password signs in.
    await drain(added.mailbox.id);
    const [box] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, added.mailbox.id));
    // The mailbox follows the person's name (no copy stored); the mail server gets that name as its description.
    expect(box).toMatchObject({ status: "active", displayName: null, mustChangePassword: true });
    const [account0] = await mgmt.transport.getAll<{ id: string; description?: string }>(
      "x:Account",
      ["description"],
      [box?.stalwartId ?? ""],
    );
    expect(account0?.description).toBe("Jane Doe");
    const basic = `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;
    const session = await fetch(`${stalwartUrl}/jmap/session`, { headers: { Authorization: basic } });
    expect(session.status).toBe(200);
    const { primaryAccounts } = (await session.json()) as { primaryAccounts: Record<string, string> };
    const res = await fetch(`${stalwartUrl}/jmap`, {
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
    expect(body.methodResponses[0]?.[1].list?.find((i) => i.email === address)?.name).toBe("Jane Doe");
  });
});
