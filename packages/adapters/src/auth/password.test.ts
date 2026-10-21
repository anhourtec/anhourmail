// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { hashPassword, needsRehash, verifyPassword } from "./password";

describe("argon2id password hashing", () => {
  it("produces salted argon2id PHC strings at the OWASP baseline", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b); // random salt per hash
    expect(needsRehash(a)).toBe(false);
  });

  it("verifies the right password only", async () => {
    const h = await hashPassword("s3cret-passphrase");
    expect(await verifyPassword({ password: "s3cret-passphrase", hash: h })).toBe(true);
    expect(await verifyPassword({ password: "wrong", hash: h })).toBe(false);
  });

  it("rejects non-argon2id and malformed hashes without throwing", async () => {
    expect(await verifyPassword({ password: "x", hash: "salt:deadbeef" })).toBe(false);
    expect(await verifyPassword({ password: "x", hash: "$argon2id$garbage" })).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$abc$def")).toBe(true);
    expect(needsRehash("scrypt:abc")).toBe(true);
  });
});
