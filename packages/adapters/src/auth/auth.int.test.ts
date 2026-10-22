// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The console identity stack against the test database (`npm run test:int`): better-auth with the two-factor,
 * passkey and our security plugin, through its HTTP handler like the app. Proves what reaches Postgres — a TOTP secret
 * sealed with the key ring and bound to its user, recovery codes as hashes only — and the plugin's checks.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";
import { memoryOneTime } from "@anhourmail/server/one-time";

import { systemClock } from "@anhourmail/core";
import { factorRemovalRefusal, sessionRefusalFor } from "@anhourmail/core/security";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { type AuthSecurityEvent, createAuth, hashPassword, hashRecoveryCode, totpAt } from ".";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (integration tests need the compose stack)");
const { db, pool } = createDb(url);
afterAll(() => pool.end());

const ORIGIN = "http://localhost:43299";
const events: AuthSecurityEvent[] = [];
const claimOnce = memoryOneTime();
const passwordChanges: { userId: string; via: string; keepSessionId: string | null; removePasskeys: boolean }[] = [];
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const factorsAdded: { userId: string; factor: string; firstFactor: boolean }[] = [];
let resetUrl = "";
const auth = createAuth({
  db,
  secret: randomBytes(32).toString("base64url"),
  baseURL: ORIGIN,
  trustedOrigins: [ORIGIN],
  secureCookies: false,
  signUp: "closed",
  sendPasswordReset: async ({ url }) => {
    resetUrl = url;
  },
  sealer: createKeyRing([{ id: "int", key: randomBytes(32) }]),
  relyingParty: { id: "localhost", name: "AnhourMail", origin: ORIGIN },
  trustProxy: false,
  security: {
    onEvent: async (e) => {
      events.push(e);
    },
    removalRefusal: (userId, factor) => deps.uow.run((r) => factorRemovalRefusal(r, userId, factor)),
    factors: (userId) => deps.uow.run((r) => r.security.factors(userId)),
    factorAdded: async (e) => {
      factorsAdded.push({ userId: e.userId, factor: e.factor, firstFactor: e.firstFactor });
    },
    codes: { claim: (userId, code) => claimOnce(`${userId}:${code}`, 120_000) },
    passwordChanged: async (e) => {
      passwordChanges.push(e);
    },
    sessionRefusal: (userId, method) => deps.uow.run((r) => sessionRefusalFor(r, userId, method)),
  },
});

/** A tiny cookie-keeping client for the auth handler. */
function client() {
  const jar = new Map<string, string>();
  return async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method,
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const i = pair.indexOf("=");
      if (/Max-Age=0/i.test(c)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  };
}

const base32 = (key: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = Array.from(key, (c) => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  return Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
};

describe("console sign-in factors at rest", () => {
  it("seals the TOTP secret, hashes recovery codes, and audits the steps", async () => {
    const email = `int-2fa-${randomUUID()}@example.com`;
    const password = `${randomBytes(12).toString("base64url")}-It1`;
    const userId = randomUUID();
    await db.insert(schema.authUser).values({ id: userId, name: "Int", email, emailVerified: true });
    await db.insert(schema.authAccount).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    });
    try {
      const call = client();
      expect((await call("POST", "/sign-in/email", { email, password })).status).toBe(200);
      const enabled = await call("POST", "/two-factor/enable", { password });
      expect(enabled.status).toBe(200);
      const codes = enabled.json?.backupCodes as string[];
      const key = base32(new URL(String(enabled.json?.totpURI)).searchParams.get("secret") ?? "");
      const step = Math.floor(Date.now() / 30_000);
      expect((await call("POST", "/two-factor/verify-totp", { code: totpAt(key, step) })).status).toBe(200);

      const [row] = await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, userId));
      expect(row?.secret).toMatch(/^v1\.int\./);
      expect(JSON.parse(row?.backupCodes ?? "[]")).toEqual(codes.map((c) => hashRecoveryCode(c)));
      for (const c of codes) expect(row?.backupCodes).not.toContain(c);

      // Already on: verifying again while signed in is refused; the used code is refused at sign-in too.
      expect((await call("POST", "/two-factor/verify-totp", { code: totpAt(key, step + 1) })).status).toBe(400);
      expect((await call("POST", "/sign-out", {})).status).toBe(200);
      const again = client();
      expect((await again("POST", "/sign-in/email", { email, password })).json).toMatchObject({
        twoFactorRedirect: true,
      });
      expect((await again("POST", "/two-factor/verify-totp", { code: totpAt(key, step) })).status).toBe(401);
      // A stored hash typed back in is refused, and so is asking for no session.
      const [stored] = await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, userId));
      const storedHash = (JSON.parse(stored?.backupCodes ?? "[]") as string[])[0];
      const reuse = await again("POST", "/two-factor/verify-backup-code", { code: storedHash });
      expect(reuse.status).toBe(401);
      expect(reuse.json?.code).toBe("INVALID_BACKUP_CODE");
      expect(
        (await again("POST", "/two-factor/verify-backup-code", { code: codes[3], disableSession: true })).status,
      ).toBe(400);
      expect(
        (await again("POST", "/two-factor/verify-backup-code", { code: codes[3]?.toLowerCase(), trustDevice: true }))
          .status,
      ).toBe(200);
      const [after] = await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, userId));
      expect(JSON.parse(after?.backupCodes ?? "[]")).toHaveLength(9);

      // Another browser trusted earlier.
      await db.insert(schema.authVerification).values({
        id: randomUUID(),
        identifier: `trust-device-${randomUUID()}`,
        value: userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      // Turning it off needs a valid second factor on top of the password.
      expect((await again("POST", "/two-factor/disable", { password, code: "000000" })).status).toBe(400);
      expect((await again("POST", "/two-factor/disable", { password, code: codes[4] })).status).toBe(200);
      expect(await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, userId))).toEqual([]);
      // Trusted browsers are forgotten too.
      const left = await db.select().from(schema.authVerification).where(eq(schema.authVerification.value, userId));
      expect(left.filter((v) => v.identifier.startsWith("trust-device-"))).toEqual([]);

      const mine = events.filter((e) => e.userId === userId).map((e) => `${e.action}:${e.denied ?? "ok"}`);
      expect(mine).toEqual([
        "auth.sign_in:ok",
        "auth.two_factor_enabled:ok",
        "auth.sign_out:ok",
        "auth.sign_in_failed:code_reused",
        "auth.sign_in_failed:invalid_backup_code",
        "auth.sign_in:ok",
        "auth.backup_code_used:ok",
        "auth.two_factor_disabled:invalid_code",
        "auth.two_factor_disabled:ok",
      ]);
      expect(JSON.stringify(events)).not.toContain(codes[3] ?? "x");
    } finally {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
    }
  });

  it("a sealed secret moved to another person's row is useless", async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      await db.insert(schema.authUser).values({ id, name: "Int", email: `int-move-${id}@example.com` });
    }
    try {
      const ctx = await auth.$context;
      await ctx.adapter.create({ model: "twoFactor", data: { userId: ids[0], secret: "s3cret", backupCodes: "[]" } });
      const [sealed] = await db
        .select()
        .from(schema.authTwoFactor)
        .where(eq(schema.authTwoFactor.userId, ids[0] ?? ""));
      await db
        .insert(schema.authTwoFactor)
        .values({ id: randomUUID(), userId: ids[1] ?? "", secret: sealed?.secret ?? "", backupCodes: "[]" });
      await expect(
        ctx.adapter.findOne({ model: "twoFactor", where: [{ field: "userId", value: ids[1] ?? "" }] }),
      ).rejects.toThrow();
    } finally {
      for (const id of ids) await db.delete(schema.authUser).where(eq(schema.authUser.id, id));
    }
  });

  it("a password change or reset reports the person so other sessions and trusted browsers go", async () => {
    const email = `int-pw-${randomUUID()}@example.com`;
    const password = `${randomBytes(12).toString("base64url")}-It1`;
    const userId = randomUUID();
    await db.insert(schema.authUser).values({ id: userId, name: "Int", email, emailVerified: true });
    await db.insert(schema.authAccount).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    });
    try {
      const call = client();
      expect((await call("POST", "/sign-in/email", { email, password })).status).toBe(200);
      const newPassword = `${password}-new`;
      const changed = await call("POST", "/change-password", {
        currentPassword: password,
        newPassword,
        revokeOtherSessions: true,
      });
      expect(changed.status).toBe(200);
      const [kept] = await db.select().from(schema.authSession).where(eq(schema.authSession.userId, userId));
      expect(passwordChanges.at(-1)).toEqual({
        userId,
        email,
        via: "change",
        keepSessionId: kept?.id,
        removePasskeys: false,
        userAgent: null,
      });
      // A wrong current password changes nothing and reports nothing.
      const before = passwordChanges.length;
      expect((await call("POST", "/change-password", { currentPassword: "nope-nope-nope", newPassword })).status).toBe(
        400,
      );
      expect(passwordChanges).toHaveLength(before);

      expect((await call("POST", "/request-password-reset", { email, redirectTo: "/reset-password" })).status).toBe(
        200,
      );
      const token = /reset-password\/([^?]+)/.exec(resetUrl)?.[1] ?? "";
      expect(token).not.toBe("");
      expect((await call("POST", "/reset-password", { token, newPassword: `${newPassword}-2` })).status).toBe(200);
      expect(passwordChanges.at(-1)).toEqual({
        userId,
        email,
        via: "reset",
        keepSessionId: null,
        removePasskeys: false,
        userAgent: null,
      });
    } finally {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
    }
  });

  it("records how sessions sign in, refuses the password alone under a requirement, strips tokens", async () => {
    const make = async (tag: string) => {
      const email = `int-method-${tag}-${randomUUID()}@example.com`;
      const id = randomUUID();
      await db.insert(schema.authUser).values({ id, name: "Int", email, emailVerified: true });
      await db.insert(schema.authAccount).values({
        id: randomUUID(),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: await hashPassword("correct-horse-battery"),
      });
      return { id, email };
    };
    const owner = await make("owner");
    const member = await make("member");
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `int-method ${randomUUID()}`, plan: "plus", signInPolicy: "two_factor" })
      .returning();
    try {
      await db.insert(schema.accountMembership).values([
        { accountId: account?.id ?? "", userId: owner.id, role: "owner" },
        { accountId: account?.id ?? "", userId: member.id, role: "member" },
      ]);
      // Nothing set up: the password signs in (the console's enrolment gate takes over); the method is recorded.
      const call = client();
      const ok = await call("POST", "/sign-in/email", { email: owner.email, password: "correct-horse-battery" });
      expect(ok.status).toBe(200);
      expect(ok.json).not.toHaveProperty("token");
      const [s1] = await db.select().from(schema.authSession).where(eq(schema.authSession.userId, owner.id));
      expect(s1?.signInMethod).toBe("password");

      // A fresh sign-in may add a passkey for a few minutes; without that marker a step-up is needed first.
      expect((await call("GET", "/passkey/generate-register-options")).status).toBe(200);
      expect((await call("POST", "/passkey/verify-registration", { response: {}, createSession: true })).status).toBe(
        400,
      );
      await db.delete(schema.authVerification).where(eq(schema.authVerification.identifier, `step-up-${s1?.id ?? ""}`));
      const blocked = await call("GET", "/passkey/generate-register-options");
      expect(blocked.status).toBe(403);
      expect(blocked.json?.code).toBe("STEP_UP_REQUIRED");
      expect((await call("POST", "/step-up", { password: "wrong-wrong-wrong" })).status).toBe(400);
      expect((await call("POST", "/step-up", { password: "correct-horse-battery" })).status).toBe(200);
      expect((await call("GET", "/passkey/generate-register-options")).status).toBe(200);

      // A member with a passkey (and no authenticator app) can't get a session with the password alone.
      await db.insert(schema.authPasskey).values({
        id: randomUUID(),
        userId: member.id,
        publicKey: "public-key",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
      });
      const refused = await client()("POST", "/sign-in/email", {
        email: member.email,
        password: "correct-horse-battery",
      });
      expect(refused.status).toBe(403);
      expect(refused.json?.code).toBe("SIGN_IN_METHOD_REQUIRED");
      expect(String(refused.json?.message)).toMatch(/Sign in with your passkey or set up an authenticator app/);
      expect(await db.select().from(schema.authSession).where(eq(schema.authSession.userId, member.id))).toEqual([]);
      expect(events.filter((e) => e.userId === member.id).map((e) => `${e.action}:${e.denied ?? "ok"}`)).toEqual([
        "auth.sign_in_failed:sign_in_requirement",
      ]);
    } finally {
      for (const u of [owner, member]) await db.delete(schema.authUser).where(eq(schema.authUser.id, u.id));
      await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, account?.id ?? ""));
    }
  });

  it("closes the reset-and-replace-passkeys path, gates refused sessions, counts step-up failures", async () => {
    const password = "correct-horse-battery";
    const make = async (tag: string) => {
      const email = `int-n-${tag}-${randomUUID()}@example.com`;
      const id = randomUUID();
      await db.insert(schema.authUser).values({ id, name: "Int", email, emailVerified: true });
      await db.insert(schema.authAccount).values({
        id: randomUUID(),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: await hashPassword(password),
      });
      return { id, email };
    };
    const addPasskey = (userId: string) =>
      db.insert(schema.authPasskey).values({
        id: randomUUID(),
        userId,
        publicKey: "public-key",
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
      });
    const sessionsOf = (userId: string) =>
      db.select().from(schema.authSession).where(eq(schema.authSession.userId, userId));
    const victim = await make("victim");
    const solo = await make("solo");
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `int-n ${randomUUID()}`, plan: "plus" })
      .returning();
    const accountId = account?.id ?? "";
    try {
      await db.insert(schema.accountMembership).values({ accountId, userId: victim.id, role: "member" });

      // N2: a session signed in with the password alone, then the requirement arrives and the person has a passkey:
      // that session can't step up or add anything; it is ended (401).
      const call = client();
      expect((await call("POST", "/sign-in/email", { email: victim.email, password })).status).toBe(200);
      await addPasskey(victim.id);
      await db
        .update(schema.customerAccount)
        .set({ signInPolicy: "passkey" })
        .where(eq(schema.customerAccount.id, accountId));
      const gated = await call("POST", "/step-up", { password });
      expect(gated.status).toBe(401);
      expect(gated.json?.code).toBe("SIGN_IN_METHOD_REQUIRED");
      expect(await sessionsOf(victim.id)).toEqual([]);

      // N1a: a reset can't strip the passkeys the requirement depends on (and the password stays as it was).
      expect(
        (await call("POST", "/request-password-reset", { email: victim.email, redirectTo: "/reset-password" })).status,
      ).toBe(200);
      const token = /reset-password\/([^?]+)/.exec(resetUrl)?.[1] ?? "";
      const refused = await call("POST", "/reset-password", {
        token,
        newPassword: `${password}-x`,
        removePasskeys: true,
      });
      expect(refused.status).toBe(400);
      expect(refused.json?.code).toBe("FACTOR_REQUIRED");
      expect(String(refused.json?.message)).toMatch(/Ask an Owner/);
      expect((await db.select().from(schema.authPasskey).where(eq(schema.authPasskey.userId, victim.id))).length).toBe(
        1,
      );
      expect((await client()("POST", "/sign-in/email", { email: victim.email, password })).status).toBe(403);

      // N1b: someone with a factor who signs in with the password alone gets no step-up from it, and the password
      // can't be the step-up either.
      await addPasskey(solo.id);
      const s2 = client();
      expect((await s2("POST", "/sign-in/email", { email: solo.email, password })).status).toBe(200);
      expect((await s2("GET", "/passkey/generate-register-options")).json?.code).toBe("STEP_UP_REQUIRED");
      expect((await s2("POST", "/step-up", { password })).json?.code).toBe("STEP_UP_NEEDS_FACTOR");

      // V-c: a passkey session that turns on an authenticator keeps `passkey`; the first factor is announced only
      // under a requirement (none here: solo already had a passkey, so not a first factor anyway).
      const [soloSession] = await sessionsOf(solo.id);
      await db
        .update(schema.authSession)
        .set({ signInMethod: "passkey" })
        .where(eq(schema.authSession.id, soloSession?.id ?? ""));
      const enabled = await s2("POST", "/two-factor/enable", { password });
      const key = base32(new URL(String(enabled.json?.totpURI)).searchParams.get("secret") ?? "");
      const step = Math.floor(Date.now() / 30_000);
      expect((await s2("POST", "/two-factor/verify-totp", { code: totpAt(key, step) })).status).toBe(200);
      const after = await sessionsOf(solo.id);
      expect(after.map((x) => x.signInMethod)).toEqual(["passkey"]);
      // Solo already had a passkey before this request: not a first factor.
      expect(factorsAdded.filter((f) => f.userId === solo.id)).toEqual([
        { userId: solo.id, factor: "totp", firstFactor: false },
      ]);

      // V-b: wrong codes on step-up count toward the same lockout as the second sign-in step, and a session that
      // keeps failing is signed out after 5 (so a stolen session can't keep the real person locked out).
      const signInWithCode = async (code: string) => {
        const c = client();
        expect((await c("POST", "/sign-in/email", { email: solo.email, password })).json?.twoFactorRedirect).toBe(true);
        expect((await c("POST", "/two-factor/verify-totp", { code })).status).toBe(200);
        return c;
      };
      // Sign the extra sessions in first: a successful second step resets the account's failure count.
      const s3 = await signInWithCode(totpAt(key, step - 1));
      const [s3Id] = (await sessionsOf(solo.id)).map((x) => x.id).filter((id) => !after.some((a) => a.id === id));
      const s4 = await signInWithCode(totpAt(key, step + 1));
      for (let i = 0; i < 4; i++) expect((await s2("POST", "/step-up", { code: "000000" })).status).toBe(400);
      for (let i = 0; i < 4; i++) expect((await s3("POST", "/step-up", { code: "000000" })).status).toBe(400);
      const ended = await s3("POST", "/step-up", { code: "000000" });
      expect(ended.status).toBe(401);
      expect(ended.json?.code).toBe("STEP_UP_SESSION_ENDED");
      expect((await sessionsOf(solo.id)).some((x) => x.id === s3Id)).toBe(false);
      expect(
        events.some(
          (e) => e.userId === solo.id && e.action === "auth.session_revoked" && e.meta?.reason === "step_up_failures",
        ),
      ).toBe(true);
      expect((await s4("POST", "/step-up", { code: "000000" })).status).toBe(400);
      const locked = await s4("POST", "/step-up", { code: "000000" });
      expect(locked.status).toBe(429);
      expect(locked.json?.code).toBe("ACCOUNT_TEMPORARILY_LOCKED");
      const [tf] = await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, solo.id));
      expect(tf?.lockedUntil).not.toBeNull();
    } finally {
      for (const u of [victim, solo]) await db.delete(schema.authUser).where(eq(schema.authUser.id, u.id));
      await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
    }
  });
});
