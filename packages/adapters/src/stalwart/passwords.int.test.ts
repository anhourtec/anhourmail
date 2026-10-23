// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox passwords end to end against the pinned dev Stalwart and the test database, with the real provisioning key
 * (ADR-0020 "Credential split"): a mailbox created in the console with a password can sign in; an admin's reset is
 * applied by the worker with only the argon2id hash, replacing the one Password credential (app passwords keep
 * working, old OAuth tokens stop); the reconciler flags a password replaced behind the control plane's back. Sign-ins
 * that fail on purpose send a documentation-range client address, and any ban on it is lifted afterwards.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { createAppPassword, reconcileAppPasswords } from "@anhourmail/core/app-passwords";
import {
  changeOwnMailboxPassword,
  createMailbox,
  passwordJobState,
  resetMailboxPassword,
} from "@anhourmail/core/mailboxes";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import {
  MAILBOX_PASSWORD_HEADER,
  mailboxPasswordGrant,
  StalwartManagement,
  StalwartTransport,
  verifyMailboxPasswordGrant,
  WEBMAIL_OAUTH_CLIENT_ID,
} from "@anhourmail/stalwart-client";

import { hashPassword, mailboxPasswordHasher } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartAppPasswordInventory, stalwartAppPasswords, stalwartMailServer } from ".";
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
const adminMgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const domain = `pw-${tag}.test`;
const keys = await issueTestKeys(adminMgmt, stalwartUrl, `pwsvc-${tag}.test`);
const mail = stalwartMailServer(keys.provisioning);
const meta = { requestId: "int-passwords", ip: null, userAgent: null };
/** This test's own client address (RFC 5737), so its deliberate failures never count against the shared forwarder. */
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;
let accountId = "";
let userId = "";

afterAll(async () => {
  for (const u of (await adminMgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await adminMgmt.destroy("x:Account", u.id);
  }
  const d = (await adminMgmt.listDomains()).find((x) => x.name === domain);
  if (d) await adminMgmt.destroyDomain(d.id);
  await keys.cleanup();
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  if (userId) await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
  const bans = (await adminMgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"])).filter(
    (b) => b.address === clientAddress,
  );
  if (bans.length > 0) {
    await adminMgmt.transport.set("x:BlockedIp", { destroy: bans.map((b) => b.id) });
    await adminMgmt.transport.call([["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"]]);
  }
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

/** The webmail's sign-in (OAuth code flow with PKCE): an access token, or null when the password is refused. */
async function signIn(address: string, password: string): Promise<string | null> {
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
  ).json()) as { type?: string; client_code?: string };
  if (auth.type !== "authenticated" || !auth.client_code) return null;
  const token = (await (
    await fetch(`${stalwartUrl}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": clientAddress },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: auth.client_code,
        client_id: WEBMAIL_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri ?? "",
        code_verifier: verifier,
      }).toString(),
    })
  ).json()) as { access_token?: string };
  return token.access_token ?? null;
}

const session = async (authorization: string) =>
  (
    await fetch(`${stalwartUrl}/jmap/session`, {
      headers: { Authorization: authorization, "X-Forwarded-For": clientAddress },
    })
  ).status;

describe("mailbox passwords against Stalwart", () => {
  it("creates with a password, resets it through the worker, keeps app passwords and flags out-of-band changes", async () => {
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `pw ${tag}`, plan: "plus" })
      .returning();
    const [person] = await db
      .insert(schema.authUser)
      .values({ id: `pw-${tag}`, name: "Owner", email: `owner-${tag}@example.test`, emailVerified: true })
      .returning();
    if (!account || !person) throw new Error("rows not created");
    accountId = account.id;
    userId = person.id;
    await db.insert(schema.accountMembership).values({ accountId, userId, role: "owner" });
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    if (!d) throw new Error("domain not created");
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await drain(d.id);

    const owner: Actor = {
      kind: "user",
      userId,
      email: person.email,
      platformRoles: [],
      memberships: [{ accountId, role: "owner" }],
      suspended: false,
    };
    // A fresh step-up on this console session (app passwords and resets need one).
    const sessionId = `sess-${tag}`;
    await db.insert(schema.authVerification).values({
      id: randomUUID(),
      identifier: `step-up-${sessionId}`,
      value: userId,
      expiresAt: new Date(Date.now() + 300_000),
    });
    const first = `first ${randomBytes(9).toString("base64url")}`;
    const address = `jo@${domain}`;
    const created = await createMailbox(
      deps,
      owner,
      accountId,
      { localPart: "jo", domainId: d.id, quotaGb: 1, ownerUserId: userId, password: first },
      meta,
      mailboxPasswordHasher,
    );
    // Only the argon2id hash waits for the worker.
    const row0 = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, created.id)))[0];
    expect(row0?.pendingPasswordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(row0)).not.toContain(first);
    await drain(created.id);
    const row1 = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, created.id)))[0];
    if (!row1?.stalwartId) throw new Error("mailbox not provisioned");
    expect(row1).toMatchObject({ status: "active", pendingPasswordHash: null });
    expect(row1.passwordCredentialId).toBeTruthy();
    const stalwartId = row1.stalwartId;

    // The webmail sign-in works with the chosen password.
    const token1 = await signIn(address, first);
    expect(token1).not.toBeNull();
    expect(await session(`Bearer ${token1 ?? ""}`)).toBe(200);
    // An app password (the person's own, made with the operations key) before the reset.
    const app = await createAppPassword(
      deps,
      stalwartAppPasswords(keys.operations),
      owner,
      accountId,
      created.id,
      { name: "Phone", protocols: ["jmap"] },
      { sessionId },
      meta,
    );
    expect(await session(`Basic ${Buffer.from(`${address}:${app.secret}`).toString("base64")}`)).toBe(200);
    expect(
      (await reconcileAppPasswords(deps, stalwartAppPasswordInventory(keys.provisioning))).addresses,
    ).not.toContain(address);

    // Out of band: the password replaced directly at Stalwart (not through the control plane) → reported, not fixed.
    const [creds] = await adminMgmt.transport.getAll<{ id: string; credentials: Record<string, { "@type": string }> }>(
      "x:Account",
      ["credentials"],
      [stalwartId],
    );
    const slot = Object.entries(creds?.credentials ?? {}).find(([, c]) => c["@type"] === "Password")?.[0] ?? "0";
    await adminMgmt.transport.set("x:Account", {
      update: {
        [stalwartId]: {
          [`credentials/${slot}`]: { "@type": "Password", secret: await hashPassword(randomBytes(12).toString("hex")) },
        },
      },
    });
    const drift = await reconcileAppPasswords(deps, stalwartAppPasswordInventory(keys.provisioning));
    expect(drift.passwordReplaced).toBeGreaterThanOrEqual(1);
    expect(drift.addresses).toContain(address);
    expect(
      (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, created.id)))[0]?.passwordCredentialId,
    ).toBe(row1.passwordCredentialId);

    // The admin's reset (step-up fresh on this session): the worker applies only the hash, with the provisioning key.
    const second = `second ${randomBytes(9).toString("base64url")}`;
    // With the web app's grant key (as in production): the grant is stored beside the hash, bound to this account.
    const grantKey = randomBytes(32).toString("base64url");
    const withGrant = {
      hash: mailboxPasswordHasher.hash,
      grant: (i: { externalId: string; passwordHash: string }) =>
        mailboxPasswordGrant(grantKey, i.externalId, i.passwordHash),
    };
    const reset = await resetMailboxPassword(
      deps,
      withGrant,
      owner,
      accountId,
      created.id,
      { password: second },
      { sessionId },
      meta,
    );
    expect(await passwordJobState(deps, reset.jobId)).toBe("pending");
    const waiting = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, created.id)))[0];
    expect(
      verifyMailboxPasswordGrant(
        grantKey,
        waiting?.pendingPasswordGrant ?? "",
        stalwartId,
        waiting?.pendingPasswordHash ?? "",
      ),
    ).toBe(true);
    await drain(created.id);
    expect(await passwordJobState(deps, reset.jobId)).toBe("applied");
    const row2 = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, created.id)))[0];
    expect(row2?.pendingPasswordHash).toBeNull();
    expect(row2?.pendingPasswordGrant).toBeNull();
    expect(await signIn(address, second)).not.toBeNull();
    expect(await signIn(address, first)).toBeNull();
    // The token from before stopped working; the app password didn't.
    expect(await session(`Bearer ${token1 ?? ""}`)).toBe(401);
    expect(await session(`Basic ${Buffer.from(`${address}:${app.secret}`).toString("base64")}`)).toBe(200);
    const inv = await keys.provisioning.credentialInventory(stalwartId);
    expect(inv.passwords.map((p) => p.id)).toEqual([row2?.passwordCredentialId]);
    expect(inv.appPasswords).toHaveLength(1);
    expect(
      (await reconcileAppPasswords(deps, stalwartAppPasswordInventory(keys.provisioning))).addresses,
    ).not.toContain(address);

    // The person's own change from the webmail goes the same way.
    const third = `third ${randomBytes(9).toString("base64url")}`;
    const change = await changeOwnMailboxPassword(deps, mailboxPasswordHasher, address, { password: third }, meta);
    await drain(created.id);
    expect(await passwordJobState(deps, change.jobId)).toBe("applied");
    expect(await signIn(address, third)).not.toBeNull();

    const actions = (await deps.uow.run((r) => r.audit.chain(`account:${accountId}`))).map(
      (e) => `${e.action}:${e.result}`,
    );
    expect(actions).toEqual([
      "mailbox.created:success",
      "auth.app_password_created:success",
      "mailbox.password_reset:success",
      "mailbox.password_changed:success",
    ]);
    const audit = JSON.stringify(await deps.uow.run((r) => r.audit.chain(`account:${accountId}`)));
    for (const secret of [first, second, third, "$argon2id$"]) expect(audit).not.toContain(secret);
  });

  it("the client refuses anything but an argon2id hash and a mailbox whose address changed", async () => {
    const id = await adminMgmt.upsertUser({
      name: "other",
      domain,
      password: await hashPassword(randomBytes(12).toString("hex")),
      quotaBytes: 1e7,
    });
    await expect(keys.provisioning.replacePassword(id, "plaintext-password")).rejects.toThrow(/argon2id/);
    await expect(
      mail.setMailboxPassword({
        externalId: id,
        address: `someone-else@${domain}`,
        passwordHash: await hashPassword("x".repeat(16)),
        grant: null,
      }),
    ).rejects.toThrow(/no longer matches/);
    // The marker header rides on the one credentials write (the production proxy requires it; Stalwart ignores it).
    expect(MAILBOX_PASSWORD_HEADER).toBe("X-AnhourMail-Credential-Write");
    const out = await mail.setMailboxPassword({
      externalId: id,
      address: `other@${domain}`,
      passwordHash: await hashPassword("y".repeat(16)),
      grant: null,
    });
    expect((await keys.provisioning.credentialInventory(id)).passwords.map((p) => p.id)).toEqual([out.credentialId]);
  });
});
