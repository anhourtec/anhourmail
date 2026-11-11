// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trust tiers through provisioning on the compose stack (ADR-0034 build slice 7): `mailbox.ensure` runs as a queue job
 * against Postgres and applies `mailboxSendAccess` on the real pinned Stalwart with the production provisioning key.
 * A mailbox of a `new` account is held from SMTP submission (465 and 587 refuse AUTH) while its webmail submission over
 * JMAP still delivers; `standard` opens SMTP; staff's restriction of that one mailbox stops every kind of sending and
 * lifting it gives the account's access back.
 *
 * Refusals for a missing permission don't count as failed sign-ins (verified), so the shared dev forwarder is never
 * brought near its ban limit; JMAP goes from this test's own documentation-range client address.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { systemClock } from "@anhourmail/core";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartMailServer } from ".";
import { issueTestKeys } from "./int-keys";
import { smtpExchange } from "./int-smtp";

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
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-trust-${tag}.test`);
const mail = stalwartMailServer(keys.provisioning);
const domain = `trust-${tag}.test`;
const address = `held@${domain}`;
const password = randomBytes(18).toString("base64url");
const clientAddress = `203.0.113.${String(1 + Math.floor(Math.random() * 254))}`;
const port = (k: string, d: number) => Number(process.env[k] ?? d);
const P465 = port("STALWART_SUBMISSIONS_PORT", 465);
const P587 = port("STALWART_SUBMISSION_PORT", 587);
let accountId = "";

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
    if (!(await runNextJob(deps, mail))) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jobs for ${subjects.join(", ")} did not finish`);
}

const plainAuth = `AUTH PLAIN ${Buffer.from(`\0${address}\0${password}`).toString("base64")}`;
/** The reply to AUTH on 465 (implicit TLS) or 587 (STARTTLS). */
async function authReply(p: number): Promise<string> {
  const starttls = p === P587;
  const replies = await smtpExchange(p, starttls ? "starttls" : "implicit", ["EHLO int-test", plainAuth, "QUIT"]);
  return replies[starttls ? 4 : 2] ?? replies.join(" | ");
}
const REFUSED = /^550 5\.7\.1 /;
const ACCEPTED = /^235 /;

/** Saves a draft to the mailbox itself (a hosted address) and submits it over JMAP, as the webmail BFF does. */
async function jmapSend(subject: string): Promise<string> {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
    "X-Forwarded-For": clientAddress,
  };
  const session = (await (await fetch(`${stalwartUrl}/jmap/session`, { headers })).json()) as {
    primaryAccounts: Record<string, string>;
  };
  const jmapAccount = session.primaryAccounts["urn:ietf:params:jmap:mail"] ?? "";
  const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const call = async (methodCalls: unknown[]) =>
    (
      (await (
        await fetch(`${stalwartUrl}/jmap`, { method: "POST", headers, body: JSON.stringify({ using, methodCalls }) })
      ).json()) as { methodResponses: [string, Record<string, unknown>, string][] }
    ).methodResponses;
  const [mailboxes, identities] = await call([
    ["Mailbox/get", { accountId: jmapAccount, properties: ["role"] }, "m"],
    ["Identity/get", { accountId: jmapAccount }, "i"],
  ]);
  const drafts = (mailboxes?.[1].list as { id: string; role: string | null }[]).find((m) => m.role === "drafts")?.id;
  const identityId = (identities?.[1].list as { id: string }[] | undefined)?.[0]?.id ?? "";
  const res = await call([
    [
      "Email/set",
      {
        accountId: jmapAccount,
        create: {
          e: {
            mailboxIds: { [drafts ?? ""]: true },
            from: [{ email: address }],
            to: [{ email: address }],
            subject,
            bodyValues: { b: { value: "hello" } },
            textBody: [{ partId: "b", type: "text/plain" }],
          },
        },
      },
      "e",
    ],
    ["EmailSubmission/set", { accountId: jmapAccount, create: { s: { emailId: "#e", identityId } } }, "s"],
  ]);
  const sub = res[1];
  if (sub?.[0] === "error") return `error:${String(sub[1].type)}`;
  const refused = (sub?.[1].notCreated as Record<string, { type: string }> | undefined)?.s;
  return refused ? `refused:${refused.type}` : "submitted";
}

/** The access the mail server holds for the mailbox now. */
const serverAccess = async () => (await mgmt.listUsers()).find((u) => u.address === address)?.access;

describe("trust tiers through mailbox.ensure on Stalwart (ADR-0034 §3–4)", () => {
  it("new holds SMTP and keeps webmail sending; standard opens SMTP; a mailbox restriction stops all sending", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `trust ${tag}`, plan: "free" })
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
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id, m.id);
    expect((await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id)))[0]?.status).toBe("active");

    // A new account (the default): no SMTP submission from mail apps; the webmail still sends to hosted addresses.
    expect(await serverAccess()).toBe("smtp_blocked");
    expect(await authReply(P465)).toMatch(REFUSED);
    expect(await authReply(P587)).toMatch(REFUSED);
    expect(await jmapSend(`held ${tag}`)).toBe("submitted");

    // Standard: mail apps may send.
    await deps.uow.run((r) =>
      r.trust.setTier(accountId, {
        tier: "standard",
        since: new Date(),
        source: "automatic",
        reason: null,
        note: null,
        setBy: null,
      }),
    );
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(m.id);
    expect(await serverAccess()).toBe("active");
    expect(await authReply(P465)).toMatch(ACCEPTED);
    expect(await jmapSend(`standard ${tag}`)).toBe("submitted");

    // Staff restrict this mailbox: no sending on any protocol (sign-in and delivery stay, as billing's block).
    await deps.uow.run((r) =>
      r.trust.setMailboxRestriction(accountId, m.id, { at: new Date(), reason: "spam", note: null, byUserId: null }),
    );
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(m.id);
    expect(await serverAccess()).toBe("send_blocked");
    expect(await authReply(P587)).toMatch(REFUSED);
    expect(await jmapSend(`restricted ${tag}`)).toBe("error:forbidden");

    // Lifted: back to the account's access.
    await deps.uow.run((r) => r.trust.setMailboxRestriction(accountId, m.id, null));
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(m.id);
    expect(await serverAccess()).toBe("active");
    expect(await authReply(P587)).toMatch(ACCEPTED);
  });
});
