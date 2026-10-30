// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Opening a delegated mailbox in the webmail against the real Stalwart and Postgres (ADR-0026 §6, §7). The code under
 * test runs with the production credentials (ADR-0020 "Credential split"): mailboxes are provisioned with the
 * provisioning key, the throwaway credential is minted and destroyed with the operations key (as the web app's
 * `stalwartHandoffSignIn` does). The dev admin only cleans up.
 *
 * What must keep holding:
 *   - a granted person opens the mailbox with that mailbox's own token (the mail server names it), and nothing is left
 *     on its credential list; the open is audited in the account, refusals too, with no token anywhere;
 *   - the gate answers "no" at once after a revoke, a plan downgrade, the mailbox's suspension and the person's removal
 *     (the grant rows go with the membership);
 *   - two opens at once serialise on the credential lock and both succeed in the reserved slot, even with all five app
 *     passwords in use; a slot held by someone else is retried once and then answered "try again".
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DelegatedMailboxRefusedError, systemClock, TryAgainError } from "@anhourmail/core";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import {
  CredentialSlotTakenError,
  type DelegatedTarget,
  delegationCheck,
  openDelegatedMailbox,
} from "@anhourmail/core/webmail";
import {
  HANDOFF_CREDENTIAL_DESCRIPTION,
  isOverQuotaError,
  StalwartManagement,
  StalwartOAuth,
  StalwartTransport,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "@anhourmail/stalwart-client";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

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
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const meta = { requestId: `int-delegation-${randomUUID().slice(0, 8)}`, ip: null, userAgent: null };

const tag = randomUUID().slice(0, 8);
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-${tag}.test`);
const mail = stalwartMailServer(keys.provisioning);
const ops = keys.operations;
const domain = `dlg-${tag}.test`;
const kimAddress = `kim@${domain}`;
const deskAddress = `desk@${domain}`;
/** RFC 5737 documentation range: this test's sign-ins count against this address, never a shared one. */
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;
const oauth = new StalwartOAuth({
  baseUrl: stalwartUrl,
  clientId: WEBMAIL_OAUTH_CLIENT_ID,
  redirectUri: webmailRedirectUri(process.env.WEBMAIL_URL ?? "http://localhost:43300"),
});
const access = { state: async () => "ok" as const };
let accountId = "";
let kimId = "";
let deskId = "";
let deskExternal = "";

afterAll(async () => {
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  await keys.cleanup();
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  if (kimId) await db.delete(schema.authUser).where(eq(schema.authUser.id, kimId));
  await pool.end();
});

async function drain(subjectId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const open = await db
      .select({ status: schema.provisioningJob.status })
      .from(schema.provisioningJob)
      .where(eq(schema.provisioningJob.subjectId, subjectId));
    if (open.every((j) => j.status !== "queued" && j.status !== "running")) return;
    if (!(await runNextJob(deps, mail))) await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`jobs for ${subjectId} did not finish`);
}

/** The web app's open (`stalwartHandoffSignIn` + the JMAP session check), with the operations key. */
async function signIn(target: DelegatedTarget): Promise<{ username: string; accessToken: string }> {
  await ops.clearExpiredHandoffCredentials(target.externalId);
  let made: { id: string; secret: string };
  try {
    made = await ops.createHandoffCredential(target.externalId, 60_000);
  } catch (err) {
    if (isOverQuotaError(err)) throw new CredentialSlotTakenError("credential slot taken");
    throw err;
  }
  try {
    const tokens = await oauth.signInWithHandoffCredential(target.address, made.secret, clientAddress);
    const res = await fetch(`${stalwartUrl}/jmap/session`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "X-Forwarded-For": clientAddress },
    });
    const body = (await res.json()) as { username?: string };
    return { username: body.username ?? "", accessToken: tokens.accessToken };
  } finally {
    await ops.destroyAppPassword(target.externalId, made.id);
  }
}

const open = () => openDelegatedMailbox(deps, access, { owners: [kimAddress], address: deskAddress }, signIn, meta);
const gate = () =>
  delegationCheck(deps, access)({ mailboxId: deskId, granteeUserId: kimId, via: kimAddress, need: "full_access" });
const handoffCredentialsOn = async (externalId: string) =>
  (await ops.listAppPasswords(externalId)).filter((a) => a.description === HANDOFF_CREDENTIAL_DESCRIPTION);
const grantFullAccess = () =>
  deps.uow.run((r) =>
    r.delegation.grant({
      accountId,
      mailboxId: deskId,
      granteeUserId: kimId,
      right: "full_access",
      grantedBy: null,
      at: new Date(),
    }),
  );

beforeAll(async () => {
  const [account] = await db
    .insert(schema.customerAccount)
    .values({ name: `delegation ${tag}`, plan: "plus" })
    .returning();
  if (!account) throw new Error("account not created");
  accountId = account.id;
  kimId = randomUUID();
  await db
    .insert(schema.authUser)
    .values({ id: kimId, name: "Kim", email: `kim-${tag}@example.test`, emailVerified: true });
  await db.insert(schema.accountMembership).values({ accountId, userId: kimId, role: "member" });
  const [d] = await db
    .insert(schema.customerDomain)
    .values({ accountId, name: domain, status: "active", verifyToken: "t" })
    .returning();
  const [kim] = await db
    .insert(schema.mailbox)
    .values({ accountId, userId: kimId, address: kimAddress, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
    .returning();
  const [desk] = await db
    .insert(schema.mailbox)
    .values({ accountId, userId: null, address: deskAddress, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
    .returning();
  if (!d || !kim || !desk) throw new Error("rows not created");
  deskId = desk.id;
  await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
  await drain(d.id);
  for (const m of [kim, desk]) {
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(m.id);
  }
  deskExternal = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, desk.id)))[0]?.stalwartId ?? "";
  if (!deskExternal) throw new Error("desk not on the mail server");
}, 60_000);

describe("delegated mailboxes on Stalwart", () => {
  it("opens a granted mailbox with its own token, leaves no credential behind, and audits without secrets", async () => {
    await expect(open()).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    await grantFullAccess();
    const { value, mailbox } = await open();
    expect(value.username).toBe(deskAddress);
    expect(mailbox).toMatchObject({ mailboxId: deskId, granteeUserId: kimId, via: kimAddress });
    const res = await fetch(`${stalwartUrl}/jmap/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${value.accessToken}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": clientAddress,
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Mailbox/get", { ids: null, properties: ["role"] }, "m"]],
      }),
    });
    expect(res.status).toBe(200);
    expect(await handoffCredentialsOn(deskExternal)).toEqual([]);
    const rows = await db
      .select({ result: schema.auditLog.result, errorCode: schema.auditLog.errorCode, scope: schema.auditLog.scope })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.requestId, meta.requestId), eq(schema.auditLog.action, "delegation.mailbox_opened")),
      );
    expect(rows.map((r) => `${r.result}:${r.errorCode ?? ""}`)).toEqual(["denied:not_granted", "success:"]);
    expect(rows.every((r) => r.scope === `account:${accountId}`)).toBe(true);
    const chain = await deps.uow.run((r) => r.audit.chain(`account:${accountId}`));
    expect(JSON.stringify(chain)).not.toContain(value.accessToken);
  }, 30_000);

  it("refuses at once after a revoke, a plan downgrade, a suspension and the person's removal", async () => {
    expect(await gate()).toBe(true);
    await deps.uow.run((r) => r.delegation.revoke(accountId, deskId, kimId, "full_access"));
    expect(await gate()).toBe(false);
    await expect(open()).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    await grantFullAccess();
    expect(await gate()).toBe(true);

    await db.update(schema.customerAccount).set({ plan: "free" }).where(eq(schema.customerAccount.id, accountId));
    expect(await gate()).toBe(false);
    await expect(open()).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    await db.update(schema.customerAccount).set({ plan: "plus" }).where(eq(schema.customerAccount.id, accountId));
    expect(await gate()).toBe(true);

    await db.update(schema.mailbox).set({ status: "suspended" }).where(eq(schema.mailbox.id, deskId));
    expect(await gate()).toBe(false);
    await db.update(schema.mailbox).set({ status: "active" }).where(eq(schema.mailbox.id, deskId));
    expect(await gate()).toBe(true);
  }, 30_000);

  it("serialises two opens on the credential lock, uses the reserved slot, and answers 'try again' when it is held", async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      made.push((await ops.createAppPassword(deskExternal, { description: `p${String(i)}`, scopes: ["imap"] })).id);
    }
    const both = await Promise.all([open(), open()]);
    expect(both.map((b) => b.value.username)).toEqual([deskAddress, deskAddress]);
    expect(await handoffCredentialsOn(deskExternal)).toEqual([]);

    // Someone else holds the reserved slot (a live credential not made under our lock): retried once, then 503.
    const held = await ops.createHandoffCredential(deskExternal, 60_000);
    await expect(open()).rejects.toBeInstanceOf(TryAgainError);
    await ops.destroyAppPassword(deskExternal, held.id);
    for (const id of made) await ops.destroyAppPassword(deskExternal, id);
    const failed = await db
      .select({ result: schema.auditLog.result, errorCode: schema.auditLog.errorCode })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.requestId, meta.requestId),
          eq(schema.auditLog.action, "delegation.mailbox_opened"),
          eq(schema.auditLog.result, "failed"),
        ),
      );
    expect(failed.map((r) => r.errorCode)).toEqual(["unavailable"]);
  }, 60_000);

  it("drops the grant with the person's membership (the cascade) and refuses from then on", async () => {
    await db
      .delete(schema.accountMembership)
      .where(and(eq(schema.accountMembership.accountId, accountId), eq(schema.accountMembership.userId, kimId)));
    expect(
      await db.select().from(schema.mailboxDelegation).where(eq(schema.mailboxDelegation.mailboxId, deskId)),
    ).toEqual([]);
    expect(await gate()).toBe(false);
    await expect(open()).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
  }, 30_000);
});
