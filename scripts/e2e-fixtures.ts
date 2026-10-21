// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Throwaway users for the Playwright e2e suite (tests/e2e). `create` writes test-results/e2e-users.json
 * (gitignored), `delete` removes them. Never touches seeded demo data.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

import { like } from "drizzle-orm";

import { hashPassword } from "@anhourmail/adapters/auth";
import { createDb, schema } from "@anhourmail/adapters/postgres";
import { stalwart } from "@anhourmail/stalwart-client";

const FILE = "test-results/e2e-users.json";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, pool } = createDb(url);
const mode = process.argv[2];

if (mode === "create") {
  const run = `e2e-${randomBytes(4).toString("hex")}`;
  const password = `${randomBytes(12).toString("base64url")}-E2e`;
  const [account] = await db
    .insert(schema.customerAccount)
    .values({ name: `${run} Family`, plan: "plus" })
    .returning();
  if (!account) throw new Error("account not created");
  const users: Record<string, string> = {};
  const people: [string, { platform?: string; account?: string }][] = [
    ["globalAdmin", { platform: "global_admin" }],
    ["reportsReader", { platform: "reports_reader" }],
    ["owner", { account: "owner" }],
    ["member", { account: "member" }],
  ];
  for (const [key, roles] of people) {
    const id = randomUUID();
    const email = `${run}-${key.toLowerCase()}@e2e.test`;
    await db.insert(schema.authUser).values({ id, name: key, email, emailVerified: true });
    await db.insert(schema.authAccount).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashPassword(password),
    });
    if (roles.platform) await db.insert(schema.platformRoleAssignment).values({ userId: id, role: roles.platform });
    if (roles.account) {
      await db.insert(schema.accountMembership).values({ accountId: account.id, userId: id, role: roles.account });
    }
    users[key] = email;
  }
  mkdirSync("test-results", { recursive: true });
  writeFileSync(FILE, JSON.stringify({ run, password, accountName: account.name, users }, null, 2), { mode: 0o600 });
} else if (mode === "delete") {
  const { run } = JSON.parse(readFileSync(FILE, "utf8")) as { run: string };
  // Cleanup matches names by run id; refuse anything that isn't one, so a bad file can't match everything.
  if (!/^e2e-[0-9a-f]{8}$/.test(run)) throw new Error(`refusing cleanup: unexpected run id ${JSON.stringify(run)}`);
  await db.delete(schema.authUser).where(like(schema.authUser.email, `${run}-%`));
  await db.delete(schema.customerAccount).where(like(schema.customerAccount.name, `${run}%`));
  // The site spec joins the waitlist with e2e-<timestamp>@waitlist.test addresses.
  await db.delete(schema.waitlistEntry).where(like(schema.waitlistEntry.email, "e2e-%@waitlist.test"));
  await db.delete(schema.invite).where(like(schema.invite.email, "e2e-%@waitlist.test"));
  // Domains and mailboxes the run created on the dev mail server (their names carry the run id).
  try {
    const mgmt = stalwart();
    const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
    for (const u of await mgmt.listUsers()) {
      if (domainOf(u.address).includes(run)) await mgmt.destroy("x:Account", u.id);
    }
    for (const d of await mgmt.listDomains()) if (d.name.includes(run)) await mgmt.destroyDomain(d.id);
  } catch (err) {
    console.warn(`e2e cleanup: mail server not cleaned (${err instanceof Error ? err.message : String(err)})`);
  }
  rmSync(FILE, { force: true });
} else {
  throw new Error("usage: e2e-fixtures.ts create|delete");
}
await pool.end();
