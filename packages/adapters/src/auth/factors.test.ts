// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";

import {
  hashedBackupCodeStore,
  hashRecoveryCode,
  isRecoveryCodeInput,
  newRecoveryCode,
  newRecoveryCodes,
  normaliseRecoveryCode,
  recoveryCodesLeft,
} from "./recovery-codes";
import { sealTwoFactorSecrets } from "./sealed-adapter";
import { claimTotp, totpAt, verifyTotp } from "./totp";
import { memoryOneTime } from "@anhourmail/server/one-time";

describe("recovery codes", () => {
  it("are 10 distinct 16-character codes without look-alike letters", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(newRecoveryCode()).not.toBe(newRecoveryCode());
  });

  it("hash the way people type them (case, dashes, spaces), and never store the code", async () => {
    const code = "ABCD-EFGH-JKLM-NPQR";
    expect(normaliseRecoveryCode(" abcd efgh-jklm npqr ")).toBe("ABCDEFGHJKLMNPQR");
    expect(hashRecoveryCode("abcd-efgh-jklm-npqr")).toBe(hashRecoveryCode(code));
    // A stored hash typed back in never matches, and is refused as input before that.
    expect(hashRecoveryCode(hashRecoveryCode(code))).not.toBe(hashRecoveryCode(code));
    expect(isRecoveryCodeInput(hashRecoveryCode(code))).toBe(false);
    expect(isRecoveryCodeInput(code)).toBe(true);
    const stored = await hashedBackupCodeStore.encrypt(JSON.stringify([code, "WXYZ-WXYZ-WXYZ-WXYZ"]));
    expect(stored).not.toContain("ABCD");
    expect(JSON.parse(await hashedBackupCodeStore.decrypt(stored))).toEqual([
      hashRecoveryCode(code),
      hashRecoveryCode("WXYZ-WXYZ-WXYZ-WXYZ"),
    ]);
    // What the plugin stores back after a code is used: the remaining hashes, unchanged.
    const remaining = await hashedBackupCodeStore.encrypt(JSON.stringify([hashRecoveryCode(code)]));
    expect(JSON.parse(remaining)).toEqual([hashRecoveryCode(code)]);
    expect(recoveryCodesLeft(stored)).toBe(2);
    expect(recoveryCodesLeft("not json")).toBe(0);
    expect(recoveryCodesLeft("{}")).toBe(0);
    await expect(hashedBackupCodeStore.encrypt("{}")).rejects.toThrow();
  });
});

describe("TOTP", () => {
  // RFC 6238 appendix B (SHA-1 seed), truncated to 6 digits.
  const seed = Buffer.from("12345678901234567890");
  it("matches the RFC test vectors", () => {
    expect(totpAt(seed, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(totpAt(seed, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(totpAt(seed, Math.floor(1111111109 / 30))).toBe("081804");
  });

  it("accepts the current step and one either side, nothing else", () => {
    const secret = "12345678901234567890";
    const t = 1111111109_000;
    expect(verifyTotp(secret, "081804", t)).toBe(true);
    expect(verifyTotp(secret, " 081 804 ", t)).toBe(true);
    expect(verifyTotp(secret, totpAt(seed, Math.floor(t / 30_000) + 1), t)).toBe(true);
    expect(verifyTotp(secret, totpAt(seed, Math.floor(t / 30_000) - 2), t)).toBe(false);
    expect(verifyTotp(secret, "12345", t)).toBe(false);
    expect(verifyTotp(secret, "abcdef", t)).toBe(false);
  });
});

describe("one-time authenticator codes", () => {
  const secret = "12345678901234567890";
  const t = 1111111109_000;
  it("two concurrent checks of the same valid code: exactly one succeeds", async () => {
    const store = memoryOneTime(() => t);
    const claim = (userId: string, code: string) => store(`${userId}:${code}`, 120_000);
    const results = await Promise.all([
      claimTotp(secret, "u1", "081804", claim, t),
      claimTotp(secret, "u1", "081 804", claim, t),
    ]);
    expect(results.sort()).toEqual(["ok", "reused"]);
    // Another person, or a wrong code, is unaffected; a wrong code claims nothing.
    expect(await claimTotp(secret, "u2", "081804", claim, t)).toBe("ok");
    expect(await claimTotp(secret, "u3", "000000", claim, t)).toBe("invalid");
  });

  it("a store error refuses the code", async () => {
    const broken = () => Promise.reject(new Error("redis down"));
    await expect(claimTotp(secret, "u1", "081804", broken, t)).rejects.toThrow("redis down");
  });
});

describe("sealed two-factor secrets", () => {
  const ring = createKeyRing([{ id: "k1", key: Buffer.alloc(32, 7) }]);
  type Row = Record<string, unknown>;

  /** A tiny in-memory stand-in for a better-auth database adapter. */
  function fakeAdapter(rows: Row[]) {
    const match = (r: Row, where: { field: string; value: unknown }[]) => where.every((w) => r[w.field] === w.value);
    const adapter = {
      id: "fake",
      create: async (q: { model: string; data: Row }) => {
        const row = { id: `id-${String(rows.length)}`, model: q.model, ...q.data };
        rows.push(row);
        return { ...row };
      },
      findOne: async (q: { model: string; where: { field: string; value: unknown }[] }) => {
        const r = rows.find((x) => x.model === q.model && match(x, q.where));
        return r ? { ...r } : null;
      },
      findMany: async (q: { model: string }) => rows.filter((x) => x.model === q.model).map((x) => ({ ...x })),
      update: async (q: { model: string; where: { field: string; value: unknown }[]; update: Row }) => {
        const r = rows.find((x) => x.model === q.model && match(x, q.where));
        if (!r) return null;
        Object.assign(r, q.update);
        return { ...r };
      },
      transaction: async <T>(cb: (trx: unknown) => Promise<T>) => cb(adapter),
    };
    return adapter;
  }

  it("seals on write with the user id as AAD, unseals on read, leaves other models alone", async () => {
    const rows: Row[] = [];
    const a = sealTwoFactorSecrets(fakeAdapter(rows), ring);
    const created = (await a.create({
      model: "twoFactor",
      data: { userId: "u1", secret: "plugin-ciphertext" },
    })) as Row;
    expect(created.secret).toBe("plugin-ciphertext");
    expect(String(rows[0]?.secret)).toMatch(/^v1\.k1\./);
    expect(((await a.findOne({ model: "twoFactor", where: [{ field: "userId", value: "u1" }] })) as Row).secret).toBe(
      "plugin-ciphertext",
    );
    expect(((await a.findMany({ model: "twoFactor" })) as Row[])[0]?.secret).toBe("plugin-ciphertext");

    // Re-enrolling replaces the secret by row id: still sealed for the row's user.
    await a.update({ model: "twoFactor", where: [{ field: "id", value: "id-0" }], update: { secret: "second" } });
    expect(String(rows[0]?.secret)).toMatch(/^v1\./);
    expect(((await a.findOne({ model: "twoFactor", where: [{ field: "id", value: "id-0" }] })) as Row).secret).toBe(
      "second",
    );
    // Other fields and models pass through.
    await a.update({ model: "twoFactor", where: [{ field: "id", value: "id-0" }], update: { verified: true } });
    await a.create({ model: "session", data: { userId: "u1", secret: "not-ours" } });
    expect(rows[1]?.secret).toBe("not-ours");
    await a.transaction(async (trx) => {
      const t = trx as typeof a;
      expect(((await t.findOne({ model: "twoFactor", where: [{ field: "userId", value: "u1" }] })) as Row).secret).toBe(
        "second",
      );
    });
  });

  it("a sealed secret copied to another person's row doesn't decrypt", async () => {
    const rows: Row[] = [];
    const a = sealTwoFactorSecrets(fakeAdapter(rows), ring);
    await a.create({ model: "twoFactor", data: { userId: "u1", secret: "mine" } });
    rows.push({ id: "x", model: "twoFactor", userId: "u2", secret: rows[0]?.secret });
    await expect(a.findOne({ model: "twoFactor", where: [{ field: "userId", value: "u2" }] })).rejects.toThrow();
    await expect(a.create({ model: "twoFactor", data: { secret: "orphan" } })).rejects.toThrow(/without a user/);
  });
});
