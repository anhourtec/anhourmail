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
import { ALIAS_CREATIONS_PER_YEAR } from "@anhourmail/shared/plans";
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
    ["supportAdmin", { platform: "support_admin" }],
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
    {
      totp: string;
      passkey: string;
      owner: string;
      member: string;
      pkOwner: string;
      pkMember: string;
      admin: string;
      adminAccount: string;
    }
  > = {};
  const passwords: Record<string, { owner: string; member: string }> = {};
  const mailboxes: Record<string, { owner: string; member: string }> = {};
  const suspension: Record<string, { accountName: string; owner: string; member: string }> = {};
  const firstSignIn: Record<string, { owner: string; domain: string }> = {};
  const avatars: Record<string, { person: string; mailbox: string; mailboxPassword: string }> = {};
  const names: Record<string, { person: string; mailbox: string; mailboxPassword: string }> = {};
  const aliasLimits: Record<string, { owner: string; mailbox: string; day: string }> = {};
  const actAs: Record<string, { accountName: string; accountId: string; owner: string; member: string }> = {};
  const data: Record<string, { accountName: string; owner: string; member: string; leaver: string }> = {};
  const delegationWebmail: Record<
    string,
    { owner: string; delegate: string; mailbox: string; mailboxPassword: string; shared: string; team: string }
  > = {};
  const delegation: Record<
    string,
    { owner: string; delegate: string; colleague: string; leaver: string; domain: string; shared: string }
  > = {};
  const mgmt = stalwartDevAdmin();
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
    // Password-first sign-in and step-up (ADR-0028): a Global Administrator of this project's own who adds a passkey,
    // confirms it's them with the password, and suspends and opens (support access) an account of its own.
    const secAdmin = await addLogin(`sec-${project}-admin`);
    await db.insert(schema.platformRoleAssignment).values({ userId: secAdmin.id, role: "global_admin" });
    const [adminAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Step-up ${project}`, plan: "plus" })
      .returning();
    if (!adminAccount) throw new Error("step-up account not created");
    const adminAccountOwner = await addLogin(`sec-${project}-stepup-owner`);
    await db
      .insert(schema.accountMembership)
      .values({ accountId: adminAccount.id, userId: adminAccountOwner.id, role: "owner" });
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
    // Mailboxes journey: its own account per project, so the storage it gives its mailbox comes from a pool the other
    // journeys (both projects' shared addresses) haven't already assigned.
    const [mbxAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Mailboxes ${project}`, plan: "plus" })
      .returning();
    if (!mbxAccount) throw new Error("mailboxes account not created");
    const mbxOwner = await addLogin(`mbx-${project}-owner`);
    const mbxMember = await addLogin(`mbx-${project}-member`);
    await db.insert(schema.accountMembership).values([
      { accountId: mbxAccount.id, userId: mbxOwner.id, role: "owner" },
      { accountId: mbxAccount.id, userId: mbxMember.id, role: "member" },
    ]);
    mailboxes[project] = { owner: mbxOwner.email, member: mbxMember.email };
    // Staff suspension journey: an account per project that staff suspend and restore (nobody else's sign-in changes).
    const [suspAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Suspension ${project}`, plan: "plus" })
      .returning();
    if (!suspAccount) throw new Error("suspension account not created");
    const suspOwner = await addLogin(`susp-${project}-owner`);
    const suspMember = await addLogin(`susp-${project}-member`);
    await db.insert(schema.accountMembership).values([
      { accountId: suspAccount.id, userId: suspOwner.id, role: "owner" },
      { accountId: suspAccount.id, userId: suspMember.id, role: "member" },
    ]);
    suspension[project] = { accountName: suspAccount.name, owner: suspOwner.email, member: suspMember.email };
    // Staff support access journey (ADR-0023): an account per project that a Support Administrator opens read-only.
    const [actAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Support ${project}`, plan: "plus" })
      .returning();
    if (!actAccount) throw new Error("support access account not created");
    const actOwner = await addLogin(`act-${project}-owner`);
    const actMember = await addLogin(`act-${project}-member`);
    await db.insert(schema.accountMembership).values([
      { accountId: actAccount.id, userId: actOwner.id, role: "owner" },
      { accountId: actAccount.id, userId: actMember.id, role: "member" },
    ]);
    actAs[project] = {
      accountName: actAccount.name,
      accountId: actAccount.id,
      owner: actOwner.email,
      member: actMember.email,
    };
    // Data export and account deletion journey (ADR-0025): an account per project that its Owner schedules for deletion
    // and cancels (its Member sees the notice), and a login that is the only person in an empty account of its own,
    // which it deletes together with its login.
    const [dataAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Data ${project}`, plan: "plus" })
      .returning();
    if (!dataAccount) throw new Error("data account not created");
    const dataOwner = await addLogin(`data-${project}-owner`);
    const dataMember = await addLogin(`data-${project}-member`);
    await db.insert(schema.accountMembership).values([
      { accountId: dataAccount.id, userId: dataOwner.id, role: "owner" },
      { accountId: dataAccount.id, userId: dataMember.id, role: "member" },
    ]);
    const [leaverAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Leaver ${project}`, plan: "free" })
      .returning();
    if (!leaverAccount) throw new Error("leaver account not created");
    const leaver = await addLogin(`leaver-${project}`);
    await db.insert(schema.accountMembership).values({ accountId: leaverAccount.id, userId: leaver.id, role: "owner" });
    data[project] = {
      accountName: dataAccount.name,
      owner: dataOwner.email,
      member: dataMember.email,
      leaver: leaver.email,
    };
    // First-sign-in password change journey: an account per project with a domain already verified (on the mail
    // server and active here), where its Owner adds a user who must choose their own password.
    const [fsAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} First sign-in ${project}`, plan: "plus" })
      .returning();
    if (!fsAccount) throw new Error("first sign-in account not created");
    const fsOwner = await addLogin(`fs-${project}-owner`);
    await db.insert(schema.accountMembership).values({ accountId: fsAccount.id, userId: fsOwner.id, role: "owner" });
    const fsDomain = `${run}-fs-${project}.test`;
    await db.insert(schema.customerDomain).values({
      accountId: fsAccount.id,
      name: fsDomain,
      status: "active",
      verifyToken: `${run}-fs-${project}`,
      stalwartId: await mgmt.upsertDomain({ name: fsDomain }),
    });
    firstSignIn[project] = { owner: fsOwner.email, domain: fsDomain };
    // Profile photos journey: a person (Owner of their own account) with a mailbox of their own on the mail server, so
    // a photo set in the console shows in that mailbox's webmail and back (rule 61).
    const [avAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Photos ${project}`, plan: "plus" })
      .returning();
    if (!avAccount) throw new Error("photos account not created");
    const avPerson = await addLogin(`av-${project}-person`);
    await db.insert(schema.accountMembership).values({ accountId: avAccount.id, userId: avPerson.id, role: "owner" });
    const avDomain = `${run}-av-${project}.test`;
    const avPassword = `${randomBytes(12).toString("base64url")}-E2e`;
    await db.insert(schema.customerDomain).values({
      accountId: avAccount.id,
      name: avDomain,
      status: "active",
      verifyToken: `${run}-av-${project}`,
      stalwartId: await mgmt.upsertDomain({ name: avDomain }),
    });
    await db.insert(schema.mailbox).values({
      accountId: avAccount.id,
      userId: avPerson.id,
      address: `me@${avDomain}`,
      stalwartId: await mgmt.upsertUser({
        name: "me",
        domain: avDomain,
        password: await hashPassword(avPassword),
        quotaBytes: 50 * 1024 * 1024,
        suspended: false,
      }),
      status: "active",
      quotaBytes: 50 * 1024 * 1024,
    });
    avatars[project] = { person: avPerson.email, mailbox: `me@${avDomain}`, mailboxPassword: avPassword };
    // Names journey (rule 61): a person (Owner of their own account) whose own mailbox follows their name, so a name
    // changed on the console Profile shows as the webmail's sender name and back.
    const [nmAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Names ${project}`, plan: "plus" })
      .returning();
    if (!nmAccount) throw new Error("names account not created");
    const nmPerson = await addLogin(`nm-${project}-person`);
    await db.insert(schema.accountMembership).values({ accountId: nmAccount.id, userId: nmPerson.id, role: "owner" });
    const nmDomain = `${run}-nm-${project}.test`;
    const nmPassword = `${randomBytes(12).toString("base64url")}-E2e`;
    await db.insert(schema.customerDomain).values({
      accountId: nmAccount.id,
      name: nmDomain,
      status: "active",
      verifyToken: `${run}-nm-${project}`,
      stalwartId: await mgmt.upsertDomain({ name: nmDomain }),
    });
    await db.insert(schema.mailbox).values({
      accountId: nmAccount.id,
      userId: nmPerson.id,
      address: `me@${nmDomain}`,
      stalwartId: await mgmt.upsertUser({
        name: "me",
        domain: nmDomain,
        password: await hashPassword(nmPassword),
        quotaBytes: 50 * 1024 * 1024,
        description: `nm-${project}-person`,
        suspended: false,
      }),
      status: "active",
      quotaBytes: 50 * 1024 * 1024,
    });
    names[project] = { person: nmPerson.email, mailbox: `me@${nmDomain}`, mailboxPassword: nmPassword };
    // Delegation journey (ADR-0026): a Plus account with a verified domain and mailboxes on the mail server — a shared
    // mailbox (nobody's), a colleague's mailbox to convert to shared and a leaver's mailbox to hand over on removal —
    // and the person who gets access (the delegate).
    const [dlAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Delegation ${project}`, plan: "plus" })
      .returning();
    if (!dlAccount) throw new Error("delegation account not created");
    const dl = {
      owner: await addLogin(`dl-${project}-owner`),
      delegate: await addLogin(`dl-${project}-delegate`),
      colleague: await addLogin(`dl-${project}-colleague`),
      leaver: await addLogin(`dl-${project}-leaver`),
    };
    await db.insert(schema.accountMembership).values([
      { accountId: dlAccount.id, userId: dl.owner.id, role: "owner" },
      { accountId: dlAccount.id, userId: dl.delegate.id, role: "member" },
      { accountId: dlAccount.id, userId: dl.colleague.id, role: "member" },
      { accountId: dlAccount.id, userId: dl.leaver.id, role: "member" },
    ]);
    const dlDomain = `${run}-dl-${project}.test`;
    await db.insert(schema.customerDomain).values({
      accountId: dlAccount.id,
      name: dlDomain,
      status: "active",
      verifyToken: `${run}-dl-${project}`,
      stalwartId: await mgmt.upsertDomain({ name: dlDomain }),
    });
    for (const [name, userId] of [
      ["desk", null],
      ["colleague", dl.colleague.id],
      ["leaver", dl.leaver.id],
    ] as const) {
      const stalwartId = await mgmt.upsertUser({
        name,
        domain: dlDomain,
        password: await hashPassword(`${randomBytes(12).toString("base64url")}-E2e`),
        quotaBytes: 50 * 1024 * 1024,
        suspended: false,
      });
      await db.insert(schema.mailbox).values({
        accountId: dlAccount.id,
        userId,
        address: `${name}@${dlDomain}`,
        stalwartId,
        passwordCredentialId: await mgmt.passwordCredentialId(stalwartId),
        status: "active",
        quotaBytes: 50 * 1024 * 1024,
      });
    }
    delegation[project] = {
      owner: dl.owner.email,
      delegate: dl.delegate.email,
      colleague: dl.colleague.email,
      leaver: dl.leaver.email,
      domain: dlDomain,
      shared: `desk@${dlDomain}`,
    };
    // Webmail delegation journey (ADR-0026 §6): a Plus account with a verified domain, a person (the delegate) with a
    // mailbox of their own on the mail server and its password, a shared mailbox the Owner gives them Read and manage
    // and Send as on (desk@), and one they get Send on behalf on (team@).
    const [dwAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Shared webmail ${project}`, plan: "plus" })
      .returning();
    if (!dwAccount) throw new Error("webmail delegation account not created");
    const dw = { owner: await addLogin(`dw-${project}-owner`), delegate: await addLogin(`dw-${project}-delegate`) };
    await db.insert(schema.accountMembership).values([
      { accountId: dwAccount.id, userId: dw.owner.id, role: "owner" },
      { accountId: dwAccount.id, userId: dw.delegate.id, role: "member" },
    ]);
    const dwDomain = `${run}-dw-${project}.test`;
    await db.insert(schema.customerDomain).values({
      accountId: dwAccount.id,
      name: dwDomain,
      status: "active",
      verifyToken: `${run}-dw-${project}`,
      stalwartId: await mgmt.upsertDomain({ name: dwDomain }),
    });
    const dwPassword = `${randomBytes(12).toString("base64url")}-E2e`;
    for (const [name, userId, mailboxPassword] of [
      ["me", dw.delegate.id, dwPassword],
      ["desk", null, `${randomBytes(12).toString("base64url")}-E2e`],
      ["team", null, `${randomBytes(12).toString("base64url")}-E2e`],
    ] as const) {
      const stalwartId = await mgmt.upsertUser({
        name,
        domain: dwDomain,
        password: await hashPassword(mailboxPassword),
        quotaBytes: 50 * 1024 * 1024,
        suspended: false,
      });
      await db.insert(schema.mailbox).values({
        accountId: dwAccount.id,
        userId,
        address: `${name}@${dwDomain}`,
        stalwartId,
        passwordCredentialId: await mgmt.passwordCredentialId(stalwartId),
        status: "active",
        quotaBytes: 50 * 1024 * 1024,
      });
    }
    delegationWebmail[project] = {
      owner: dw.owner.email,
      delegate: dw.delegate.email,
      mailbox: `me@${dwDomain}`,
      mailboxPassword: dwPassword,
      shared: `desk@${dwDomain}`,
      team: `team@${dwDomain}`,
    };
    // Alias limits journey: a Free account whose yearly alias and masked alias creations are used up today (counted in
    // the control plane only). Nothing is created, so its mailbox isn't on the mail server: it stays `provisioning`, so
    // the reconciler doesn't report it missing.
    const [alAccount] = await db
      .insert(schema.customerAccount)
      .values({ name: `${run} Alias limits ${project}`, plan: "free" })
      .returning();
    if (!alAccount) throw new Error("alias limits account not created");
    const alOwner = await addLogin(`al-${project}-owner`);
    await db.insert(schema.accountMembership).values({ accountId: alAccount.id, userId: alOwner.id, role: "owner" });
    const alMailbox = `me@${run}-al-${project}.test`;
    await db.insert(schema.mailbox).values({
      accountId: alAccount.id,
      userId: alOwner.id,
      address: alMailbox,
      status: "provisioning",
      quotaBytes: 50 * 1024 * 1024,
    });
    const alDay = new Date().toISOString().slice(0, 10);
    await db.insert(schema.aliasCreationDay).values([
      { accountId: alAccount.id, day: alDay, kind: "alias", count: ALIAS_CREATIONS_PER_YEAR.free.alias },
      { accountId: alAccount.id, day: alDay, kind: "masked", count: ALIAS_CREATIONS_PER_YEAR.free.masked },
    ]);
    aliasLimits[project] = { owner: alOwner.email, mailbox: alMailbox, day: alDay };
    security[project] = {
      totp: logins.totp.email,
      passkey: logins.passkey.email,
      owner: logins.owner.email,
      member: logins.member.email,
      pkOwner: pkOwner.email,
      pkMember: pkMember.email,
      admin: secAdmin.email,
      adminAccount: adminAccount.name,
    };
  }
  // A mailbox of the run's own for webmail journeys that send and receive. Stalwart throttles mail per sender domain
  // and recipient (25 an hour by default, rule 27 — left as is), so sending to a shared demo mailbox runs out after
  // a few runs; a fresh recipient on a fresh domain gets a fresh allowance. Created on the mail server and in the
  // control plane (active, so the webmail's access gate admits it); `delete` removes both (names carry the run id).
  const recipientDomain = `${run}.test`;
  const recipient = { address: `inbox@${recipientDomain}`, password: `${randomBytes(12).toString("base64url")}-E2e` };
  const domainStalwartId = await mgmt.upsertDomain({ name: recipientDomain });
  const userStalwartId = await mgmt.upsertUser({
    name: "inbox",
    domain: recipientDomain,
    password: await hashPassword(recipient.password),
    quotaBytes: 50 * 1024 * 1024,
    suspended: false,
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
    JSON.stringify(
      {
        run,
        password,
        accountName: account.name,
        users,
        recipient,
        security,
        passwords,
        mailboxes,
        suspension,
        actAs,
        firstSignIn,
        avatars,
        names,
        data,
        aliasLimits,
        delegation,
        delegationWebmail,
      },
      null,
      2,
    ),
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
