// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing end to end on the compose stack (ADR-0029 §4–5, slices 5–6): signed provider events (the fake provider, real
 * signature scheme) are ingested into Postgres once each, `billing.sync` runs as a queue job and reconciles the account,
 * and `mailbox.ensure` applies the result on the real pinned Stalwart with the production provisioning key: a
 * new free account's mailbox can't send from mail apps until paying promotes it to standard (ADR-0034 §2–3); a
 * restricted account's mailbox is refused on 465 and 587 and for JMAP submission, still signs in and reads over IMAP
 * and still receives; paying restores sending. A provider outage changes nothing.
 *
 * Refusals for a missing permission don't count as failed sign-ins (verified), so the shared dev forwarder is never
 * brought near its ban limit; JMAP goes from this test's own documentation-range client address.
 */
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { systemClock } from "@anhourmail/core";
import {
  type BillingProvider,
  BillingProviderError,
  defaultBilling,
  ingestBillingEvent,
  syncAccountBilling,
} from "@anhourmail/core/billing";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { createFakeBillingProvider, fakeWebhookSecret, memoryFakeBillingStore } from "../billing-fake";
import { createDb, schema } from "../db-postgres/client";
import { PgBillingRepository } from "../db-postgres/billing";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartAppPasswords, stalwartMailServer } from ".";
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
const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-bill-${tag}.test`);
const mail = stalwartMailServer(keys.provisioning, { hold: keys.hold });
const provider = createFakeBillingProvider({
  store: memoryFakeBillingStore(),
  appUrl: "http://localhost:43200",
  webhookSecret: fakeWebhookSecret(`int-${tag}`),
  nodeEnv: "test",
});
const domain = `bill-${tag}.test`;
const address = `owner@${domain}`;
const password = randomBytes(18).toString("base64url");
const clientAddress = `203.0.113.${String(1 + Math.floor(Math.random() * 254))}`;
const port = (k: string, d: number) => Number(process.env[k] ?? d);
let accountId = "";
let mailboxId = "";

afterAll(async () => {
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  await keys.cleanup();
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  await pool.end();
});

/** Runs queued jobs until none is left for these subjects (other suites share the queue). */
async function drain(...subjects: string[]): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const open = await db
      .select({ id: schema.provisioningJob.id })
      .from(schema.provisioningJob)
      .where(
        and(
          inArray(schema.provisioningJob.subjectId, subjects),
          sql`${schema.provisioningJob.status} in ('queued', 'running')`,
        ),
      );
    if (open.length === 0) return;
    if (!(await runNextJob(deps, mail, { billing: provider }))) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jobs for ${subjects.join(", ")} did not finish`);
}

/** Signed deliveries → verify → record, as the webhook route does. Returns the outcomes. */
async function deliver(): Promise<string[]> {
  const out: string[] = [];
  for (const { body, signature } of await provider.drainDeliveries()) {
    out.push(await ingestBillingEvent(deps, provider.verifyWebhook(body, signature, new Date()), new Date()));
  }
  return out;
}

const billingState = async () =>
  (await db.select().from(schema.accountBilling).where(eq(schema.accountBilling.accountId, accountId)))[0]?.state;

/** One line-based exchange on a mail port; STARTTLS upgrades in place (dev certificates are self-signed). */
async function smtp(p: number, mode: "implicit" | "starttls" | "plain", lines: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    let socket: net.Socket =
      mode === "implicit"
        ? tls.connect({ host: "127.0.0.1", port: p, rejectUnauthorized: false })
        : net.connect({ host: "127.0.0.1", port: p });
    const queue = mode === "starttls" ? ["EHLO int-test", "STARTTLS", ...lines] : lines;
    const replies: string[] = [];
    let buf = "";
    let i = -1;
    let upgraded = mode !== "starttls";
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(replies);
    };
    const next = () => {
      i += 1;
      if (i >= queue.length) {
        finish();
        return;
      }
      socket.write(`${queue[i] ?? ""}\r\n`);
    };
    const onData = (d: Buffer | string) => {
      buf += d.toString();
      clearTimeout(timer);
      timer = setTimeout(() => {
        replies.push(buf.trim());
        buf = "";
        if (!upgraded && queue[i] === "STARTTLS") {
          upgraded = true;
          socket.removeAllListeners("data");
          const secure = tls.connect({ socket, rejectUnauthorized: false }, next);
          secure.on("data", onData);
          secure.on("error", finish);
          socket = secure;
          return;
        }
        next();
      }, 300);
    };
    socket.on("data", onData);
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 20_000).unref();
  });
}

const plain = (secret: string) => Buffer.from(`\0${address}\0${secret}`).toString("base64");
const submit = (p: number, mode: "implicit" | "starttls", secret = password) =>
  smtp(p, mode, ["EHLO int-test", `AUTH PLAIN ${plain(secret)}`, `MAIL FROM:<${address}>`, "QUIT"]);
const authOk = (replies: string[]) => replies.some((r) => /^235 /m.test(r));
const authRefused = (replies: string[]) => replies.some((r) => /^550 5\.7\.1 /m.test(r));

/** IMAP sign-in and SELECT INBOX (reading). */
async function imapReads(secret = password): Promise<boolean> {
  const replies = await smtp(port("STALWART_IMAPS_PORT", 993), "implicit", [
    `a1 LOGIN "${address}" "${secret}"`,
    "a2 SELECT INBOX",
    "a3 LOGOUT",
  ]);
  return replies.some((r) => /^a1 OK/m.test(r)) && replies.some((r) => /^a2 OK/m.test(r));
}

/**
 * JMAP: a draft is saved (reading and drafts stay), then submitted; returns the submission's answer. `holdUntil` asks
 * the server to release it later (`HOLDUNTIL`, FUTURERELEASE), to a recipient outside (caught by Mailpit).
 */
async function jmapSubmit(
  secret = password,
  opts: { holdUntil?: Date; to?: string; subject?: string } = {},
): Promise<string> {
  const auth = `Basic ${Buffer.from(`${address}:${secret}`).toString("base64")}`;
  const headers = { Authorization: auth, "Content-Type": "application/json", "X-Forwarded-For": clientAddress };
  const s = (await (await fetch(`${stalwartUrl}/jmap/session`, { headers })).json()) as {
    primaryAccounts: Record<string, string>;
  };
  const accountIdJmap = s.primaryAccounts["urn:ietf:params:jmap:mail"] ?? "";
  const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const call = async (methodCalls: unknown[]) =>
    (
      (await (
        await fetch(`${stalwartUrl}/jmap`, { method: "POST", headers, body: JSON.stringify({ using, methodCalls }) })
      ).json()) as { methodResponses: [string, Record<string, unknown>, string][] }
    ).methodResponses;
  const [mailboxes, identities] = await call([
    ["Mailbox/get", { accountId: accountIdJmap, properties: ["role"] }, "m"],
    ["Identity/get", { accountId: accountIdJmap }, "i"],
  ]);
  const drafts = (mailboxes?.[1].list as { id: string; role: string | null }[]).find((m) => m.role === "drafts")?.id;
  const identityId = (identities?.[1].list as { id: string }[] | undefined)?.[0]?.id ?? "";
  const res = await call([
    [
      "Email/set",
      {
        accountId: accountIdJmap,
        create: {
          e: {
            mailboxIds: { [drafts ?? ""]: true },
            from: [{ email: address }],
            to: [{ email: opts.to ?? `nobody@${domain}` }],
            subject: opts.subject ?? "billing access",
            bodyValues: { b: { value: "hello" } },
            textBody: [{ partId: "b", type: "text/plain" }],
          },
        },
      },
      "e",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: accountIdJmap,
        create: {
          s: {
            emailId: "#e",
            identityId,
            ...(opts.holdUntil
              ? {
                  envelope: {
                    mailFrom: {
                      email: address,
                      parameters: { HOLDUNTIL: opts.holdUntil.toISOString().replace(/\.\d+Z$/, "Z") },
                    },
                    rcptTo: [{ email: opts.to ?? `nobody@${domain}` }],
                  },
                }
              : {}),
          },
        },
      },
      "s",
    ],
  ]);
  const draft = res[0]?.[1].created ? "draft-saved" : "draft-refused";
  const sub = res[1];
  return `${draft} ${sub?.[0] === "error" ? `error:${String(sub[1].type)}` : "submitted"}`;
}

const MAILPIT = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;

/** Mailpit messages matching a search (dev and CI only; nothing leaves the machine), polled up to `ms`. */
async function caught(query: string, ms = 30_000): Promise<{ Subject: string; To: { Address: string }[] }[]> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}`);
    const found = ((await r.json()) as { messages?: { Subject: string; To: { Address: string }[] }[] }).messages ?? [];
    if (found.length > 0 || Date.now() > until) return found;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** A whole message delivered on port 25 from another server. */
const inboundMessage = (subject: string) =>
  smtp(port("STALWART_SMTP_PORT", 25), "plain", [
    "EHLO sender.test",
    `MAIL FROM:<someone-${tag}@sender-${tag}.test>`,
    `RCPT TO:<${address}>`,
    "DATA",
    `From: someone-${tag}@sender-${tag}.test\r\nTo: ${address}\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@sender.test>\r\n\r\nhello\r\n.`,
    "QUIT",
  ]);

/** Inbound on port 25 from another server: the RCPT reply (greeting, EHLO, MAIL, then RCPT). */
async function inboundRcpt(): Promise<string> {
  const replies = await smtp(port("STALWART_SMTP_PORT", 25), "plain", [
    "EHLO sender.test",
    `MAIL FROM:<someone@sender-${tag}.test>`,
    `RCPT TO:<${address}>`,
    "QUIT",
  ]);
  return replies[3] ?? replies.join(" | ");
}

describe("billing on the stack: webhook → billing_event → billing.sync → mailbox.ensure on Stalwart", () => {
  it("records each event once, syncs, restricts sending on every protocol, keeps reading and receiving, restores", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `billing ${tag}`, plan: "free" })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    const [m] = await db
      .insert(schema.mailbox)
      .values({
        accountId,
        address,
        quotaBytes: 50 * 1024 * 1024,
        status: "provisioning",
        pendingPasswordHash: await hashPassword(password),
      })
      .returning();
    if (!d || !m) throw new Error("rows not created");
    mailboxId = m.id;
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id, m.id);
    // A new free account: mail apps can't send over SMTP until it is promoted (ADR-0034 §3).
    expect((await mgmt.listUsers()).find((u) => u.address === address)?.access).toBe("smtp_blocked");
    expect(authRefused(await submit(port("STALWART_SUBMISSIONS_PORT", 465), "implicit"))).toBe(true);
    const stalwartId = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id)))[0]?.stalwartId;
    if (!stalwartId) throw new Error("mailbox not on the mail server");
    // An app password for mail apps (IMAP, SMTP, JMAP), issued as the console does (operations key).
    const appPassword = (
      await stalwartAppPasswords(keys.operations).create({
        externalId: stalwartId,
        name: "billing test",
        protocols: ["imap", "smtp", "jmap"],
      })
    ).secret;
    expect(authRefused(await submit(port("STALWART_SUBMISSIONS_PORT", 465), "implicit", appPassword))).toBe(true);
    // Forwarding and an automatic reply in the mailbox's Sieve script (set up with the dev admin; the console writes
    // the managed script with the operations key).
    await mgmt.putSieveScript(
      stalwartId,
      "billing-test",
      `require ["vacation", "copy"];\nredirect :copy "fwd-${tag}@ext-${tag}.test";\nvacation :days 1 :subject "away ${tag}" "I am away";\n`,
    );

    // The account's provider customer, then a paid checkout.
    const { customerId } = await provider.ensureCustomer({ accountId, email: "o@example.test", name: "O" });
    await new PgBillingRepository(db).save({
      ...defaultBilling(accountId, "free", new Date()),
      providerCustomerId: customerId,
    });
    const { url } = await provider.createCheckout({
      accountId,
      customerId,
      currency: "USD",
      plan: "plus",
      storageBlocks: 0,
      extraMailboxes: 0,
      successUrl: "http://localhost/s",
      cancelUrl: "http://localhost/c",
      intentId: randomUUID(),
    });
    await provider.completeCheckout(decodeURIComponent(url.split("/").pop() ?? ""), "pay");
    const deliveries = await provider.drainDeliveries();
    for (const { body, signature } of deliveries) {
      expect(await ingestBillingEvent(deps, provider.verifyWebhook(body, signature, new Date()), new Date())).toBe(
        "queued",
      );
    }
    // Duplicates are recorded once (the provider redelivers).
    for (const { body, signature } of deliveries) {
      expect(await ingestBillingEvent(deps, provider.verifyWebhook(body, signature, new Date()), new Date())).toBe(
        "duplicate",
      );
    }
    const rows = await db.select().from(schema.billingEvent).where(eq(schema.billingEvent.accountId, accountId));
    expect(rows).toHaveLength(3);
    await drain(accountId);
    expect(await billingState()).toBe("active");
    const paid = (await db.select().from(schema.customerAccount).where(eq(schema.customerAccount.id, accountId)))[0];
    expect(paid).toMatchObject({ plan: "plus", trustTier: "standard", trustTierSource: "billing" });
    // Paying promoted it to standard in the sync's unit of work and queued its mailbox: mail apps may send now.
    await drain(mailboxId);
    expect((await mgmt.listUsers()).find((u) => u.address === address)?.access).toBe("active");
    expect(authOk(await submit(port("STALWART_SUBMISSIONS_PORT", 465), "implicit"))).toBe(true);
    expect(authOk(await submit(port("STALWART_SUBMISSIONS_PORT", 465), "implicit", appPassword))).toBe(true);

    // An outage at the provider: the sync throws before writing anything (as a job, the queue retries it later).
    const down: BillingProvider = {
      ...provider,
      getSubscription: () => Promise.reject(new BillingProviderError("unavailable", "down")),
    };
    const before = (
      await db.select().from(schema.accountBilling).where(eq(schema.accountBilling.accountId, accountId))
    )[0];
    await expect(syncAccountBilling(deps, down, accountId)).rejects.toThrow(BillingProviderError);
    expect(
      (await db.select().from(schema.accountBilling).where(eq(schema.accountBilling.accountId, accountId)))[0],
    ).toEqual(before);

    // A send the mail app asked to release later (FUTURERELEASE / HOLDUNTIL), made while sending is still allowed.
    expect(
      await jmapSubmit(password, {
        holdUntil: new Date(Date.now() + 20_000),
        to: `held-${tag}@ext-${tag}.test`,
        subject: `held ${tag}`,
      }),
    ).toBe("draft-saved submitted");

    // Renewal fails, retries run out: restricted. The mailbox is send-blocked on the mail server.
    await provider.setCardFails(customerId, true);
    await provider.advanceClock(366);
    await provider.exhaustRetries(customerId);
    expect((await deliver()).every((o) => o === "queued")).toBe(true);
    await drain(accountId, mailboxId);
    expect(await billingState()).toBe("restricted");
    expect((await mgmt.listUsers()).find((u) => u.address === address)?.access).toBe("send_blocked");
    expect(authRefused(await submit(port("STALWART_SUBMISSIONS_PORT", 465), "implicit"))).toBe(true);
    expect(authRefused(await submit(port("STALWART_SUBMISSION_PORT", 587), "starttls"))).toBe(true);
    expect(await jmapSubmit()).toBe("draft-saved error:forbidden");
    expect(await imapReads()).toBe(true);
    expect(await inboundRcpt()).toMatch(/^250 2\.1\.5/m);
    // App passwords are refused the same way (the account's denials win over the credential's scope); reading stays.
    expect(authRefused(await submit(port("STALWART_SUBMISSIONS_PORT", 465), "implicit", appPassword))).toBe(true);
    expect(authRefused(await submit(port("STALWART_SUBMISSION_PORT", 587), "starttls", appPassword))).toBe(true);
    expect(await jmapSubmit(appPassword)).toBe("draft-saved error:forbidden");
    expect(await imapReads(appPassword)).toBe(true);
    // Accepted (ADR-0029 §5 update, SA60-03/04; research/stalwart.md "Billing access states"): the mail server still
    // releases a send held before the restriction (release isn't re-checked), and still runs the mailbox's Sieve
    // forwarding and automatic reply for mail it receives. Pinned so an upgrade that changes either is noticed.
    expect((await caught(`subject:"held ${tag}"`, 45_000)).length).toBe(1);
    await inboundMessage(`incoming ${tag}`);
    expect((await caught(`subject:"incoming ${tag}"`)).map((x) => x.To.map((t) => t.Address))).toContainEqual([
      address,
    ]);
    expect((await caught(`subject:"away ${tag}"`)).map((x) => x.To.map((t) => t.Address))).toEqual([
      [`someone-${tag}@sender-${tag}.test`],
    ]);
    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.scope, `account:${accountId}`));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["billing.state_changed", "billing.payment_failed"]),
    );

    // Paying restores sending.
    await provider.setCardFails(customerId, false);
    await provider.payOpenInvoice(customerId);
    await deliver();
    await drain(accountId, mailboxId);
    expect(await billingState()).toBe("active");
    expect((await mgmt.listUsers()).find((u) => u.address === address)?.access).toBe("active");
    expect(authOk(await submit(port("STALWART_SUBMISSIONS_PORT", 465), "implicit"))).toBe(true);
    expect(await jmapSubmit()).toBe("draft-saved submitted");
  });
});
