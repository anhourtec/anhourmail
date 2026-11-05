// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Staff suspension end to end (`platform.account.suspend`): a Global Administrator with a fresh step-up suspends a
 * customer account, the provisioning jobs suspend its mailbox on the real dev Stalwart (sign-in refused, so no sending
 * either), and lifting it brings the mailbox back — but never a mailbox the account had suspended itself. Then the
 * same for a person: their console sessions end, their mailbox is suspended and comes back when lifted. A webmail token
 * issued before the person suspension is refused once the mail server suspends the principal; an IMAP connection
 * already signed in is the documented v0.16.27 limitation and is pinned as such.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { liftAccountSuspension, liftPersonSuspension, suspendAccount, suspendPerson } from "@anhourmail/core/platform";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import {
  StalwartManagement,
  StalwartOAuth,
  StalwartTransport,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartMailServer } from ".";
import { imapSession } from "./int-imap";
import { smtpSession } from "./int-smtp";

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
const meta = { requestId: "int-suspension", ip: null, userAgent: null };
const oauth = new StalwartOAuth({
  baseUrl: stalwartUrl,
  clientId: WEBMAIL_OAUTH_CLIENT_ID,
  redirectUri: webmailRedirectUri(process.env.WEBMAIL_URL ?? "http://localhost:43300"),
});

const tag = randomUUID().slice(0, 8);
const domain = `susp-${tag}.test`;
const address = `member@${domain}`;
const password = randomBytes(18).toString("base64url");
const staffId = `ga-${tag}`;
const memberId = `member-${tag}`;
const staffSession = `s-ga-${tag}`;
let accountId = "";
/** Documentation-range client address for the deliberate failed sign-ins (never the shared dev forwarder). */
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;

afterAll(async () => {
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  await db.delete(schema.authUser).where(inArray(schema.authUser.id, [staffId, memberId]));
  const bans = (await mgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"])).filter(
    (b) => b.address === clientAddress,
  );
  if (bans.length > 0) {
    await mgmt.transport.set("x:BlockedIp", { destroy: bans.map((b) => b.id) });
    await mgmt.transport.call([["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"]]);
  }
  await pool.end();
});

const mailboxRow = async (id: string) => (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, id)))[0];

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

const sessionStatus = async () =>
  (
    await fetch(`${stalwartUrl}/jmap/session`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`,
        "X-Forwarded-For": clientAddress,
      },
    })
  ).status;

/** The JMAP session status for a webmail access token (what the webmail proxy sends for the signed-in user). */
const tokenStatus = async (token: string) =>
  (
    await fetch(`${stalwartUrl}/jmap/session`, {
      headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": clientAddress },
    })
  ).status;

const staff: Actor = {
  kind: "user",
  userId: staffId,
  email: `${staffId}@example.test`,
  platformRoles: ["global_admin"],
  memberships: [],
  suspended: false,
};
const session = { sessionId: staffSession };

describe("staff suspension against Stalwart", () => {
  it("suspends and lifts an account, then a person; only mailboxes the suspension stopped come back", async () => {
    await db.insert(schema.authUser).values([
      { id: staffId, name: "Staff", email: `${staffId}@example.test`, emailVerified: true },
      { id: memberId, name: "Member", email: `${memberId}@example.test`, emailVerified: true },
    ]);
    await db.insert(schema.platformRoleAssignment).values({ userId: staffId, role: "global_admin", grantedBy: "int" });
    await db.insert(schema.authVerification).values({
      id: randomUUID(),
      identifier: `step-up-${staffSession}`,
      value: staffId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await db.insert(schema.authSession).values({
      id: `s-member-${tag}`,
      token: `t-member-${tag}`,
      userId: memberId,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `susp ${tag}`, plan: "plus" })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    await db.insert(schema.accountMembership).values({ accountId, userId: memberId, role: "member" });
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, userId: memberId, address, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
      .returning();
    // Suspended by the account itself: a staff suspension must leave it that way when lifted.
    const [own] = await db
      .insert(schema.mailbox)
      .values({ accountId, address: `own@${domain}`, quotaBytes: 50 * 1024 * 1024, status: "suspended" })
      .returning();
    if (!d || !m || !own) throw new Error("rows not created");
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id);
    await drain(m.id);
    await mgmt.upsertUser({
      name: "member",
      domain,
      password: await hashPassword(password),
      resetPassword: true,
      quotaBytes: 50 * 1024 * 1024,
      aliases: [],
    });
    expect(await sessionStatus()).toBe(200);

    // Account suspension: the mailbox can't sign in (and so can't send), the account shows as suspended.
    const out = await suspendAccount(deps, staff, accountId, { reason: "spam", note: "int test" }, session, meta);
    expect(out.mailboxes).toBe(1);
    await drain(m.id);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "suspended", lastError: null });
    expect(await sessionStatus()).toBe(403);
    const [acc] = await db.select().from(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
    expect(acc).toMatchObject({ status: "suspended", suspensionReason: "spam", suspensionNote: "int test" });
    const accountLog = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.scope, `account:${accountId}`), eq(schema.auditLog.action, "trust.suspended")));
    expect(accountLog).toHaveLength(1);
    expect(JSON.stringify(accountLog)).not.toContain("int test");

    // Lift: the mailbox comes back; the one the account suspended itself stays suspended.
    await liftAccountSuspension(deps, staff, accountId, session, meta);
    await drain(m.id);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "active" });
    expect((await mailboxRow(own.id))?.status).toBe("suspended");
    expect(await sessionStatus()).toBe(200);

    // Already signed in before the person suspension: a mail app over IMAP and the webmail (its OAuth token).
    const imap = await imapSession();
    expect(await imap.run(`LOGIN "${address}" "${password}"`)).toMatch(/^t1 OK/m);
    expect(await imap.run("SELECT INBOX")).toMatch(/^t2 OK/m);
    const tokens = await oauth.signIn(address, password, clientAddress);
    expect(await tokenStatus(tokens.accessToken)).toBe(200);
    // A mail app signed in to submission (465) with the password, idle on an open connection.
    const smtp = await smtpSession();
    expect(await smtp.send("EHLO int-test")).toMatch(/^250 /m);
    const plain = Buffer.from(`\0${address}\0${password}`).toString("base64");
    expect(await smtp.send(`AUTH PLAIN ${plain}`)).toMatch(/^235 /m);

    // Person suspension: console sessions end, their mailbox is suspended; lifting restores it.
    const p = await suspendPerson(deps, staff, memberId, { reason: "abuse" }, session, meta);
    expect(p).toMatchObject({ mailboxes: 1, sessionsRevoked: 1 });
    await drain(m.id);
    expect(await sessionStatus()).toBe(403);
    // A webmail token issued before it is refused at once (403); a refresh still mints one, which is refused too —
    // the webmail BFF also ends the session itself (MailboxAccessGate, research/stalwart.md "Suspension").
    expect(await tokenStatus(tokens.accessToken)).toBe(403);
    const refreshed = await oauth.refresh(tokens.refreshToken ?? "", clientAddress);
    expect(await tokenStatus(refreshed.accessToken)).toBe(403);
    // Pinned limitation of v0.16.27 (research/stalwart.md): an IMAP connection already signed in keeps reading until
    // the client disconnects (new mail can't reach it, delivery is refused; a new IMAP sign-in is refused). If an
    // upgrade starts ending open sessions this assertion fails: update the docs and drop the limitation.
    expect(await imap.run("STATUS INBOX (MESSAGES)")).toMatch(/^t3 OK/m);
    imap.close();
    // Pinned gap of v0.16.27 (research/stalwart.md "Suspension"): the submission session signed in before the
    // suspension still has a message accepted for delivery (queued). Only to its own local address here — nothing
    // leaves the dev network. Mitigations: spam/abuse/phishing suspensions revoke app passwords (sessions signed in with
    // one end); a session signed in with the password lasts until the client disconnects or Stalwart restarts.
    expect(await smtp.send(`MAIL FROM:<${address}>`)).toMatch(/^250 /m);
    expect(await smtp.send(`RCPT TO:<${address}>`)).toMatch(/^250 /m);
    expect(await smtp.send("DATA")).toMatch(/^354 /m);
    const body = `From: <${address}>\r\nTo: <${address}>\r\nSubject: after suspension\r\nMessage-ID: <${randomUUID()}@int>\r\nDate: ${new Date().toUTCString()}\r\n\r\nhi\r\n.`;
    expect(await smtp.send(body)).toMatch(/^250 /m);
    smtp.close();
    expect(await db.select().from(schema.authSession).where(eq(schema.authSession.userId, memberId))).toEqual([]);
    await liftPersonSuspension(deps, staff, memberId, session, meta);
    await drain(m.id);
    expect(await mailboxRow(m.id)).toMatchObject({ status: "active" });
    expect(await sessionStatus()).toBe(200);
  });
});
