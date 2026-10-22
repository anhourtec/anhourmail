// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Catch-all end to end against the real Stalwart (compose stack): off by default (an unknown address at the domain is
 * refused during the SMTP conversation), on through the core service and the domain job (mail to a made-up address
 * lands in the chosen mailbox), and off again by itself when that mailbox is suspended. Unknown recipients are
 * refused only once per run: inbound mail reaches Stalwart through the shared dev forwarder.
 */
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { setCatchAll } from "@anhourmail/core/domains";
import { suspendMailbox } from "@anhourmail/core/mailboxes";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

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
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const mail = stalwartMailServer(mgmt);
const meta = { requestId: "int-catch-all", ip: null, userAgent: null };

const tag = randomUUID().slice(0, 8);
const domain = `ca-${tag}.test`;
const target = `inbox@${domain}`;
const password = randomBytes(18).toString("base64url");
let accountId = "";
let userId = "";

afterAll(async () => {
  const users = await mgmt.listUsers();
  for (const u of users.filter((x) => x.address.endsWith(`@${domain}`))) await mgmt.destroy("x:Account", u.id);
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  if (userId) await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
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

/** Inbound SMTP on port 25, as another mail server would deliver; returns the last reply line of each step. */
async function deliver(to: string): Promise<string[]> {
  const lines = [
    "EHLO sender.test",
    `MAIL FROM:<someone@sender-${tag}.test>`,
    `RCPT TO:<${to}>`,
    "DATA",
    `From: someone@sender-${tag}.test\r\nTo: ${to}\r\nSubject: catch-all ${tag}\r\n\r\nhello\r\n.`,
    "QUIT",
  ];
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(process.env.STALWART_SMTP_PORT ?? 25) });
    const replies: string[] = [];
    let buf = "";
    let i = -1;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(replies);
    };
    const next = () => {
      i += 1;
      // Stop at the first refusal: nothing after it would be accepted.
      if (i >= lines.length || replies.some((r) => /^5\d\d /.test(r))) {
        finish();
        return;
      }
      socket.write(`${lines[i] ?? ""}\r\n`);
    };
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      buf += d;
      clearTimeout(timer);
      timer = setTimeout(() => {
        replies.push(buf.trim().split("\r\n").at(-1) ?? "");
        buf = "";
        next();
      }, 300);
    });
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 15_000).unref();
  });
}

const basic = `Basic ${Buffer.from(`${target}:${password}`).toString("base64")}`;

/** Recipients of the messages in the target mailbox (JMAP as the mailbox itself). */
async function receivedFor(): Promise<string[]> {
  const session = (await (
    await fetch(`${stalwartUrl}/jmap/session`, { headers: { Authorization: basic } })
  ).json()) as { primaryAccounts: Record<string, string> };
  const jmapAccount = session.primaryAccounts["urn:ietf:params:jmap:mail"] ?? "";
  const res = await fetch(`${stalwartUrl}/jmap`, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Email/query", { accountId: jmapAccount }, "q"],
        [
          "Email/get",
          { accountId: jmapAccount, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["to"] },
          "g",
        ],
      ],
    }),
  });
  const body = (await res.json()) as { methodResponses: [string, { list?: { to: { email: string }[] }[] }, string][] };
  return (body.methodResponses[1]?.[1].list ?? []).flatMap((e) => e.to.map((t) => t.email));
}

const catchAllOnServer = async (): Promise<string | null> => {
  const domains = await mgmt.transport.getAll<{ id: string; name: string; catchAllAddress?: string | null }>(
    "x:Domain",
    ["name", "catchAllAddress"],
  );
  return domains.find((d) => d.name === domain)?.catchAllAddress ?? null;
};

describe("catch-all on Stalwart", () => {
  it("refuses unknown addresses while off, delivers them to the chosen mailbox while on, turns off on suspension", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `catch-all ${tag}`, plan: "plus" })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    userId = randomUUID();
    await db
      .insert(schema.authUser)
      .values({ id: userId, name: "Owner", email: `ca-${tag}@example.test`, emailVerified: true });
    await db.insert(schema.accountMembership).values({ accountId, userId, role: "owner" });
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, userId, address: target, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
      .returning();
    if (!d || !m) throw new Error("rows not created");
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id);
    await drain(m.id);
    // A password we know, to read the mailbox over JMAP (the control plane itself never sets one).
    await mgmt.upsertUser({
      name: "inbox",
      domain,
      password: await hashPassword(password),
      resetPassword: true,
      quotaBytes: 50 * 1024 * 1024,
    });
    const actor: Actor = {
      kind: "user",
      userId,
      email: `ca-${tag}@example.test`,
      platformRoles: [],
      memberships: [{ accountId, role: "owner" }],
      suspended: false,
    };

    // Off by default: refused at RCPT, before any content is accepted.
    expect(await catchAllOnServer()).toBeNull();
    const refused = await deliver(`nobody-${tag}@${domain}`);
    expect(refused.at(-1)).toMatch(/^550 /);

    // On: a made-up address lands in the chosen mailbox.
    await setCatchAll(deps, actor, accountId, d.id, { mailboxId: m.id }, meta);
    await drain(d.id);
    expect(await catchAllOnServer()).toBe(target);
    const random = `random-${tag}@${domain}`;
    const accepted = await deliver(random);
    expect(accepted.some((r) => r.startsWith("250 2.0.0"))).toBe(true);
    await expect.poll(receivedFor, { timeout: 15_000 }).toContain(random);

    // Suspending the mailbox turns the catch-all off by itself, in the control plane and on the mail server.
    await suspendMailbox(deps, actor, accountId, m.id, meta);
    await drain(m.id);
    await drain(d.id);
    expect(await deps.uow.run((r) => r.catchAll.get(d.id))).toBeNull();
    expect(await catchAllOnServer()).toBeNull();

    const audit = await deps.uow.run((r) => r.audit.chain(`account:${accountId}`));
    expect(audit.map((e) => e.action)).toEqual(["catch_all.changed", "mailbox.suspended"]);
    expect(audit[0]?.meta).toMatchObject({ enabled: true, changed: true });
    expect(audit[1]?.meta).toEqual({ from: "active", catchAllOff: [domain] });
  });
});
