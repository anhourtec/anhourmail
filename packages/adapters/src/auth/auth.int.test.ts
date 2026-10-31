// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The console identity stack against the test database (`npm run test:int`): better-auth with the two-factor,
 * passkey and our security plugin, through its HTTP handler like the app. Proves what reaches Postgres — a TOTP secret
 * sealed with the key ring and bound to its user, recovery codes as hashes only — and the plugin's checks.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { afterAll, describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";
import { memoryOneTime, memoryStrikes } from "@anhourmail/server/one-time";

import { systemClock } from "@anhourmail/core";
import { factorRemovalRefusal, sessionRefusalFor } from "@anhourmail/core/security";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { createDb, schema } from "../db-postgres/client";
import { KNOWN_BREACHED_PASSWORDS, memoryBreachedPasswords } from "../memory/breached-passwords";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { type AuthSecurityEvent, createAuth, hashPassword, hashRecoveryCode, totpAt } from ".";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (integration tests need the compose stack)");
const { db, pool } = createDb(url);
afterAll(() => pool.end());

const ORIGIN = "http://localhost:43299";
const events: AuthSecurityEvent[] = [];
const claimOnce = memoryOneTime();
const strikes = memoryStrikes();
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
    strikes: (key, ttlMs) => strikes(key, ttlMs),
    passwordChanged: async (e) => {
      passwordChanges.push(e);
    },
    sessionRefusal: (userId, method) => deps.uow.run((r) => sessionRefusalFor(r, userId, method)),
  },
  breachedPasswords: memoryBreachedPasswords(),
});

/** A tiny cookie-keeping client for the auth handler. */
function client(a: typeof auth = auth) {
  const jar = new Map<string, string>();
  return async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await a.handler(
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

/**
 * A software passkey (P-256, user verified) for the WebAuthn checks: `cose` is the public key as the passkey plugin
 * stores it, `assert` answers an authentication challenge for the int-test origin.
 */
function softPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  // CBOR map {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  const credentialID = randomBytes(16).toString("base64url");
  let counter = 0;
  return {
    credentialID,
    publicKey: cose.toString("base64"),
    /** A registration answer ("none" attestation, user verified) for a challenge from the register options. */
    attest(challenge: string) {
      const credId = Buffer.from(credentialID, "base64url");
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credId.length);
      const authData = Buffer.concat([
        createHash("sha256").update("localhost").digest(),
        Buffer.from([0x45]), // user present + user verified + attested credential data
        Buffer.alloc(4),
        Buffer.alloc(16), // AAGUID
        idLength,
        credId,
        cose,
      ]);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(authData.length);
      // CBOR {"fmt": "none", "attStmt": {}, "authData": bytes}
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3, 0x63]),
        Buffer.from("fmt"),
        Buffer.from([0x64]),
        Buffer.from("none"),
        Buffer.from([0x67]),
        Buffer.from("attStmt"),
        Buffer.from([0xa0, 0x68]),
        Buffer.from("authData"),
        Buffer.from([0x59]),
        length,
        authData,
      ]);
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false }),
      );
      return {
        id: credentialID,
        rawId: credentialID,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData.toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    assert(challenge: string, opts: { tamper?: boolean } = {}) {
      counter += 1;
      const flags = Buffer.from([0x05]); // user present + user verified
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([createHash("sha256").update("localhost").digest(), flags, count]);
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
      );
      const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
      const signature = createSign("SHA256").update(signed).sign(privateKey);
      if (opts.tamper) signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 0xff;
      return {
        id: credentialID,
        rawId: credentialID,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          authenticatorData: authData.toString("base64url"),
          clientDataJSON: clientData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}

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
        "auth.second_step_started:ok",
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

      // A member with a passkey (and no authenticator app) gets no session from the password alone: the passkey step
      // follows (ADR-0028).
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
      expect(refused.status).toBe(200);
      expect(refused.json).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["passkey"] });
      expect(await db.select().from(schema.authSession).where(eq(schema.authSession.userId, member.id))).toEqual([]);
      expect(events.filter((e) => e.userId === member.id).map((e) => `${e.action}:${e.denied ?? "ok"}`)).toEqual([
        "auth.second_step_started:ok",
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
      // The password alone still gets no session: the passkey step follows.
      const victimAgain = await client()("POST", "/sign-in/email", { email: victim.email, password });
      expect(victimAgain.json).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["passkey"] });
      expect(await sessionsOf(victim.id)).toEqual([]);

      // N1b, changed by ADR-0028: step-up is the console password, for someone with a passkey too (the regression:
      // "Sign out and sign in again with your passkey" refused a correct password). Codes are refused.
      const s2 = client();
      expect((await s2("POST", "/sign-in/email", { email: solo.email, password })).status).toBe(200);
      await addPasskey(solo.id);
      const [s2Session] = await sessionsOf(solo.id);
      await db
        .delete(schema.authVerification)
        .where(eq(schema.authVerification.identifier, `step-up-${s2Session?.id ?? ""}`));
      expect((await s2("GET", "/passkey/generate-register-options")).json?.code).toBe("STEP_UP_REQUIRED");
      const withCode = await s2("POST", "/step-up", { code: "123456" });
      expect(withCode.status).toBe(400);
      expect(withCode.json?.code).toBe("STEP_UP_PASSWORD_ONLY");
      expect((await s2("POST", "/step-up", { password })).status).toBe(200);
      expect((await s2("GET", "/passkey/generate-register-options")).status).toBe(200);

      // V-c: a passkey session that turns on an authenticator keeps `password+passkey`; the first factor is announced only
      // under a requirement (none here: solo already had a passkey, so not a first factor anyway).
      const [soloSession] = await sessionsOf(solo.id);
      await db
        .update(schema.authSession)
        .set({ signInMethod: "password+passkey" })
        .where(eq(schema.authSession.id, soloSession?.id ?? ""));
      const enabled = await s2("POST", "/two-factor/enable", { password });
      const key = base32(new URL(String(enabled.json?.totpURI)).searchParams.get("secret") ?? "");
      const step = Math.floor(Date.now() / 30_000);
      expect((await s2("POST", "/two-factor/verify-totp", { code: totpAt(key, step) })).status).toBe(200);
      const after = await sessionsOf(solo.id);
      expect(after.map((x) => x.signInMethod)).toEqual(["password+passkey"]);
      // Solo already had a passkey before this request: not a first factor.
      expect(factorsAdded.filter((f) => f.userId === solo.id)).toEqual([
        { userId: solo.id, factor: "totp", firstFactor: false },
      ]);

      // V-b: wrong passwords on step-up count toward the same lockout as the second sign-in step, and a session that
      // keeps failing is signed out after 5 (so a stolen session can't keep the real person locked out).
      const signInWithCode = async (code: string) => {
        const c = client();
        // Authenticator app and passkey: every method is offered on the second step.
        expect((await c("POST", "/sign-in/email", { email: solo.email, password })).json).toEqual({
          twoFactorRedirect: true,
          twoFactorMethods: ["passkey", "totp", "recovery_code"],
        });
        expect((await c("POST", "/two-factor/verify-totp", { code })).status).toBe(200);
        return c;
      };
      // Sign the extra sessions in first: a successful second step resets the account's failure count.
      const s3 = await signInWithCode(totpAt(key, step - 1));
      const [s3Id] = (await sessionsOf(solo.id)).map((x) => x.id).filter((id) => !after.some((a) => a.id === id));
      const s4 = await signInWithCode(totpAt(key, step + 1));
      for (let i = 0; i < 4; i++)
        expect((await s2("POST", "/step-up", { password: "wrong-wrong-wrong" })).status).toBe(400);
      for (let i = 0; i < 4; i++)
        expect((await s3("POST", "/step-up", { password: "wrong-wrong-wrong" })).status).toBe(400);
      const ended = await s3("POST", "/step-up", { password: "wrong-wrong-wrong" });
      expect(ended.status).toBe(401);
      expect(ended.json?.code).toBe("STEP_UP_SESSION_ENDED");
      expect((await sessionsOf(solo.id)).some((x) => x.id === s3Id)).toBe(false);
      expect(
        events.some(
          (e) => e.userId === solo.id && e.action === "auth.session_revoked" && e.meta?.reason === "password_failures",
        ),
      ).toBe(true);
      expect((await s4("POST", "/step-up", { password: "wrong-wrong-wrong" })).status).toBe(400);
      const locked = await s4("POST", "/step-up", { password: "wrong-wrong-wrong" });
      expect(locked.status).toBe(429);
      expect(locked.json?.code).toBe("ACCOUNT_TEMPORARILY_LOCKED");
      const [tf] = await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, solo.id));
      expect(tf?.lockedUntil).not.toBeNull();
    } finally {
      for (const u of [victim, solo]) await db.delete(schema.authUser).where(eq(schema.authUser.id, u.id));
      await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
    }
  });

  it("password first, then the person's own passkey; no passwordless passkey; step-up by password (ADR-0028)", async () => {
    const password = "correct-horse-battery";
    const make = async (tag: string) => {
      const email = `int-pk-${tag}-${randomUUID()}@example.com`;
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
    const register = async (userId: string) => {
      const key = softPasskey();
      await db.insert(schema.authPasskey).values({
        id: randomUUID(),
        userId,
        name: "Soft key",
        publicKey: key.publicKey,
        credentialID: key.credentialID,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      });
      return key;
    };
    const sessionsOf = (userId: string) =>
      db.select().from(schema.authSession).where(eq(schema.authSession.userId, userId));
    const kim = await make("kim");
    const lee = await make("lee");
    const kimKey = await register(kim.id);
    const leeKey = await register(lee.id);
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `int-pk ${randomUUID()}`, plan: "plus" })
      .returning();
    const accountId = account?.id ?? "";
    try {
      // No passwordless passkey sign-in: without the password step, both passkey endpoints answer 401.
      const stranger = client();
      const noOptions = await stranger("GET", "/passkey/generate-authenticate-options");
      expect(noOptions.status).toBe(401);
      expect(noOptions.json?.code).toBe("PASSWORD_FIRST");
      const noVerify = await stranger("POST", "/passkey/verify-authentication", { response: kimKey.assert("x") });
      expect(noVerify.status).toBe(401);
      expect(noVerify.json?.code).toBe("PASSWORD_FIRST");
      expect(events.some((e) => e.denied === "password_first" && e.meta?.method === "passkey")).toBe(true);

      // A wrong password: no second step.
      const call = client();
      expect((await call("POST", "/sign-in/email", { email: kim.email, password: "wrong-wrong-wrong" })).status).toBe(
        401,
      );
      // The right one: the passkey step, no session yet.
      const first = await call("POST", "/sign-in/email", { email: kim.email, password });
      expect(first.status).toBe(200);
      expect(first.json).toEqual({ twoFactorRedirect: true, twoFactorMethods: ["passkey"] });
      expect(await sessionsOf(kim.id)).toEqual([]);

      // The options ask for Kim's own passkey, with the person check.
      const options = await call("GET", "/passkey/generate-authenticate-options");
      expect(options.status).toBe(200);
      expect(options.json?.userVerification).toBe("required");
      expect(options.json?.allowCredentials).toEqual([{ id: kimKey.credentialID, type: "public-key" }]);
      // Someone else's passkey is refused before it is checked (and counts as a wrong attempt).
      const other = await call("POST", "/passkey/verify-authentication", {
        response: leeKey.assert(String(options.json?.challenge)),
      });
      expect(other.status).toBe(401);
      expect(other.json?.code).toBe("PASSKEY_NOT_FOUND");
      expect(await sessionsOf(lee.id)).toEqual([]);

      // Kim's own passkey finishes the sign-in: password+passkey, no token or passkey material in the answer.
      const again = await call("GET", "/passkey/generate-authenticate-options");
      const done = await call("POST", "/passkey/verify-authentication", {
        response: kimKey.assert(String(again.json?.challenge)),
      });
      expect(done.status).toBe(200);
      expect(done.json).not.toHaveProperty("session");
      expect(done.json).not.toHaveProperty("token");
      const [kimSession] = await sessionsOf(kim.id);
      expect(kimSession?.signInMethod).toBe("password+passkey");
      // The challenge is used up.
      expect((await call("GET", "/passkey/generate-authenticate-options")).json?.code).toBe("PASSWORD_FIRST");
      expect(
        events
          .filter((e) => e.userId === kim.id)
          .map((e) => `${e.action}:${e.denied ?? "ok"}:${String(e.meta?.method)}`),
      ).toEqual([
        "auth.sign_in_failed:invalid_email_or_password:password",
        "auth.second_step_started:ok:undefined",
        "auth.sign_in_failed:passkey_not_found:passkey",
        "auth.sign_in:ok:password+passkey",
      ]);
      expect(events.find((e) => e.action === "auth.second_step_started" && e.userId === kim.id)?.meta).toEqual({
        methods: ["passkey"],
      });

      // The regression: a correct console password confirms it's you in a password+passkey session; a code is refused.
      for (const method of ["password+passkey", "password+passkey"] as const) {
        await db.update(schema.authSession).set({ signInMethod: method }).where(eq(schema.authSession.userId, kim.id));
        await db
          .delete(schema.authVerification)
          .where(eq(schema.authVerification.identifier, `step-up-${kimSession?.id ?? ""}`));
        expect((await call("GET", "/passkey/generate-register-options")).json?.code).toBe("STEP_UP_REQUIRED");
        expect((await call("POST", "/step-up", { code: "123456" })).json?.code).toBe("STEP_UP_PASSWORD_ONLY");
        const confirmed = await call("POST", "/step-up", { password });
        expect(confirmed.status).toBe(200);
        expect((await call("GET", "/passkey/generate-register-options")).status).toBe(200);
      }
      expect(
        events
          .filter((e) => e.userId === kim.id && e.action === "auth.identity_confirmed")
          .map((e) => `${e.denied ?? "ok"}:${String(e.meta?.method)}`),
      ).toEqual(["password_only:password", "ok:password", "password_only:password", "ok:password"]);

      // Wrong passkey answers: 5 per challenge, then the sign-in starts again.
      const tries = client();
      expect((await tries("POST", "/sign-in/email", { email: kim.email, password })).json?.twoFactorRedirect).toBe(
        true,
      );
      for (let i = 0; i < 5; i++) {
        const o = await tries("GET", "/passkey/generate-authenticate-options");
        const bad = await tries("POST", "/passkey/verify-authentication", {
          response: kimKey.assert(String(o.json?.challenge), { tamper: true }),
        });
        expect(bad.status).toBeGreaterThanOrEqual(400);
      }
      const o6 = await tries("GET", "/passkey/generate-authenticate-options");
      const sixth = await tries("POST", "/passkey/verify-authentication", {
        response: kimKey.assert(String(o6.json?.challenge)),
      });
      expect(sixth.json?.code).toBe("TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE");
      expect((await tries("GET", "/passkey/generate-authenticate-options")).json?.code).toBe("PASSWORD_FIRST");
      expect((await sessionsOf(kim.id)).length).toBe(1);
      // A passwordless `passkey` session from before ADR-0028 is ended on its next request: sign in again.
      await db.update(schema.authSession).set({ signInMethod: "passkey" }).where(eq(schema.authSession.userId, kim.id));
      const legacy = await call("POST", "/step-up", { password });
      expect(legacy.status).toBe(401);
      expect(legacy.json?.code).toBe("SIGN_IN_METHOD_REQUIRED");
      expect(await sessionsOf(kim.id)).toEqual([]);

      // Under a passkey requirement, someone with an authenticator app too is offered only the passkey.
      await db.insert(schema.accountMembership).values({ accountId, userId: lee.id, role: "owner" });
      await db.delete(schema.authPasskey).where(eq(schema.authPasskey.userId, lee.id));
      const leeCall = client();
      expect((await leeCall("POST", "/sign-in/email", { email: lee.email, password })).status).toBe(200);
      const enabled = await leeCall("POST", "/two-factor/enable", { password });
      const totpKey = base32(new URL(String(enabled.json?.totpURI)).searchParams.get("secret") ?? "");
      const step = Math.floor(Date.now() / 30_000);
      expect((await leeCall("POST", "/two-factor/verify-totp", { code: totpAt(totpKey, step) })).status).toBe(200);
      const leeKey2 = await register(lee.id);
      await db
        .update(schema.customerAccount)
        .set({ signInPolicy: "passkey" })
        .where(eq(schema.customerAccount.id, accountId));
      const leeAgain = client();
      expect((await leeAgain("POST", "/sign-in/email", { email: lee.email, password })).json).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ["passkey"],
      });
      // Only the passkey is offered, and it finishes the sign-in.
      const o = await leeAgain("GET", "/passkey/generate-authenticate-options");
      const leeDone = await leeAgain("POST", "/passkey/verify-authentication", {
        response: leeKey2.assert(String(o.json?.challenge)),
      });
      expect(leeDone.status).toBe(200);
      expect((await sessionsOf(lee.id)).map((x) => x.signInMethod)).toContain("password+passkey");
    } finally {
      for (const u of [kim, lee]) await db.delete(schema.authUser).where(eq(schema.authUser.id, u.id));
      await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
    }
  });

  it("recovery codes come with a first passkey; trusted browsers on the passkey step (ADR-0028)", async () => {
    const password = "correct-horse-battery";
    const make = async (tag: string) => {
      const email = `int-rc-${tag}-${randomUUID()}@example.com`;
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
    const ana = await make("ana");
    const old = await make("old");
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `int-rc ${randomUUID()}`, plan: "plus" })
      .returning();
    const accountId = account?.id ?? "";
    const rowOf = async (userId: string) =>
      (await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, userId)))[0];
    const hashesOf = async (userId: string) => JSON.parse((await rowOf(userId))?.backupCodes ?? "[]") as string[];
    const factorsOf = (userId: string) => deps.uow.run((r) => r.security.factors(userId));
    const methodsOf = async (userId: string) =>
      (await db.select().from(schema.authSession).where(eq(schema.authSession.userId, userId))).map(
        (x) => x.signInMethod,
      );
    try {
      // A first passkey (a real registration) comes with recovery codes, shown once, stored as hashes; no
      // authenticator is turned on.
      const s1 = client();
      expect((await s1("POST", "/sign-in/email", { email: ana.email, password })).status).toBe(200);
      const key = softPasskey();
      const regOptions = await s1("GET", "/passkey/generate-register-options");
      const registered = await s1("POST", "/passkey/verify-registration", {
        response: key.attest(String(regOptions.json?.challenge)),
        name: "Soft key",
      });
      expect(registered.status).toBe(200);
      expect(registered.json).not.toHaveProperty("publicKey");
      const codes = registered.json?.recoveryCodes as string[];
      // Registering upgrades the session to password+passkey but uses the step-up up: it is not a fresh confirmation.
      expect((await s1("GET", "/passkey/generate-register-options")).json?.code).toBe("STEP_UP_REQUIRED");
      expect(codes).toHaveLength(10);
      expect(await hashesOf(ana.id)).toEqual(codes.map((c) => hashRecoveryCode(c)));
      expect((await rowOf(ana.id))?.verified).toBe(false);
      expect(await factorsOf(ana.id)).toEqual({ totp: false, passkeys: 1, recoveryCodesLeft: 10 });
      expect(
        events.some(
          (e) => e.userId === ana.id && e.action === "auth.recovery_codes_regenerated" && e.meta?.firstFactor === true,
        ),
      ).toBe(true);

      // The second step offers the passkey and a recovery code; a recovery code signs in (and is used up).
      const s2 = client();
      expect((await s2("POST", "/sign-in/email", { email: ana.email, password })).json).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ["passkey", "recovery_code"],
      });
      // The row never accepts an authenticator code.
      expect((await s2("POST", "/two-factor/verify-totp", { code: "123456" })).status).toBeGreaterThanOrEqual(400);
      expect((await s2("POST", "/two-factor/verify-backup-code", { code: codes[0] })).status).toBe(200);
      expect(await methodsOf(ana.id)).toContain("password+recovery_code");
      expect(await hashesOf(ana.id)).toHaveLength(9);

      // "Trust this browser" on the passkey step: the next sign-in in this browser skips the second step.
      const s3 = client();
      expect((await s3("POST", "/sign-in/email", { email: ana.email, password })).json?.twoFactorRedirect).toBe(true);
      const o = await s3("GET", "/passkey/generate-authenticate-options");
      const trusted = await s3("POST", "/passkey/verify-authentication", {
        response: key.assert(String(o.json?.challenge)),
        trustDevice: true,
      });
      expect(trusted.status).toBe(200);
      const skipped = await s3("POST", "/sign-in/email", { email: ana.email, password });
      expect(skipped.status).toBe(200);
      expect(skipped.json).not.toHaveProperty("twoFactorRedirect");
      expect(await methodsOf(ana.id)).toContain("password+trusted_device");
      // Another browser isn't trusted.
      expect((await client()("POST", "/sign-in/email", { email: ana.email, password })).json?.twoFactorRedirect).toBe(
        true,
      );
      // A passkey requirement still refuses the trusted browser: the passkey step again, and only it.
      await db.insert(schema.accountMembership).values({ accountId, userId: ana.id, role: "owner" });
      await db
        .update(schema.customerAccount)
        .set({ signInPolicy: "passkey" })
        .where(eq(schema.customerAccount.id, accountId));
      expect((await s3("POST", "/sign-in/email", { email: ana.email, password })).json).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ["passkey"],
      });
      await db.delete(schema.accountMembership).where(eq(schema.accountMembership.userId, ana.id));

      // New codes with the password; the old ones stop working.
      const wrong = await s1("POST", "/recovery-codes/generate", { password: "wrong-wrong-wrong" });
      expect(wrong.json?.code).toBe("INVALID_PASSWORD");
      const fresh = await s1("POST", "/recovery-codes/generate", { password });
      expect(fresh.status).toBe(200);
      const codes2 = fresh.json?.backupCodes as string[];
      expect(await hashesOf(ana.id)).toEqual(codes2.map((c) => hashRecoveryCode(c)));
      const s4 = client();
      await s4("POST", "/sign-in/email", { email: ana.email, password });
      expect((await s4("POST", "/two-factor/verify-backup-code", { code: codes[1] })).status).toBe(401);

      // A set-up that ran out of time can't be finished (its codes would never take over): it starts again.
      const stale = await s1("POST", "/two-factor/enable", { password });
      await db
        .update(schema.authVerification)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.authVerification.identifier, `totp-setup-${ana.id}`));
      const staleKey = base32(new URL(String(stale.json?.totpURI)).searchParams.get("secret") ?? "");
      const late = await s1("POST", "/two-factor/verify-totp", {
        code: totpAt(staleKey, Math.floor(Date.now() / 30_000)),
      });
      expect(late.json?.code).toBe("NO_SETUP_PENDING");
      expect(await hashesOf(ana.id)).toEqual(codes2.map((c) => hashRecoveryCode(c)));

      // Turning an authenticator on: the saved codes keep working until the set-up is finished, then the codes shown
      // with it replace them. A browser trusted on the passkey step is honoured by the authenticator's sign-in too.
      const enabled = await s1("POST", "/two-factor/enable", { password });
      const codes3 = enabled.json?.backupCodes as string[];
      expect(await hashesOf(ana.id)).toEqual(codes2.map((c) => hashRecoveryCode(c)));
      const totpKey = base32(new URL(String(enabled.json?.totpURI)).searchParams.get("secret") ?? "");
      const step = Math.floor(Date.now() / 30_000);
      expect((await s1("POST", "/two-factor/verify-totp", { code: totpAt(totpKey, step) })).status).toBe(200);
      expect(await hashesOf(ana.id)).toEqual(codes3.map((c) => hashRecoveryCode(c)));
      expect(await factorsOf(ana.id)).toMatchObject({ totp: true, passkeys: 1 });
      // With an authenticator app, the app's own "New recovery codes" is the way.
      expect((await s1("POST", "/recovery-codes/generate", { password })).json?.code).toBe("USE_AUTHENTICATOR_CODES");
      const s5 = client();
      expect((await s5("POST", "/sign-in/email", { email: ana.email, password })).json).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ["passkey", "totp", "recovery_code"],
      });
      const o5 = await s5("GET", "/passkey/generate-authenticate-options");
      expect(
        (
          await s5("POST", "/passkey/verify-authentication", {
            response: key.assert(String(o5.json?.challenge)),
            trustDevice: true,
          })
        ).status,
      ).toBe(200);
      const pluginSkipped = await s5("POST", "/sign-in/email", { email: ana.email, password });
      expect(pluginSkipped.json).not.toHaveProperty("twoFactorRedirect");

      // Turning it off while a passkey stays: the codes stay too.
      const off = await s1("POST", "/two-factor/disable", { password, code: totpAt(totpKey, step + 1) });
      expect(off.status).toBe(200);
      expect((await rowOf(ana.id))?.verified).toBe(false);
      expect(await hashesOf(ana.id)).toEqual(codes3.map((c) => hashRecoveryCode(c)));
      expect(await factorsOf(ana.id)).toEqual({ totp: false, passkeys: 1, recoveryCodesLeft: 10 });

      // Someone who added a passkey before codes came with it has none, and can create a set.
      const oldKey = softPasskey();
      await db.insert(schema.authPasskey).values({
        id: randomUUID(),
        userId: old.id,
        publicKey: oldKey.publicKey,
        credentialID: oldKey.credentialID,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      });
      expect(await factorsOf(old.id)).toEqual({ totp: false, passkeys: 1, recoveryCodesLeft: 0 });
      const s6 = client();
      expect((await s6("POST", "/sign-in/email", { email: old.email, password })).json).toEqual({
        twoFactorRedirect: true,
        twoFactorMethods: ["passkey"],
      });
      const o6 = await s6("GET", "/passkey/generate-authenticate-options");
      expect(
        (await s6("POST", "/passkey/verify-authentication", { response: oldKey.assert(String(o6.json?.challenge)) }))
          .status,
      ).toBe(200);
      const created = await s6("POST", "/recovery-codes/generate", { password });
      expect(created.status).toBe(200);
      expect(created.json?.backupCodes).toHaveLength(10);
      expect(await factorsOf(old.id)).toEqual({ totp: false, passkeys: 1, recoveryCodesLeft: 10 });
    } finally {
      for (const u of [ana, old]) await db.delete(schema.authUser).where(eq(schema.authUser.id, u.id));
      await db.delete(schema.customerAccount).where(eq(schema.customerAccount.id, accountId));
    }
  });

  it("security review: no code guessing outside a set-up, password strikes per session, atomic, audited refusals", async () => {
    const password = "correct-horse-battery";
    const make = async (tag: string) => {
      const email = `int-sr-${tag}-${randomUUID()}@example.com`;
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
    const eve = await make("eve");
    const max = await make("max");
    const rowOf = async (userId: string) =>
      (await db.select().from(schema.authTwoFactor).where(eq(schema.authTwoFactor.userId, userId)))[0];
    const sessionsOf = (userId: string) =>
      db.select().from(schema.authSession).where(eq(schema.authSession.userId, userId));
    const deniedOf = (userId: string) =>
      events.filter((e) => e.userId === userId && e.denied).map((e) => `${e.action}:${e.denied ?? ""}`);
    try {
      // Eve's second factor is a passkey, with recovery codes in an unverified row whose secret nobody was shown.
      const s1 = client();
      expect((await s1("POST", "/sign-in/email", { email: eve.email, password })).status).toBe(200);
      const key = softPasskey();
      const reg = await s1("GET", "/passkey/generate-register-options");
      expect(
        (await s1("POST", "/passkey/verify-registration", { response: key.attest(String(reg.json?.challenge)) }))
          .status,
      ).toBe(200);
      expect((await rowOf(eve.id))?.verified).toBe(false);

      // 1. A signed-in code with no set-up pending is refused before it is checked (no guessing that row's secret).
      for (const code of ["000000", "123456"]) {
        const guess = await s1("POST", "/two-factor/verify-totp", { code });
        expect(guess.status).toBe(400);
        expect(guess.json?.code).toBe("NO_SETUP_PENDING");
      }
      expect((await rowOf(eve.id))?.verified).toBe(false);
      expect(deniedOf(eve.id)).toContain("auth.two_factor_enabled:no_setup_pending");
      // Turning "off" an authenticator that isn't on is refused, and the codes stay.
      const off = await s1("POST", "/two-factor/disable", { password, code: "000000" });
      expect(off.json?.code).toBe("TWO_FACTOR_NOT_ENABLED");
      expect(await rowOf(eve.id)).toBeDefined();

      // A set-up started in one session can't be finished from another; wrong codes finishing it count toward the
      // lockout; new recovery codes wait until it is done.
      const enabled = await s1("POST", "/two-factor/enable", { password });
      expect(enabled.status).toBe(200);
      const s2 = client();
      const beforeS2 = (await sessionsOf(eve.id)).map((x) => x.id);
      await s2("POST", "/sign-in/email", { email: eve.email, password });
      const o = await s2("GET", "/passkey/generate-authenticate-options");
      expect(
        (await s2("POST", "/passkey/verify-authentication", { response: key.assert(String(o.json?.challenge)) }))
          .status,
      ).toBe(200);
      const s2Id = (await sessionsOf(eve.id)).map((x) => x.id).find((id) => !beforeS2.includes(id));
      expect((await s2("POST", "/two-factor/verify-totp", { code: "000000" })).json?.code).toBe("NO_SETUP_PENDING");
      const pending = await s2("POST", "/recovery-codes/generate", { password });
      expect(pending.json?.code).toBe("AUTHENTICATOR_SETUP_PENDING");
      const before = (await rowOf(eve.id))?.failedVerificationCount ?? 0;
      expect((await s1("POST", "/two-factor/verify-totp", { code: "000000" })).status).toBeGreaterThanOrEqual(400);
      expect((await rowOf(eve.id))?.failedVerificationCount).toBe(before + 1);
      const totpKey = base32(new URL(String(enabled.json?.totpURI)).searchParams.get("secret") ?? "");
      expect(
        (await s1("POST", "/two-factor/verify-totp", { code: totpAt(totpKey, Math.floor(Date.now() / 30_000)) }))
          .status,
      ).toBe(200);

      // Refusals are audited: a code on step-up, codes for an authenticator user from the passkey route.
      expect((await s2("POST", "/step-up", { code: "123456" })).json?.code).toBe("STEP_UP_PASSWORD_ONLY");
      expect((await s2("POST", "/recovery-codes/generate", { password })).json?.code).toBe("USE_AUTHENTICATOR_CODES");
      expect(deniedOf(eve.id)).toEqual(
        expect.arrayContaining([
          "auth.identity_confirmed:password_only",
          "auth.recovery_codes_regenerated:use_authenticator_codes",
          "auth.recovery_codes_regenerated:authenticator_setup_pending",
        ]),
      );

      // 2. Wrong passwords anywhere in one session add up: the fifth signs it out.
      const wrong = "wrong-wrong-wrong";
      expect((await s2("POST", "/two-factor/generate-backup-codes", { password: wrong })).json?.code).toBe(
        "INVALID_PASSWORD",
      );
      expect(
        (await s2("POST", "/change-password", { currentPassword: wrong, newPassword: `${password}-new` })).status,
      ).toBe(400);
      expect((await s2("POST", "/step-up", { password: wrong })).status).toBe(400);
      expect((await s2("POST", "/step-up", { password: wrong })).status).toBe(400);
      // (A current code with the wrong password: the code passes, the password is the strike.)
      const fifth = await s2("POST", "/two-factor/disable", {
        password: wrong,
        code: totpAt(totpKey, Math.floor(Date.now() / 30_000) + 1),
      });
      // (An identity endpoint keeps its own status when our after-hook answers; the code says what happened.)
      expect(fifth.json?.code).toBe("STEP_UP_SESSION_ENDED");
      expect((await sessionsOf(eve.id)).some((x) => x.id === s2Id)).toBe(false);
      expect(
        events.some(
          (e) => e.userId === eve.id && e.action === "auth.session_revoked" && e.meta?.reason === "password_failures",
        ),
      ).toBe(true);

      // A passkey-only person's wrong passwords on new recovery codes count too (Max, no authenticator).
      const m = client();
      await m("POST", "/sign-in/email", { email: max.email, password });
      const mk = softPasskey();
      const mreg = await m("GET", "/passkey/generate-register-options");
      expect(
        (await m("POST", "/passkey/verify-registration", { response: mk.attest(String(mreg.json?.challenge)) })).status,
      ).toBe(200);
      for (let i = 0; i < 4; i++) {
        expect((await m("POST", "/recovery-codes/generate", { password: wrong })).json?.code).toBe("INVALID_PASSWORD");
      }
      expect((await m("POST", "/recovery-codes/generate", { password: wrong })).json?.code).toBe(
        "STEP_UP_SESSION_ENDED",
      );
      expect(await sessionsOf(max.id)).toEqual([]);

      // 3. Parallel wrong step-ups: the count is atomic, so no more than 4 are answered before the session ends.
      const p = client();
      await p("POST", "/sign-in/email", { email: max.email, password });
      const op = await p("GET", "/passkey/generate-authenticate-options");
      await p("POST", "/passkey/verify-authentication", { response: mk.assert(String(op.json?.challenge)) });
      const results = await Promise.all(Array.from({ length: 12 }, () => p("POST", "/step-up", { password: wrong })));
      expect(results.filter((r) => r.json?.code === "STEP_UP_FAILED").length).toBeLessThanOrEqual(4);
      expect(results.some((r) => r.status === 401)).toBe(true);
      expect(await sessionsOf(max.id)).toEqual([]);
    } finally {
      for (const u of [eve, max]) await db.delete(schema.authUser).where(eq(schema.authUser.id, u.id));
    }
  });
});

describe("breached passwords (fake check, no network)", () => {
  const breached = KNOWN_BREACHED_PASSWORDS[0] ?? "";
  const check = memoryBreachedPasswords();
  const openAuth = createAuth({
    db,
    secret: randomBytes(32).toString("base64url"),
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    secureCookies: false,
    signUp: "open",
    sendPasswordReset: async ({ url }) => {
      resetUrl = url;
    },
    sealer: createKeyRing([{ id: "int", key: randomBytes(32) }]),
    relyingParty: { id: "localhost", name: "AnhourMail", origin: ORIGIN },
    trustProxy: false,
    security: {
      onEvent: async () => undefined,
      removalRefusal: async () => null,
      factors: async () => ({ totp: false, passkeys: 0 }),
      factorAdded: async () => undefined,
      codes: { claim: async () => true },
      strikes: memoryStrikes(),
      passwordChanged: async () => undefined,
      sessionRefusal: async () => null,
    },
    breachedPasswords: check,
  });

  it("refuses a breached password at sign-up and creates nothing; accepts it while the service is down", async () => {
    const email = `int-breach-${randomUUID()}@example.com`;
    const call = client(openAuth);
    const refused = await call("POST", "/sign-up/email", { email, password: breached, firstName: "Int", name: "Int" });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({
      code: "PASSWORD_BREACHED",
      message: "This password has appeared in a data breach. Choose a different one.",
    });
    expect(await db.select().from(schema.authUser).where(eq(schema.authUser.email, email))).toEqual([]);
    // A short password gets the length message, not a lookup.
    const before = check.calls;
    expect(
      (await call("POST", "/sign-up/email", { email, password: "short", firstName: "Int", name: "Int" })).json?.code,
    ).toBe("PASSWORD_TOO_SHORT");
    expect(check.calls).toBe(before);

    check.unavailable = true;
    try {
      const ok = await call("POST", "/sign-up/email", { email, password: breached, firstName: "Int", name: "Int" });
      expect(ok.status).toBe(200);
    } finally {
      check.unavailable = false;
      await db.delete(schema.authUser).where(eq(schema.authUser.email, email));
    }
  });

  it("refuses a breached new password on change and on reset; the reset link still works afterwards", async () => {
    const email = `int-breach-pw-${randomUUID()}@example.com`;
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
      const call = client(openAuth);
      expect((await call("POST", "/sign-in/email", { email, password })).status).toBe(200);
      const changed = await call("POST", "/change-password", { currentPassword: password, newPassword: breached });
      expect(changed.status).toBe(400);
      expect(changed.json?.code).toBe("PASSWORD_BREACHED");

      expect((await call("POST", "/request-password-reset", { email, redirectTo: "/reset-password" })).status).toBe(
        200,
      );
      const token = /reset-password\/([^?]+)/.exec(resetUrl)?.[1] ?? "";
      const reset = await call("POST", "/reset-password", { token, newPassword: breached });
      expect(reset.status).toBe(400);
      expect(reset.json?.code).toBe("PASSWORD_BREACHED");
      expect((await call("POST", "/reset-password", { token, newPassword: `${password}-2` })).status).toBe(200);
      // The stored hash is the accepted password's, never the refused one's.
      expect((await client(openAuth)("POST", "/sign-in/email", { email, password: `${password}-2` })).status).toBe(200);
    } finally {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
    }
  });
});

describe("a held password reset (the address is a mailbox between owners)", () => {
  const sent: string[] = [];
  const held: { id: string; reason: string }[] = [];
  let hold: (email: string) => Promise<boolean> = async () => false;
  const holdingAuth = createAuth({
    db,
    secret: randomBytes(32).toString("base64url"),
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    secureCookies: false,
    signUp: "closed",
    sendPasswordReset: async ({ email }) => {
      sent.push(email);
    },
    holdPasswordReset: (user) => hold(user.email),
    onPasswordResetHeld: async (user, reason) => {
      held.push({ id: user.id, reason });
    },
    sealer: createKeyRing([{ id: "int", key: randomBytes(32) }]),
    relyingParty: { id: "localhost", name: "AnhourMail", origin: ORIGIN },
    trustProxy: false,
    security: {
      onEvent: async () => undefined,
      removalRefusal: async () => null,
      factors: async () => ({ totp: false, passkeys: 0 }),
      factorAdded: async () => undefined,
      codes: { claim: async () => true },
      strikes: memoryStrikes(),
      passwordChanged: async () => undefined,
      sessionRefusal: async () => null,
    },
    breachedPasswords: memoryBreachedPasswords(),
  });

  it("sends nothing, reports the hold, and answers exactly as for an unknown address", async () => {
    const email = `int-held-${randomUUID()}@example.com`;
    const userId = randomUUID();
    await db.insert(schema.authUser).values({ id: userId, name: "Int", email, emailVerified: true });
    try {
      const call = client(holdingAuth);
      const ask = (to: string) => call("POST", "/request-password-reset", { email: to, redirectTo: "/reset-password" });
      const unknown = await ask(`int-nobody-${randomUUID()}@example.com`);

      hold = async () => true;
      const heldRes = await ask(email);
      expect([heldRes.status, heldRes.json]).toEqual([unknown.status, unknown.json]);
      expect(sent).toEqual([]);
      expect(held).toEqual([{ id: userId, reason: "held" }]);

      // A failing check holds it too (password reset fails closed), with the same answer.
      hold = () => Promise.reject(new Error("database unavailable"));
      const failed = await ask(email);
      expect([failed.status, failed.json]).toEqual([unknown.status, unknown.json]);
      expect(sent).toEqual([]);
      expect(held.at(-1)).toEqual({ id: userId, reason: "check_failed" });

      // Not held: sent as usual.
      hold = async () => false;
      expect((await ask(email)).status).toBe(200);
      expect(sent).toEqual([email]);
    } finally {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
    }
  });
});

describe("names and redirect targets at the identity endpoints (XSS audit run-28 N2, N3)", () => {
  const openAuth = createAuth({
    db,
    secret: randomBytes(32).toString("base64url"),
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    secureCookies: false,
    signUp: "open",
    sendPasswordReset: async ({ url }) => {
      resetUrl = url;
    },
    sealer: createKeyRing([{ id: "int", key: randomBytes(32) }]),
    relyingParty: { id: "localhost", name: "AnhourMail", origin: ORIGIN },
    trustProxy: false,
    security: {
      onEvent: async () => undefined,
      removalRefusal: async () => null,
      factors: async () => ({ totp: false, passkeys: 0 }),
      factorAdded: async () => undefined,
      codes: { claim: async () => true },
      strikes: memoryStrikes(),
      passwordChanged: async () => undefined,
      sessionRefusal: async () => null,
    },
    breachedPasswords: memoryBreachedPasswords(),
    emailVerification: { expiresInSec: 3600, send: async () => undefined, onVerified: async () => undefined },
  });

  it("refuses names with web addresses, @ or text-direction controls at sign-up (400 INVALID_NAME), creating nothing", async () => {
    const password = `${randomBytes(12).toString("base64url")}-Nm1`;
    for (const [firstName, name] of [
      ["Visit evil.example", "Kim"],
      ["Kim", "support@bank"],
      ["Kim\u202eexe.txt", "Kim"],
      ["Kim", "https://evil.example"],
    ] as const) {
      const email = `int-name-${randomUUID()}@example.com`;
      const res = await client(openAuth)("POST", "/sign-up/email", { email, password, firstName, name });
      expect(res.status).toBe(400);
      expect(res.json?.code).toBe("INVALID_NAME");
      expect(await db.select().from(schema.authUser).where(eq(schema.authUser.email, email))).toEqual([]);
    }
  });

  const EVIL = ["https://evil.example", "//evil.example", "/\\evil.example", "https:evil.example"];
  const raw = (method: "GET" | "POST", path: string, body?: unknown) =>
    openAuth.handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method,
        redirect: "manual",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const leavesOrigin = (res: Response) => {
    const location = res.headers.get("location");
    if (!location) return false;
    return new URL(location, ORIGIN).origin !== ORIGIN;
  };

  it("request-password-reset refuses an off-site redirectTo, and no link to it is emailed", async () => {
    const email = `int-redirect-${randomUUID()}@example.com`;
    const userId = randomUUID();
    await db.insert(schema.authUser).values({ id: userId, name: "Int", email, emailVerified: true });
    try {
      for (const target of EVIL) {
        resetUrl = "";
        const res = await raw("POST", "/request-password-reset", { email, redirectTo: target });
        expect(res.status).toBe(403);
        expect(resetUrl).toBe("");
      }
    } finally {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, userId));
    }
  });

  it("the emailed reset link and the email confirmation link never redirect off-site", async () => {
    for (const target of EVIL) {
      const q = encodeURIComponent(target);
      const reset = await raw("GET", `/reset-password/not-a-real-token?callbackURL=${q}`);
      expect(leavesOrigin(reset)).toBe(false);
      expect(reset.status).toBeGreaterThanOrEqual(400);
      const verify = await raw("GET", `/verify-email?token=not-a-token&callbackURL=${q}`);
      expect(leavesOrigin(verify)).toBe(false);
      expect(verify.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("sign-in fails closed when the second-step check breaks (security-audit run-53)", () => {
  /** What the factor store throws: a plain failure, or a refusal (an identity-layer error). */
  let breakWith: Error = new Error("store down");
  const brokenAuth = createAuth({
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
      // The store behind "which second factors does this person have" is down.
      factors: () => Promise.reject(breakWith),
      factorAdded: async () => undefined,
      codes: { claim: async () => true },
      strikes: memoryStrikes(),
      passwordChanged: async () => undefined,
      sessionRefusal: async () => null,
    },
    breachedPasswords: memoryBreachedPasswords(),
  });

  it("deletes the session the password created on any error, never a password-only session", async () => {
    const password = "correct-horse-battery";
    const email = `int-fc-${randomUUID()}@example.com`;
    const id = randomUUID();
    await db.insert(schema.authUser).values({ id, name: "Int", email, emailVerified: true });
    await db.insert(schema.authAccount).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashPassword(password),
    });
    const signIn = () =>
      brokenAuth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
      );
    try {
      // A refusal thrown while deciding: passed on as it is, and the session still goes.
      breakWith = new APIError("FORBIDDEN", { code: "REFUSED_FOR_TEST", message: "Refused." });
      const refused = await signIn();
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code?: string }).code).toBe("REFUSED_FOR_TEST");
      expect(await db.select().from(schema.authSession).where(eq(schema.authSession.userId, id))).toEqual([]);
      // A plain failure: 503.
      breakWith = new Error("store down");
      const res = await brokenAuth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe("SIGN_IN_UNAVAILABLE");
      const sessionCookies = res.headers.getSetCookie().filter((c) => c.includes("session_token="));
      for (const c of sessionCookies) expect(c).toMatch(/Max-Age=0/i);
      expect(await db.select().from(schema.authSession).where(eq(schema.authSession.userId, id))).toEqual([]);
    } finally {
      await db.delete(schema.authUser).where(eq(schema.authUser.id, id));
    }
  });
});
