// SPDX-License-Identifier: AGPL-3.0-only
/**
 * App passwords end to end against the real Stalwart (compose stack): the core service issues them through the
 * management API on the mailbox's account, mail apps sign in over IMAP and SMTP with them, their limits hold
 * (protocol scopes, no self-service, no webmail sign-in), suspension blocks them, and revoking (a provisioning job)
 * takes them off the mail server.
 *
 * Mail ports reach Stalwart through the shared dev forwarder, and Stalwart bans an address after 100 failed sign-ins a
 * day (`x:Security.authBanRate`), which would cut every dev client off. Refusals for a missing permission (a suspended
 * mailbox, a protocol the app password doesn't allow) don't count as failures (verified), so those are checked over
 * IMAP. A revoked app password is a wrong credential, so that check goes over HTTP from this test's own
 * documentation-range client address (`X-Forwarded-For`), whose ban is lifted afterwards.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { gunzipSync } from "node:zlib";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type Actor, systemClock } from "@anhourmail/core";
import { createAppPassword, reconcileAppPasswords, revokeAppPasswords } from "@anhourmail/core/app-passwords";
import { reconcileManagedScripts } from "@anhourmail/core/webmail";
import { resumeMailbox, suspendMailbox } from "@anhourmail/core/mailboxes";
import { enqueueProvisioning, runNextJob } from "@anhourmail/core/provisioning";
import {
  KNOWN_PERMISSIONS,
  OAuthDeniedError,
  StalwartManagement,
  StalwartOAuth,
  StalwartTransport,
  WEBMAIL_OAUTH_CLIENT_ID,
} from "@anhourmail/stalwart-client";

import { MANAGED_SIEVE_SCRIPT } from "@anhourmail/shared/webmail";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartAppPasswords, stalwartMailServer, stalwartManagedScripts } from ".";

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
const issuer = stalwartAppPasswords(mgmt);
const meta = { requestId: "int-app-passwords", ip: null, userAgent: null };

const tag = randomUUID().slice(0, 8);
const domain = `apw-${tag}.test`;
const address = `owner@${domain}`;
const mailboxPassword = randomBytes(18).toString("base64url");
let accountId = "";
let userId = "";
const bansBefore = new Set<string>();
/** RFC 5737 documentation range, random per run: this test's deliberate wrong-credential sign-ins count here. */
const clientAddress = `198.51.100.${String(1 + Math.floor(Math.random() * 254))}`;

const port = (k: string, d: number) => Number(process.env[k] ?? d);

async function bans(): Promise<{ id: string; address: string }[]> {
  return mgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"]);
}

afterAll(async () => {
  // Lift any ban this test's deliberate failures caused (the forwarder's address is shared by every dev client).
  const added = (await bans()).filter((b) => !bansBefore.has(b.id));
  if (added.length > 0) {
    await mgmt.transport.set("x:BlockedIp", { destroy: added.map((b) => b.id) });
    await mgmt.transport.call([["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"]]);
  }
  const users = await mgmt.listUsers();
  for (const u of users.filter((x) => x.address.endsWith(`@${domain}`))) await mgmt.destroy("x:Account", u.id);
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  if (accountId) await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
  if (userId) await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
  await pool.end();
});

/** Runs queued jobs until none is left for this subject (other suites share the queue). */
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

/** One line-based exchange on a mail port (dev certificates are self-signed: verification off, dev only). */
async function converse(p: number, secure: boolean, lines: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = secure
      ? tls.connect({ host: "127.0.0.1", port: p, rejectUnauthorized: false })
      : net.connect({ host: "127.0.0.1", port: p });
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
      if (i >= lines.length) {
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
        replies.push(buf.trim());
        buf = "";
        next();
      }, 300);
    });
    socket.on("close", () => {
      if (buf) replies.push(buf.trim());
      replies.push("<closed>");
      finish();
    });
    socket.on("error", () => {
      finish();
    });
    setTimeout(finish, 15_000).unref();
  });
}

const imapLogin = async (secret: string): Promise<boolean> => {
  const replies = await converse(port("STALWART_IMAPS_PORT", 993), true, [
    `a1 LOGIN "${address}" "${secret}"`,
    "a2 LOGOUT",
  ]);
  return replies.some((r) => /^a1 OK/m.test(r));
};

/** SMTP AUTH on 465, then MAIL FROM (sending needs both). */
const smtpSend = async (secret: string): Promise<boolean> => {
  const plain = Buffer.from(`\0${address}\0${secret}`).toString("base64");
  const replies = await converse(port("STALWART_SUBMISSIONS_PORT", 465), true, [
    "EHLO int-test",
    `AUTH PLAIN ${plain}`,
    `MAIL FROM:<${address}>`,
    "QUIT",
  ]);
  return replies.some((r) => /^235 /m.test(r)) && replies.some((r) => /^250 2\.1\.0/m.test(r));
};

const basic = (secret: string) => `Basic ${Buffer.from(`${address}:${secret}`).toString("base64")}`;

const adminAuth = `Basic ${Buffer.from(`${admin}:${adminPassword}`).toString("base64")}`;

/** JMAP calls with a credential from this test's own client address; each answer as its name or `error:<type>`. */
async function call(auth: string, using: string[], calls: unknown[]): Promise<string[]> {
  const res = await fetch(`${stalwartUrl}/jmap`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", "X-Forwarded-For": clientAddress },
    body: JSON.stringify({ using, methodCalls: calls }),
  });
  if (!res.ok) return [`HTTP ${String(res.status)}`];
  const body = (await res.json()) as { methodResponses: [string, { type?: string }, string][] };
  return body.methodResponses.map(([name, args]) => (name === "error" ? `error:${args.type ?? ""}` : name));
}

/** JMAP session status for a credential, from this test's own client address. */
const sessionStatus = async (secret: string): Promise<number> =>
  (
    await fetch(`${stalwartUrl}/jmap/session`, {
      headers: { Authorization: basic(secret), "X-Forwarded-For": clientAddress },
    })
  ).status;

describe("app passwords on Stalwart", () => {
  it("issue, sign in by protocol, stay limited, stop while suspended and after revoking", async () => {
    for (const b of await bans()) bansBefore.add(b.id);
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `apw ${tag}`, plan: "plus" })
      .returning();
    if (!account) throw new Error("account not created");
    accountId = account.id;
    userId = randomUUID();
    const email = `apw-${tag}@example.test`;
    await db.insert(schema.authUser).values({ id: userId, name: "Owner", email, emailVerified: true });
    await db.insert(schema.accountMembership).values({ accountId, userId, role: "owner" });
    const [d] = await db
      .insert(schema.customerDomain)
      .values({ accountId, name: domain, status: "active", verifyToken: "t" })
      .returning();
    const [m] = await db
      .insert(schema.mailbox)
      .values({ accountId, userId, address, quotaBytes: 50 * 1024 * 1024, status: "provisioning" })
      .returning();
    if (!d || !m) throw new Error("rows not created");
    await enqueueProvisioning(deps, { kind: "domain.ensure", subjectId: d.id });
    await enqueueProvisioning(deps, { kind: "mailbox.ensure", subjectId: m.id });
    await drain(d.id);
    await drain(m.id);
    const stalwartId = (await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, m.id)))[0]?.stalwartId;
    if (!stalwartId) throw new Error("mailbox not on the mail server");

    const actor: Actor = {
      kind: "user",
      userId,
      email,
      platformRoles: [],
      memberships: [{ accountId, role: "owner" }],
      suspended: false,
    };
    // A fresh step-up for this console session, as our better-auth plugin records it.
    const sessionId = randomUUID();
    await db.insert(schema.authVerification).values({
      id: randomUUID(),
      identifier: `step-up-${sessionId}`,
      value: userId,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    // Upgrade guard: every self-service permission the account's role grants is one we turn off. (A known mailbox
    // password, set first: replacing the credential list drops every app password — verified.)
    await mgmt.upsertUser({
      name: "owner",
      domain,
      password: await hashPassword(mailboxPassword),
      resetPassword: true,
      quotaBytes: 50 * 1024 * 1024,
    });
    const granted = (await (
      await fetch(`${stalwartUrl}/api/account`, { headers: { Authorization: basic(mailboxPassword) } })
    ).json()) as { permissions: string[] | Record<string, unknown> };
    const perms = Array.isArray(granted.permissions) ? granted.permissions : Object.keys(granted.permissions);
    const selfService = perms.filter((p) => p.startsWith("sys"));
    // The customer account itself has every self-service permission off (`CUSTOMER_DENIALS`), whatever signs in.
    expect(selfService).toEqual([]);
    expect(perms).not.toContain("jmapPrincipalQuery");
    // Upgrade guard: every non-administrative permission the server knows is classified for app passwords.
    let schemaRes = await fetch(`${stalwartUrl}/api/schema`, {
      headers: { Authorization: adminAuth },
      redirect: "manual",
    });
    if (schemaRes.status >= 300 && schemaRes.status < 400) {
      schemaRes = await fetch(new URL(schemaRes.headers.get("location") ?? "", stalwartUrl), {
        headers: { Authorization: adminAuth },
      });
    }
    const raw = Buffer.from(await schemaRes.arrayBuffer());
    const schemaJson = JSON.parse((raw[0] === 0x1f ? gunzipSync(raw) : raw).toString("utf8")) as {
      enums: Record<string, { name: string }[] | { variants: { name: string }[] }>;
    };
    const permEnum = schemaJson.enums.Permission;
    const names = (Array.isArray(permEnum) ? permEnum : (permEnum?.variants ?? [])).map((v) => v.name);
    expect(names.length).toBeGreaterThan(100);
    expect(names.filter((n) => !n.startsWith("sys") && !KNOWN_PERMISSIONS.includes(n))).toEqual([]);

    const create = (name: string, protocols: string[]) =>
      createAppPassword(deps, issuer, actor, accountId, m.id, { name, protocols }, { sessionId }, meta);

    const phone = await create("Phone", ["imap", "smtp", "dav"]);
    expect(phone.secret).toMatch(/^app_[a-z0-9]{36}$/);
    const printer = await create("Printer", ["smtp"]);
    const mailApp = await create("Mail app", ["jmap"]);

    // Stored by Stalwart (hashed); our rows hold metadata only.
    const onServer = await mgmt.listAppPasswords(stalwartId);
    expect(onServer.map((a) => a.description).sort()).toEqual(["Mail app", "Phone", "Printer"]);
    const rows = await db.select().from(schema.appPassword).where(eq(schema.appPassword.mailboxId, m.id));
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(phone.secret);
    const audit = await deps.uow.run((r) => r.audit.chain(`account:${accountId}`));
    expect(JSON.stringify(audit)).not.toContain(phone.secret);

    // Mail apps sign in with them, each only for what it was made for.
    expect(await imapLogin(phone.secret)).toBe(true);
    expect(await smtpSend(phone.secret)).toBe(true);
    expect(await smtpSend(printer.secret)).toBe(true);
    expect(await imapLogin(printer.secret)).toBe(false);
    const jmapAsPrinter = await fetch(`${stalwartUrl}/jmap`, {
      method: "POST",
      headers: { Authorization: basic(printer.secret), "Content-Type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Mailbox/get", { accountId: stalwartId, ids: null }, "m"]],
      }),
    });
    expect(JSON.stringify(await jmapAsPrinter.json())).toContain("forbidden");
    // Contacts and calendars don't include mail over HTTPS; the JMAP scope does. No scope lists other accounts.
    const mailCaps = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
    const principalCaps = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:principals"];
    expect(await call(basic(phone.secret), mailCaps, [["Email/query", { accountId: stalwartId }, "q"]])).toEqual([
      "error:forbidden",
    ]);
    expect(await call(basic(mailApp.secret), mailCaps, [["Email/query", { accountId: stalwartId }, "q"]])).toEqual([
      "Email/query",
    ]);
    expect(
      await call(basic(phone.secret), principalCaps, [["Principal/query", { accountId: stalwartId }, "q"]]),
    ).toEqual(["error:forbidden"]);
    expect(
      await call(basic(mailboxPassword), principalCaps, [["Principal/query", { accountId: stalwartId }, "q"]]),
    ).toEqual(["error:forbidden"]);
    // DAV directory search: a customer account can't search (403), an account without the denials can (it found
    // accounts on other domains; verified run-22). Phone-style CardDAV discovery keeps working.
    const domainId = (await mgmt.listDomains()).find((x) => x.name === domain)?.id ?? "";
    await mgmt.transport.set("x:Account", {
      create: {
        p: {
          "@type": "User",
          name: "plain",
          domainId,
          credentials: { "0": { "@type": "Password", secret: await hashPassword(mailboxPassword) } },
          roles: { "@type": "User" },
          permissions: { "@type": "Inherit" },
          quotas: { maxDiskQuota: 1048576 },
          aliases: {},
        },
      },
    });
    const dav = async (user: string, method: string, path: string, body: string, depth: string) => {
      const res = await fetch(`${stalwartUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${user}:${mailboxPassword}`).toString("base64")}`,
          Depth: depth,
          "Content-Type": "application/xml",
          "X-Forwarded-For": clientAddress,
        },
        body,
      });
      return { status: res.status, text: await res.text() };
    };
    const search = (term: string) =>
      `<?xml version="1.0"?><d:principal-property-search xmlns:d="DAV:"><d:property-search><d:prop><d:displayname/></d:prop><d:match>${term}</d:match></d:property-search><d:prop><d:displayname/></d:prop></d:principal-property-search>`;
    expect((await dav(address, "REPORT", "/dav/pal/", search("plain"), "0")).status).toBe(403);
    const open = await dav(`plain@${domain}`, "REPORT", "/dav/pal/", search("owner"), "0");
    expect(open.status).toBe(207);
    expect(open.text).toContain(`owner@${domain}`);
    const cup =
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
    const homeSet =
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><c:addressbook-home-set/></d:prop></d:propfind>';
    expect((await dav(address, "PROPFIND", "/.well-known/carddav", cup, "0")).status).toBe(207);
    expect((await dav(address, "PROPFIND", `/dav/pal/${encodeURIComponent(address)}/`, homeSet, "0")).status).toBe(207);

    // No sharing: folders and calendars can't be created or changed with `shareWith` (address books stay writable
    // for the webmail — a known gap, pinned here so it's noticed if it changes).
    const plainId = (await mgmt.listUsers()).find((u) => u.address === `plain@${domain}`)?.id ?? "";
    const share = { [plainId]: { mayReadItems: true } };
    const pw = basic(mailboxPassword);
    expect(
      await call(
        pw,
        [...mailCaps, "urn:ietf:params:jmap:principals"],
        [["Mailbox/set", { accountId: stalwartId, create: { m: { name: "Shared", shareWith: share } } }, "s"]],
      ),
    ).toEqual(["error:forbidden"]);
    expect(
      await call(
        pw,
        ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"],
        [["Calendar/set", { accountId: stalwartId, create: { c: { name: "Shared" } } }, "s"]],
      ),
    ).toEqual(["error:forbidden"]);
    const books = await call(
      pw,
      ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"],
      [["AddressBook/set", { accountId: stalwartId, create: { b: { name: "Mine" } } }, "s"]],
    );
    expect(books).toEqual(["AddressBook/set"]);

    const contacts = await fetch(`${stalwartUrl}/dav/card/${encodeURIComponent(address)}/`, {
      method: "PROPFIND",
      headers: { Authorization: basic(phone.secret), Depth: "1", "X-Forwarded-For": clientAddress },
    });
    expect(contacts.status).toBe(207);

    // The reconciler finds exactly ours; a credential made behind our back is reported (never removed).
    expect((await reconcileAppPasswords(deps, issuer)).addresses).not.toContain(address);
    await mgmt.transport.set("x:AppPassword", { accountId: stalwartId, create: { x: { description: "by hand" } } });
    expect((await reconcileAppPasswords(deps, issuer)).addresses).toContain(address);
    const byHand = (await mgmt.listAppPasswords(stalwartId)).find((a) => a.description === "by hand");
    expect(byHand).toBeDefined();
    await mgmt.destroyAppPassword(stalwartId, byHand?.id ?? "");

    // No self-service with an app password: it can't mint more of them.
    const mint = await fetch(`${stalwartUrl}/jmap`, {
      method: "POST",
      headers: { Authorization: basic(phone.secret), "Content-Type": "application/json" },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
        methodCalls: [["x:AppPassword/set", { create: { a: { description: "sneaky" } } }, "s"]],
      }),
    });
    expect(JSON.stringify(await mint.json())).toContain("forbidden");
    expect((await mgmt.listAppPasswords(stalwartId)).map((a) => a.description)).not.toContain("sneaky");

    // Never a webmail sign-in: the OAuth token would carry the whole account's permissions.
    const oauth = new StalwartOAuth({
      baseUrl: stalwartUrl,
      clientId: WEBMAIL_OAUTH_CLIENT_ID,
      redirectUri: "http://localhost:43300/oauth/callback",
    });
    await expect(oauth.signIn(address, phone.secret)).rejects.toBeInstanceOf(OAuthDeniedError);
    await expect(oauth.signIn(address, `${phone.secret}$123456`)).rejects.toBeInstanceOf(OAuthDeniedError);
    // Even a token minted from an app password straight at Stalwart (bypassing our client) can't touch credentials or
    // the password: the account has them off.
    const clients = await mgmt.transport.getAll<{
      id: string;
      clientId: string;
      redirectUris: Record<string, unknown>;
    }>("x:OAuthClient", ["clientId", "redirectUris"]);
    const redirectUri = Object.keys(clients.find((c) => c.clientId === WEBMAIL_OAUTH_CLIENT_ID)?.redirectUris ?? {})[0];
    const verifier = randomBytes(32).toString("base64url");
    const code = (await (
      await fetch(`${stalwartUrl}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": clientAddress },
        body: JSON.stringify({
          type: "authCode",
          accountName: address,
          accountSecret: phone.secret,
          clientId: WEBMAIL_OAUTH_CLIENT_ID,
          redirectUri,
          codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
          codeChallengeMethod: "S256",
        }),
      })
    ).json()) as { client_code?: string };
    const token = (await (
      await fetch(`${stalwartUrl}/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": clientAddress },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code.client_code ?? "",
          client_id: WEBMAIL_OAUTH_CLIENT_ID,
          redirect_uri: redirectUri ?? "",
          code_verifier: verifier,
        }).toString(),
      })
    ).json()) as { access_token?: string };
    const stalwartCaps = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"];
    expect(
      await call(`Bearer ${token.access_token ?? ""}`, stalwartCaps, [
        ["x:AppPassword/set", { create: { a: { description: "via token" } } }, "a"],
        ["x:ApiKey/set", { create: { k: { description: "via token" } } }, "k"],
        ["x:AccountPassword/set", { update: { singleton: { secret: "Another-Pass-For-Testing-1!" } } }, "p"],
      ]),
    ).toEqual(["error:forbidden", "error:forbidden", "error:forbidden"]);

    // Suspended: refused over IMAP and HTTP; resumed: works again (the app password itself is kept).
    await suspendMailbox(deps, actor, accountId, m.id, meta);
    await drain(m.id);
    expect(await imapLogin(phone.secret)).toBe(false);
    expect(await sessionStatus(phone.secret)).toBe(403);
    await resumeMailbox(deps, actor, accountId, m.id, meta);
    await drain(m.id);
    expect(await imapLogin(phone.secret)).toBe(true);

    // Revoke one: the job takes it off the mail server, then the row goes.
    expect(await sessionStatus(phone.secret)).toBe(200);
    await revokeAppPasswords(deps, actor, accountId, m.id, phone.appPassword.id, meta);
    await drain(m.id);
    expect((await mgmt.listAppPasswords(stalwartId)).map((a) => a.description).sort()).toEqual(["Mail app", "Printer"]);
    expect(await sessionStatus(phone.secret)).toBe(401);
    expect(
      (await db.select().from(schema.appPassword).where(eq(schema.appPassword.mailboxId, m.id)))
        .map((r) => r.name)
        .sort(),
    ).toEqual(["Mail app", "Printer"]);

    // Ids are reused after a revocation: a stale revoke (older creation time) leaves the newer one alone.
    const tablet = await create("Tablet", ["imap"]);
    const tabletRow = (await db.select().from(schema.appPassword).where(eq(schema.appPassword.name, "Tablet")))[0];
    if (!tabletRow) throw new Error("tablet row missing");
    await mail.revokeAppPassword({
      externalId: stalwartId,
      credentialId: tabletRow.credentialId,
      createdAt: new Date(tabletRow.credentialCreatedAt.getTime() - 3_600_000),
    });
    expect(await imapLogin(tablet.secret)).toBe(true);

    // The managed Sieve script: one written behind our back with an unconfirmed redirect is reported and the mailbox
    // re-queued; nothing is deleted or rewritten.
    await mgmt.putSieveScript(
      stalwartId,
      MANAGED_SIEVE_SCRIPT,
      'require ["copy"];\nredirect :copy "spy@example.test";\n',
    );
    const scripts = await reconcileManagedScripts(deps, stalwartManagedScripts(mgmt));
    expect(scripts.unconfirmedRedirects).toBeGreaterThanOrEqual(1);
    expect(scripts.notOurs).toBeGreaterThanOrEqual(1);
    expect((await mgmt.getSieveScript(stalwartId, MANAGED_SIEVE_SCRIPT))?.content).toContain("spy@example.test");
    const queued = await db
      .select({ id: schema.provisioningJob.id })
      .from(schema.provisioningJob)
      .where(and(eq(schema.provisioningJob.subjectId, m.id), eq(schema.provisioningJob.kind, "mailbox.ensure")));
    expect(queued.length).toBeGreaterThan(0);
    await drain(m.id);

    // Revoke all.
    expect(await revokeAppPasswords(deps, actor, accountId, m.id, null, meta)).toEqual({ revoked: 3 });
    await drain(m.id);
    expect(await mgmt.listAppPasswords(stalwartId)).toEqual([]);
    expect(await db.select().from(schema.appPassword).where(eq(schema.appPassword.mailboxId, m.id))).toEqual([]);

    const actions = (await deps.uow.run((r) => r.audit.chain(`account:${accountId}`))).map(
      (e) => `${e.action}:${e.result}`,
    );
    expect(actions).toEqual([
      "auth.app_password_created:success",
      "auth.app_password_created:success",
      "auth.app_password_created:success",
      "mailbox.suspended:success",
      "mailbox.unsuspended:success",
      "auth.app_password_revoked:success",
      "auth.app_password_created:success",
      "auth.app_password_revoked:success",
    ]);
  });
});
