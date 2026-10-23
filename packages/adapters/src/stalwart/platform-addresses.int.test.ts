// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Free platform-domain addresses end to end against the pinned dev Stalwart and the test database (ADR-0021), with the
 * real provisioning key: a Free account whose owner has confirmed their email claims `name@<platform domain>`, the
 * worker creates it with the chosen password and the webmail sign-in works; the Free allowance, global uniqueness and
 * the no-reuse rule hold in Postgres; staff create one without a password; the reconciler treats the free addresses as
 * customer mailboxes and reports anyone else on the platform domain. Each run uses its own platform domain (created on
 * the mail server first, as the deployment's bootstrap does for the real one).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, ConflictError, EmailUnverifiedError, PlanLimitError, systemClock } from "@anhourmail/core";
import {
  checkPlatformAddress,
  createMailbox,
  deleteMailbox,
  PLATFORM_DOMAIN_ID,
  purgeDueMailboxes,
  staffCreatePlatformMailbox,
} from "@anhourmail/core/mailboxes";
import { reconcile, runNextJob } from "@anhourmail/core/provisioning";
import { platformFacts } from "@anhourmail/shared/platform";
import { StalwartManagement, StalwartTransport, WEBMAIL_OAUTH_CLIENT_ID } from "@anhourmail/stalwart-client";

import { hashPassword, mailboxPasswordHasher } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartMailServer } from ".";
import { issueTestKeys } from "./int-keys";

const dbUrl = process.env.TEST_DATABASE_URL;
const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!dbUrl || !stalwartUrl || !admin || !adminPassword) {
  throw new Error("integration tests need TEST_DATABASE_URL, STALWART_URL and the dev Stalwart admin");
}

const { db, pool } = createDb(dbUrl);
const tag = randomUUID().slice(0, 8);
const platformDomain = `free-${tag}.test`;
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: platformFacts(platformDomain) };
const adminMgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const keys = await issueTestKeys(adminMgmt, stalwartUrl, `freesvc-${tag}.test`);
const mail = stalwartMailServer(keys.provisioning);
const meta = { requestId: "int-platform-addresses", ip: "198.51.100.10", userAgent: null };
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;
const accountIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  for (const u of (await adminMgmt.listUsers()).filter((x) => x.address.endsWith(`@${platformDomain}`))) {
    await adminMgmt.destroy("x:Account", u.id);
  }
  const d = (await adminMgmt.listDomains()).find((x) => x.name === platformDomain);
  if (d) await adminMgmt.destroyDomain(d.id);
  await keys.cleanup();
  if (accountIds.length > 0) {
    await db.delete(schema.customerAccount).where(inArray(schema.customerAccount.id, accountIds));
  }
  if (userIds.length > 0) await db.delete(schema.authUser).where(inArray(schema.authUser.id, userIds));
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

/** The webmail's sign-in (OAuth code flow with PKCE): true when the password signs in. */
async function signsIn(address: string, password: string): Promise<boolean> {
  const clients = await adminMgmt.transport.getAll<{
    id: string;
    clientId: string;
    redirectUris: Record<string, unknown>;
  }>("x:OAuthClient", ["clientId", "redirectUris"]);
  const redirectUri = Object.keys(clients.find((c) => c.clientId === WEBMAIL_OAUTH_CLIENT_ID)?.redirectUris ?? {})[0];
  const verifier = randomBytes(32).toString("base64url");
  const auth = (await (
    await fetch(`${stalwartUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": clientAddress },
      body: JSON.stringify({
        type: "authCode",
        accountName: address,
        accountSecret: password,
        clientId: WEBMAIL_OAUTH_CLIENT_ID,
        redirectUri,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        codeChallengeMethod: "S256",
      }),
    })
  ).json()) as { type?: string };
  return auth.type === "authenticated";
}

async function freeAccount(label: string, verified: boolean): Promise<{ accountId: string; owner: Actor }> {
  const [account] = await db
    .insert(schema.customerAccount)
    .values({ name: `free ${label} ${tag}`, plan: "free" })
    .returning();
  const id = `free-${label}-${tag}`;
  const [person] = await db
    .insert(schema.authUser)
    .values({ id, name: label, email: `${label}-${tag}@example.test`, emailVerified: verified })
    .returning();
  if (!account || !person) throw new Error("rows not created");
  accountIds.push(account.id);
  userIds.push(person.id);
  await db.insert(schema.accountMembership).values({ accountId: account.id, userId: person.id, role: "owner" });
  return {
    accountId: account.id,
    owner: {
      kind: "user",
      userId: person.id,
      email: person.email,
      platformRoles: [],
      memberships: [{ accountId: account.id, role: "owner" }],
      suspended: false,
    },
  };
}

const claim = (actor: Actor, accountId: string, localPart: string, password: string) =>
  createMailbox(
    deps,
    actor,
    accountId,
    { localPart, domainId: PLATFORM_DOMAIN_ID, ownerUserId: actor.kind === "user" ? actor.userId : "", password },
    meta,
    mailboxPasswordHasher,
  );

describe("free platform addresses against Stalwart", () => {
  it("claim → worker → webmail sign-in; one per Free account; unique; never reissued; staff create; reconciled", async () => {
    // The platform (system) domain exists on the mail server, with a system account on it.
    await mail.ensureDomain(platformDomain, null);
    await adminMgmt.upsertUser({
      name: "no-reply",
      domain: platformDomain,
      password: await hashPassword(randomBytes(24).toString("base64url")),
      quotaBytes: 1024 ** 2,
    });

    const a = await freeAccount("ann", false);
    const b = await freeAccount("ben", true);
    const password = `free ${randomBytes(9).toString("base64url")}`;

    // An unconfirmed sign-in email can't claim one.
    await expect(claim(a.owner, a.accountId, "ann.free", password)).rejects.toThrow(EmailUnverifiedError);
    await db
      .update(schema.authUser)
      .set({ emailVerified: true })
      .where(eq(schema.authUser.id, `free-ann-${tag}`));

    // Claim, provision, sign in with the chosen password.
    expect((await checkPlatformAddress(deps, a.owner, a.accountId, "Ann.Free")).available).toBe(true);
    const m = await claim(a.owner, a.accountId, "Ann.Free", password);
    const address = `ann.free@${platformDomain}`;
    expect(m.address).toBe(address);
    await drain(m.id);
    const row = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id)))[0];
    expect(row).toMatchObject({ status: "active", pendingPasswordHash: null });
    expect(await signsIn(address, password)).toBe(true);

    // One per Free account; the name is taken for everyone else, whatever the case.
    await expect(claim(a.owner, a.accountId, "ann.second", password)).rejects.toThrow(PlanLimitError);
    await expect(claim(b.owner, b.accountId, "ANN.FREE", password)).rejects.toThrow(ConflictError);
    expect((await checkPlatformAddress(deps, b.owner, b.accountId, "ann.free")).available).toBe(false);

    // The reconciler: the free address is a customer mailbox, the system account is expected; anyone else is drift.
    const ignoreDomains = [platformDomain];
    const clean = await reconcile(deps, mail, { ignoreDomains });
    expect(clean.unknownOnMailServer.mailboxes.filter((x) => x.endsWith(`@${platformDomain}`))).toEqual([]);
    expect(clean.unknownOnMailServer.domains).not.toContain(platformDomain);
    await adminMgmt.upsertUser({
      name: "squatter",
      domain: platformDomain,
      password: await hashPassword(randomBytes(24).toString("base64url")),
      quotaBytes: 1024 ** 2,
    });
    const drift = await reconcile(deps, mail, { ignoreDomains });
    expect(drift.unknownOnMailServer.mailboxes).toContain(`squatter@${platformDomain}`);

    // Deleted and purged: retired for good. Another account can't have it; the account that held it can.
    await deleteMailbox(deps, a.owner, a.accountId, m.id, meta);
    await drain(m.id);
    await db
      .update(schema.mailbox)
      .set({ purgeAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.mailbox.id, m.id));
    expect((await purgeDueMailboxes(deps, mail)).purged).toBeGreaterThanOrEqual(1);
    const retired = await db
      .select()
      .from(schema.retiredPlatformAddress)
      .where(eq(schema.retiredPlatformAddress.address, address));
    expect(retired).toMatchObject([{ accountId: a.accountId }]);
    await expect(claim(b.owner, b.accountId, "ann.free", password)).rejects.toThrow(ConflictError);
    expect((await checkPlatformAddress(deps, a.owner, a.accountId, "ann.free")).available).toBe(true);

    // Staff create one in account B: no password waiting; audited as staff in B's own log.
    const staff: Actor = {
      kind: "user",
      userId: `staff-${tag}`,
      email: `staff-${tag}@anhourtec.test`,
      platformRoles: ["global_admin"],
      memberships: [],
      suspended: false,
    };
    const s = await staffCreatePlatformMailbox(deps, staff, b.accountId, { localPart: "ben.staff" }, meta);
    const staffRow = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, s.id)))[0];
    expect(staffRow?.pendingPasswordHash).toBeNull();
    await drain(s.id);
    expect((await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, s.id)))[0]?.status).toBe("active");
    const log = await deps.uow.run((r) => r.audit.chain(`account:${b.accountId}`));
    expect(log.at(-1)).toMatchObject({
      action: "mailbox.created",
      result: "success",
      actor: { type: "staff" },
      ip: "198.51.100.10",
    });
  });
});
