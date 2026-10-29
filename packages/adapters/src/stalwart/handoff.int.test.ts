// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console → webmail handoff against the real Stalwart and Postgres (ADR-0024). The code under test runs with the
 * production credentials (ADR-0020 "Credential split"): the mailbox is provisioned with the provisioning key, the
 * throwaway credential is minted and destroyed with the operations key, the inventory read with the provisioning key.
 * The dev admin only sets things up (a known mailbox password, then a password change).
 *
 * What must keep holding on every Stalwart upgrade (rule 22):
 *   - a credential with every permission but `authenticate` off gets an ordinary webmail token at `/api/auth`;
 *   - the token and its refresh grant keep working after the credential is destroyed;
 *   - a password change revokes them like a password sign-in's;
 *   - a destroyed or expired credential is refused; expired leftovers can be cleared;
 *   - the reconciler's inventory leaves a handoff credential out, and the reserved slot lets a mailbox with all five
 *     app passwords still be opened.
 * The core services run end to end on Postgres: the code is redeemed once, only with the right verifier, and both
 * steps are audited without secrets.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { createAppPassword } from "@anhourmail/core/app-passwords";
import { PlanLimitError } from "@anhourmail/core";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import {
  type HandoffCodeStore,
  type HandoffGrant,
  handoffChallenge,
  newHandoffVerifier,
  redeemWebmailHandoff,
  startWebmailHandoff,
} from "@anhourmail/core/webmail";
import {
  HANDOFF_CREDENTIAL_DESCRIPTION,
  OAuthDeniedError,
  StalwartManagement,
  StalwartOAuth,
  StalwartTransport,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "@anhourmail/stalwart-client";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartAppPasswordInventory, stalwartMailServer } from ".";
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
const meta = { requestId: `int-handoff-${randomUUID().slice(0, 8)}`, ip: null, userAgent: null };

const tag = randomUUID().slice(0, 8);
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-${tag}.test`);
const mail = stalwartMailServer(keys.provisioning);
const inventory = stalwartAppPasswordInventory(keys.provisioning);
const ops = keys.operations;
const domain = `hof-${tag}.test`;
const address = `kid@${domain}`;
/** RFC 5737 documentation range: this test's deliberate refusals count against this address, never a shared one. */
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;
const oauth = new StalwartOAuth({
  baseUrl: stalwartUrl,
  clientId: WEBMAIL_OAUTH_CLIENT_ID,
  redirectUri: webmailRedirectUri(process.env.WEBMAIL_URL ?? "http://localhost:43300"),
});
let accountId = "";
let mailboxRowId = "";
let userId = "";
const bansBefore = new Set<string>();

const bans = () => mgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"]);

afterAll(async () => {
  const added = (await bans()).filter((b) => !bansBefore.has(b.id));
  if (added.length > 0) {
    await mgmt.transport.set("x:BlockedIp", { destroy: added.map((b) => b.id) });
    await mgmt.transport.call([["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"]]);
  }
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  await keys.cleanup();
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  if (userId) await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
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

/** The web app's handoff sign-in (apps/web `stalwartHandoffSignIn`), with the operations key. */
async function handoffTokens(externalId: string) {
  await ops.clearExpiredHandoffCredentials(externalId);
  const made = await ops.createHandoffCredential(externalId, 60_000);
  try {
    return await oauth.signInWithHandoffCredential(address, made.secret, clientAddress);
  } finally {
    await ops.destroyAppPassword(externalId, made.id);
  }
}

const sessionOf = async (token: string) => {
  const res = await fetch(`${stalwartUrl}/jmap/session`, {
    headers: { Authorization: `Bearer ${token}`, "X-Forwarded-For": clientAddress },
  });
  return { status: res.status, body: res.ok ? ((await res.json()) as { username?: string }) : null };
};

const handoffCredentialsOn = async (externalId: string) =>
  (await ops.listAppPasswords(externalId)).filter((a) => a.description === HANDOFF_CREDENTIAL_DESCRIPTION);

/** Redis stand-in (the app's store is `SET EX` + `GETDEL`). */
const codes = new Map<string, HandoffGrant>();
const store: HandoffCodeStore = {
  put: async (k, g) => {
    codes.set(k, g);
  },
  take: async (k) => {
    const g = codes.get(k) ?? null;
    codes.delete(k);
    return g;
  },
};
const access = { state: async () => "ok" as const };

describe("console → webmail handoff on Stalwart", () => {
  it("opens the person's own mailbox once with a throwaway credential, keeps the session, and audits both steps", async () => {
    for (const b of await bans()) bansBefore.add(b.id);
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `handoff ${tag}`, plan: "plus" })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    userId = randomUUID();
    const email = `handoff-${tag}@example.test`;
    await db.insert(schema.authUser).values({ id: userId, name: "Kid", email, emailVerified: true });
    await db.insert(schema.accountMembership).values({ accountId, userId, role: "member" });
    const sessionId = randomUUID();
    await db.insert(schema.authSession).values({
      id: sessionId,
      token: randomBytes(24).toString("base64url"),
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      signInMethod: "password",
    });
    // A fresh step-up for this console session (a sign-in counts), as our better-auth plugin records it.
    await db.insert(schema.authVerification).values({
      id: randomUUID(),
      identifier: `step-up-${sessionId}`,
      value: userId,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    mailboxRowId = "";
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, userId, address, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
      .returning();
    if (!d || !m) throw new Error("rows not created");
    mailboxRowId = m.id;
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id);
    await drain(m.id);
    const externalId = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id)))[0]?.stalwartId;
    if (!externalId) throw new Error("mailbox not on the mail server");

    const actor: Actor = {
      kind: "user",
      userId,
      email,
      platformRoles: [],
      memberships: [{ accountId, role: "member" }],
      suspended: false,
      signInMethod: "password",
    };
    const verifier = newHandoffVerifier();
    const { code } = await startWebmailHandoff(
      deps,
      store,
      access,
      actor,
      accountId,
      m.id,
      { challenge: handoffChallenge(verifier) },
      { sessionId },
      meta,
    );
    // Another browser (its own verifier) burns the code and gets nothing.
    await expect(
      redeemWebmailHandoff(
        deps,
        store,
        access,
        { code, verifier: newHandoffVerifier() },
        () => handoffTokens(externalId),
        meta,
      ),
    ).rejects.toMatchObject({ reason: "wrong_browser" });
    expect(await handoffCredentialsOn(externalId)).toEqual([]);

    const again = await startWebmailHandoff(
      deps,
      store,
      access,
      actor,
      accountId,
      m.id,
      { challenge: handoffChallenge(verifier) },
      { sessionId },
      meta,
    );
    const tokens = await redeemWebmailHandoff(
      deps,
      store,
      access,
      { code: again.code, verifier },
      (t) => handoffTokens(t.externalId),
      meta,
    );
    // An ordinary webmail token for exactly this mailbox; the credential is gone, the token isn't.
    const s = await sessionOf(tokens.accessToken);
    expect(s.status).toBe(200);
    expect(s.body?.username).toBe(address);
    expect(await handoffCredentialsOn(externalId)).toEqual([]);
    const refreshed = await oauth.refresh(tokens.refreshToken ?? "", clientAddress);
    expect((await sessionOf(refreshed.accessToken)).status).toBe(200);
    // Once only.
    await expect(
      redeemWebmailHandoff(deps, store, access, { code: again.code, verifier }, () => handoffTokens(externalId), meta),
    ).rejects.toMatchObject({ code: "handoff_invalid" });

    const rows = await db
      .select({ action: schema.auditLog.action, result: schema.auditLog.result, errorCode: schema.auditLog.errorCode })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.requestId, meta.requestId));
    expect(rows.map((r) => `${r.action}:${r.result}${r.errorCode ? `:${r.errorCode}` : ""}`).sort()).toEqual(
      [
        "webmail.handoff_redeemed:denied:wrong_browser",
        "webmail.handoff_redeemed:success",
        "webmail.handoff_started:success",
        "webmail.handoff_started:success",
      ].sort(),
    );
    const chain = await deps.uow.run((r) => r.audit.chain(`account:${accountId}`));
    expect(JSON.stringify(chain)).not.toContain(again.code);
    expect(JSON.stringify(chain)).not.toContain(verifier);

    // A password change revokes the handoff session like any webmail session.
    await mgmt.upsertUser({
      name: "kid",
      domain,
      password: await hashPassword(randomBytes(18).toString("base64url")),
      resetPassword: true,
      quotaBytes: 50 * 1024 * 1024,
    });
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await sessionOf(refreshed.accessToken)).status).toBe(401);
    await expect(oauth.refresh(refreshed.refreshToken ?? "", clientAddress)).rejects.toBeInstanceOf(OAuthDeniedError);
  });

  it("refuses a destroyed or expired credential, clears leftovers, leaves them out of the inventory, keeps a slot", async () => {
    const externalId = (await mgmt.listUsers()).find((u) => u.address === address)?.id;
    if (!externalId) throw new Error("mailbox missing");

    // In flight: the reconciler's inventory doesn't count it as an app password anyone holds.
    const live = await ops.createHandoffCredential(externalId, 60_000);
    const inv = await inventory.list(externalId);
    expect(inv.appPasswords).toEqual([]);
    expect((await keys.provisioning.credentialInventory(externalId)).handoffCredentials).toBe(1);
    await ops.destroyAppPassword(externalId, live.id);
    await expect(oauth.signInWithHandoffCredential(address, live.secret, clientAddress)).rejects.toBeInstanceOf(
      OAuthDeniedError,
    );

    // Expired: refused, then cleared by the next handoff.
    const short = await ops.createHandoffCredential(externalId, 1_000);
    await new Promise((r) => setTimeout(r, 3_000));
    await expect(oauth.signInWithHandoffCredential(address, short.secret, clientAddress)).rejects.toBeInstanceOf(
      OAuthDeniedError,
    );
    expect((await handoffCredentialsOn(externalId)).map((a) => a.id)).toEqual([short.id]);
    expect(await ops.clearExpiredHandoffCredentials(externalId)).toBe(1);
    expect(await handoffCredentialsOn(externalId)).toEqual([]);

    // A mailbox with all five app passwords (our limit) still has the reserved slot for a handoff.
    const made: string[] = [];
    for (let i = 0; i < 5; i++)
      made.push((await ops.createAppPassword(externalId, { description: `p${String(i)}`, scopes: ["imap"] })).id);
    const tokens = await handoffTokens(externalId);
    expect((await sessionOf(tokens.accessToken)).status).toBe(200);
    for (const id of made) await ops.destroyAppPassword(externalId, id);
  });

  it("serialises changes to one mailbox's credential list across processes (the credential lock)", async () => {
    // Two units of work on different connections: the second waits for the first to commit.
    const events: string[] = [];
    const first = deps.uow.run(async (r) => {
      await r.appPasswords.lockCredentials(mailboxRowId);
      events.push("first locked");
      await new Promise((res) => setTimeout(res, 400));
      events.push("first done");
    });
    await new Promise((res) => setTimeout(res, 50));
    const second = deps.uow.run(async (r) => {
      await r.appPasswords.lockCredentials(mailboxRowId);
      events.push("second locked");
    });
    // Another mailbox is not held up.
    await deps.uow.run(async (r) => {
      await r.appPasswords.lockCredentials(randomUUID());
      events.push("other locked");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first locked", "other locked", "first done", "second locked"]);
  });

  it("can't race past the app-password limit, so the handoff slot stays free", async () => {
    // Four app passwords on record, then two concurrent creates: the account lock lets exactly one through.
    const issued: string[] = [];
    const issuer = {
      create: async () => {
        const id = randomUUID().slice(0, 6);
        issued.push(id);
        await new Promise((res) => setTimeout(res, 150));
        return { credentialId: id, createdAt: new Date(), secret: `app_${"x".repeat(36)}` };
      },
      revoke: async () => undefined,
    };
    const sessionId = randomUUID();
    await db.insert(schema.authVerification).values({
      id: randomUUID(),
      identifier: `step-up-${sessionId}`,
      value: userId,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    const actor: Actor = {
      kind: "user",
      userId,
      email: "kid@example.test",
      platformRoles: [],
      memberships: [{ accountId, role: "member" }],
      suspended: false,
    };
    const make = (name: string) =>
      createAppPassword(
        deps,
        issuer,
        actor,
        accountId,
        mailboxRowId,
        { name, protocols: ["imap"] },
        { sessionId },
        meta,
      );
    for (let i = 0; i < 4; i++) await make(`seq-${String(i)}`);
    const results = await Promise.allSettled([make("race-a"), make("race-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(PlanLimitError);
    expect(
      await db.select().from(schema.appPassword).where(eq(schema.appPassword.mailboxId, mailboxRowId)),
    ).toHaveLength(5);
    expect(issued).toHaveLength(5);
    await db.delete(schema.appPassword).where(eq(schema.appPassword.mailboxId, mailboxRowId));
  });
});
