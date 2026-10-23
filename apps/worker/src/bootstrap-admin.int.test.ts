// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The first-administrator bootstrap against Postgres (`npm run test:int`), on a throwaway database so "nobody holds a
 * platform role yet" is really true. Proves the rows it writes, the audit chain, the refusal on a second run, and that
 * the emailed link is accepted once by the identity layer's own reset-password endpoint, which then signs in.
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "@anhourmail/adapters/auth";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { KNOWN_BREACHED_PASSWORDS, memoryBreachedPasswords } from "@anhourmail/adapters/memory";
import { createDb, PgUnitOfWork, schema } from "@anhourmail/adapters/postgres";
import { systemClock } from "@anhourmail/core";
import { verifyAuditScope } from "@anhourmail/core/audit";
import { createKeyRing } from "@anhourmail/server/keyring";
import { log, setLogSinkForTests } from "@anhourmail/server/log";
import { platformFacts } from "@anhourmail/shared/platform";

import { runBootstrapAdmin } from "./bootstrap-admin";

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error("TEST_DATABASE_URL is not set (integration tests need the compose stack)");

const name = `anhourmail_bootstrap_${randomBytes(4).toString("hex")}`;
const url = (() => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
})();
const admin = createDb(base);
let handle: ReturnType<typeof createDb>;

beforeAll(async () => {
  await admin.db.execute(sql.raw(`create database "${name}"`));
  handle = createDb(url);
  await migrate(handle.db, { migrationsFolder: path.join(import.meta.dirname, "../../../packages/adapters/drizzle") });
});

afterAll(async () => {
  await handle.pool.end();
  await admin.db.execute(sql.raw(`drop database if exists "${name}"`));
  await admin.pool.end();
});

const ORIGIN = "http://localhost:43298";

describe("job:bootstrap-admin against Postgres", () => {
  it("creates one audited Global Administrator whose emailed link sets a password once; a second run is refused", async () => {
    const { db } = handle;
    const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: platformFacts("staging-mail.test") };
    const mailer = memoryMailer();
    const logged: string[] = [];
    setLogSinkForTests((line) => logged.push(line));
    const email = `ada-${randomUUID().slice(0, 8)}@example.org`;
    try {
      const run = (address: string) =>
        runBootstrapAdmin({
          deps,
          mailer,
          appUrl: ORIGIN,
          input: { email: address, firstName: "Ada", lastName: "Lovelace" },
          log,
          requestId: "bootstrap-int",
        });
      expect(await run(email)).toBe("created");

      const [user] = await db.select().from(schema.authUser).where(eq(schema.authUser.email, email));
      if (!user) throw new Error("user not created");
      expect(user).toMatchObject({ name: "Ada Lovelace", firstName: "Ada", emailVerified: true });
      // No credential (password) until the link is used.
      expect(await db.select().from(schema.authAccount).where(eq(schema.authAccount.userId, user.id))).toEqual([]);
      const roles = await db
        .select({ role: schema.platformRoleAssignment.role, by: schema.platformRoleAssignment.grantedBy })
        .from(schema.platformRoleAssignment);
      expect(roles).toEqual([{ role: "global_admin", by: "bootstrap" }]);

      // The emailed link carries the token; neither reaches the logs or the audit row.
      const link = /https?:\/\/\S+\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(mailer.sent[0]?.text ?? "");
      const token = link?.[1] ?? "";
      expect(token).not.toBe("");
      expect(logged.join("\n")).not.toContain(token);
      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.scope, "platform"));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "platform.admin_bootstrapped", result: "success" });
      expect(JSON.stringify(audit)).not.toContain(token);

      // A second run (any email) changes nothing and is audited as denied; the chain still verifies.
      expect(await run(`second-${email}`)).toBe("refused");
      expect(await db.select().from(schema.platformRoleAssignment)).toHaveLength(1);
      const denied = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.scope, "platform"), eq(schema.auditLog.result, "denied")));
      expect(denied).toHaveLength(1);
      expect(denied[0]?.errorCode).toBe("admin_exists");
      expect(await verifyAuditScope(deps, "platform")).toBeNull();

      // The identity layer accepts the token once, stores an argon2id hash, and the password signs in.
      const auth = createAuth({
        db,
        secret: randomBytes(32).toString("base64url"),
        baseURL: ORIGIN,
        trustedOrigins: [ORIGIN],
        secureCookies: false,
        signUp: "closed",
        sendPasswordReset: async () => undefined,
        sealer: createKeyRing([{ id: "int", key: randomBytes(32) }]),
        relyingParty: { id: "localhost", name: "AnhourMail", origin: ORIGIN },
        trustProxy: false,
        security: {
          onEvent: async () => undefined,
          removalRefusal: async () => null,
          factors: async () => ({ totp: false, passkeys: 0 }),
          factorAdded: async () => undefined,
          codes: { claim: async () => true },
          passwordChanged: async () => undefined,
          sessionRefusal: async () => null,
        },
        breachedPasswords: memoryBreachedPasswords(),
      });
      const post = (p: string, body: unknown) =>
        auth.handler(
          new Request(`${ORIGIN}/api/auth${p}`, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
      // A password seen in a data breach is refused before the link is used up.
      const breached = await post("/reset-password", { token, newPassword: KNOWN_BREACHED_PASSWORDS[0] });
      expect(breached.status).toBe(400);
      expect(((await breached.json()) as { code?: string }).code).toBe("PASSWORD_BREACHED");
      const password = `${randomBytes(12).toString("base64url")}-Bs1`;
      expect((await post("/reset-password", { token, newPassword: password })).status).toBe(200);
      const [cred] = await db.select().from(schema.authAccount).where(eq(schema.authAccount.userId, user.id));
      expect(cred?.password).toMatch(/^\$argon2id\$/);
      expect((await post("/reset-password", { token, newPassword: `${password}x` })).status).toBe(400);
      expect((await post("/sign-in/email", { email, password })).status).toBe(200);
    } finally {
      setLogSinkForTests(null);
    }
  });
});
