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
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";

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
    ["userAdmin", { account: "user_admin" }],
  ];
  const addLogin = async (key: string): Promise<{ id: string; email: string }> => {
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
    return { id, email };
  };
  for (const [key, roles] of people) {
    const { id, email } = await addLogin(key);
    if (roles.platform) await db.insert(schema.platformRoleAssignment).values({ userId: id, role: roles.platform });
    if (roles.account) {
      await db.insert(schema.accountMembership).values({ accountId: account.id, userId: id, role: roles.account });
    }
    users[key] = email;
  }
  // Sign-in security journeys change people's sign-in factors and an account's requirement, so each browser project
  // gets its own logins and its own account: nobody else's sign-in changes.
  const security: Record<
    string,
    { totp: string; passkey: string; owner: string; member: string; pkOwner: string; pkMember: string }
  > = {};
  const passwords: Record<string, { owner: string; member: string }> = {};
  for (const project of ["desktop", "mobile"]) {
    const [secAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Security ${project}`, plan: "plus" })
      .returning();
    if (!secAccount) throw new Error("security account not created");
    const logins = {
      totp: await addLogin(`sec-${project}-totp`),
      passkey: await addLogin(`sec-${project}-passkey`),
      owner: await addLogin(`sec-${project}-owner`),
      member: await addLogin(`sec-${project}-member`),
    };
    await db.insert(schema.accountMembership).values([
      { accountId: secAccount.id, userId: logins.owner.id, role: "owner" },
      { accountId: secAccount.id, userId: logins.member.id, role: "member" },
    ]);
    // A second account per project: its member signs in only with a passkey once the owner requires a second step.
    const [pkAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Passkeys ${project}`, plan: "plus" })
      .returning();
    if (!pkAccount) throw new Error("passkey account not created");
    const pkOwner = await addLogin(`sec-${project}-pk-owner`);
    const pkMember = await addLogin(`sec-${project}-pk-member`);
    await db.insert(schema.accountMembership).values([
      { accountId: pkAccount.id, userId: pkOwner.id, role: "owner" },
      { accountId: pkAccount.id, userId: pkMember.id, role: "member" },
    ]);
    // Mailbox passwords journey: its own account per project, so its mailbox doesn't count against the shared
    // account's mailbox ceiling.
    const [pwAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Passwords ${project}`, plan: "plus" })
      .returning();
    if (!pwAccount) throw new Error("passwords account not created");
    const pwOwner = await addLogin(`pw-${project}-owner`);
    const pwMember = await addLogin(`pw-${project}-member`);
    await db.insert(schema.accountMembership).values([
      { accountId: pwAccount.id, userId: pwOwner.id, role: "owner" },
      { accountId: pwAccount.id, userId: pwMember.id, role: "member" },
    ]);
    passwords[project] = { owner: pwOwner.email, member: pwMember.email };
    security[project] = {
      totp: logins.totp.email,
      passkey: logins.passkey.email,
      owner: logins.owner.email,
      member: logins.member.email,
      pkOwner: pkOwner.email,
      pkMember: pkMember.email,
    };
  }
  // A mailbox of the run's own for webmail journeys that send and receive. Stalwart throttles mail per sender domain
  // and recipient (25 an hour by default, rule 27 — left as is), so sending to a shared demo mailbox runs out after
  // a few runs; a fresh recipient on a fresh domain gets a fresh allowance. Created on the mail server and in the
  // control plane (active, so the webmail's access gate admits it); `delete` removes both (names carry the run id).
  const recipientDomain = `${run}.test`;
  const recipient = { address: `inbox@${recipientDomain}`, password: `${randomBytes(12).toString("base64url")}-E2e` };
  const mgmt = stalwartDevAdmin();
  const domainStalwartId = await mgmt.upsertDomain({ name: recipientDomain });
  const userStalwartId = await mgmt.upsertUser({
    name: "inbox",
    domain: recipientDomain,
    password: await hashPassword(recipient.password),
    quotaBytes: 50 * 1024 * 1024,
  });
  await db.insert(schema.customerDomain).values({
    accountId: account.id,
    name: recipientDomain,
    status: "active",
    verifyToken: run,
    stalwartId: domainStalwartId,
  });
  await db.insert(schema.mailbox).values({
    accountId: account.id,
    address: recipient.address,
    stalwartId: userStalwartId,
    status: "active",
    quotaBytes: 50 * 1024 * 1024,
  });
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    FILE,
    JSON.stringify({ run, password, accountName: account.name, users, recipient, security, passwords }, null, 2),
    {
      mode: 0o600,
    },
  );
} else if (mode === "delete") {
  const { run } = JSON.parse(readFileSync(FILE, "utf8")) as { run: string };
  // Cleanup matches names by run id; refuse anything that isn't one, so a bad file can't match everything.
  if (!/^e2e-[0-9a-f]{8}$/.test(run)) throw new Error(`refusing cleanup: unexpected run id ${JSON.stringify(run)}`);
  await db.delete(schema.authUser).where(like(schema.authUser.email, `${run}-%`));
  await db.delete(schema.customerAccount).where(like(schema.customerAccount.name, `${run}%`));
  // Domains and mailboxes the run created on the dev mail server (their names carry the run id).
  try {
    const mgmt = stalwartDevAdmin();
    const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
    for (const u of await mgmt.listUsers()) {
      // Free platform addresses the run claimed are `<run>-…@<platform domain>`.
      if (domainOf(u.address).includes(run) || u.address.startsWith(`${run}-`)) await mgmt.destroy("x:Account", u.id);
    }
    for (const d of await mgmt.listDomains()) if (d.name.includes(run)) await mgmt.destroyDomain(d.id);
    // Tests that fail sign-in on purpose come from 203.0.113.0/24 (RFC 5737, never a real client); lift any ban
    // the mail server put on those addresses so a later run picking the same one isn't refused.
    const bans = (await mgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"])).filter(
      (b) => /^203\.0\.113\.\d+$/.test(b.address),
    );
    if (bans.length > 0) {
      await mgmt.transport.set("x:BlockedIp", { destroy: bans.map((b) => b.id) });
      await mgmt.transport.call([["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"]]);
    }
  } catch (err) {
    console.warn(`e2e cleanup: mail server not cleaned (${err instanceof Error ? err.message : String(err)})`);
  }
  rmSync(FILE, { force: true });
} else {
  throw new Error("usage: e2e-fixtures.ts create|delete");
}
await pool.end();
