// SPDX-License-Identifier: MIT
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createKeyRing, KeyRingError, keyRingFromEnv, parseKeyRing } from "./keyring";

const key = () => randomBytes(32);

describe("key ring", () => {
  it("round-trips with the active key and records the key id", () => {
    const ring = createKeyRing([{ id: "k1", key: key() }]);
    const sealed = ring.encrypt("webmail", "secret value", "session:abc");
    expect(sealed.startsWith("v1.k1.")).toBe(true);
    expect(sealed).not.toContain("secret value");
    expect(ring.decrypt("webmail", sealed, "session:abc")).toBe("secret value");
    expect(ring.keyIdOf(sealed)).toBe("k1");
    expect(ring.keyIdOf("nope")).toBeNull();
    // Fresh IV each time.
    expect(ring.encrypt("webmail", "x", "a")).not.toBe(ring.encrypt("webmail", "x", "a"));
  });

  it("binary values: round-trip, key id travels with them, bound to AAD and purpose, tamper-evident", () => {
    const k1 = key();
    const ring = createKeyRing([{ id: "k1", key: k1 }]);
    const data = randomBytes(5000);
    const sealed = ring.encryptBytes("data-export", data, "data_export:1");
    expect(Buffer.from(sealed).includes(data.subarray(0, 64))).toBe(false);
    expect(Buffer.from(ring.decryptBytes("data-export", sealed, "data_export:1")).equals(data)).toBe(true);
    expect(() => ring.decryptBytes("data-export", sealed, "data_export:2")).toThrow(/Decryption failed/);
    expect(() => ring.decryptBytes("other", sealed, "data_export:1")).toThrow(/Decryption failed/);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 1;
    expect(() => ring.decryptBytes("data-export", tampered, "data_export:1")).toThrow(/Decryption failed/);
    expect(() => ring.decryptBytes("data-export", Buffer.from("xx"), "a")).toThrow(/Not a sealed value/);
    expect(() => ring.decryptBytes("data-export", Buffer.from("v1\u0000"), "a")).toThrow(/Malformed/);
    // Rotation: a newer active key still opens what the old one sealed; a ring without it can't.
    const rotated = createKeyRing([
      { id: "k2", key: key() },
      { id: "k1", key: k1 },
    ]);
    expect(Buffer.from(rotated.decryptBytes("data-export", sealed, "data_export:1")).equals(data)).toBe(true);
    expect(() =>
      createKeyRing([{ id: "k3", key: key() }]).decryptBytes("data-export", sealed, "data_export:1"),
    ).toThrow(/Unknown key id/);
  });

  it("binary values: the longest key id fits the one-byte header; longer ids are refused, never truncated", () => {
    const id = "k".repeat(32);
    const ring = createKeyRing([{ id, key: key() }]);
    const sealed = ring.encryptBytes("p", Buffer.from("x"), "a");
    expect(sealed[2]).toBe(32);
    expect(Buffer.from(sealed.subarray(3, 35)).toString()).toBe(id);
    expect(Buffer.from(ring.decryptBytes("p", sealed, "a")).toString()).toBe("x");
    expect(() => createKeyRing([{ id: "k".repeat(256), key: key() }])).toThrow(KeyRingError);
  });

  it("binds ciphertext to its AAD and purpose", () => {
    const ring = createKeyRing([{ id: "k1", key: key() }]);
    const sealed = ring.encrypt("webmail", "v", "session:a");
    expect(() => ring.decrypt("webmail", sealed, "session:b")).toThrow(KeyRingError);
    expect(() => ring.decrypt("other", sealed, "session:a")).toThrow(KeyRingError);
  });

  it("detects tampering and malformed input", () => {
    const ring = createKeyRing([{ id: "k1", key: key() }]);
    const sealed = ring.encrypt("p", "hello", "a");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 1;
    const tampered = [parts[0], parts[1], parts[2], body.toString("base64url")].join(".");
    expect(() => ring.decrypt("p", tampered, "a")).toThrow(/Decryption failed/);
    expect(() => ring.decrypt("p", "garbage", "a")).toThrow(/Not a sealed value/);
    expect(() => ring.decrypt("p", "v1.k1.AAAA.AAAA", "a")).toThrow(/Malformed/);
    expect(() => ring.decrypt("p", `${sealed}.extra`, "a")).toThrow(/Not a sealed value/);
  });

  it("rotates: old keys still decrypt, new writes use the first key", () => {
    const k1 = key();
    const old = createKeyRing([{ id: "k1", key: k1 }]);
    const sealedOld = old.encrypt("p", "old", "a");
    const rotated = createKeyRing([
      { id: "k2", key: key() },
      { id: "k1", key: k1 },
    ]);
    expect(rotated.decrypt("p", sealedOld, "a")).toBe("old");
    expect(rotated.keyIdOf(rotated.encrypt("p", "new", "a"))).toBe("k2");
    const k2Only = createKeyRing([{ id: "k2", key: key() }]);
    expect(() => k2Only.decrypt("p", sealedOld, "a")).toThrow(/Unknown key id/);
  });

  it("validates the ring", () => {
    expect(() => createKeyRing([])).toThrow(/empty/);
    expect(() => createKeyRing([{ id: "bad id", key: key() }])).toThrow(/Invalid key id/);
    expect(() => createKeyRing([{ id: "k", key: randomBytes(16) }])).toThrow(/32 bytes/);
    const k = key();
    expect(() =>
      createKeyRing([
        { id: "k", key: k },
        { id: "k", key: k },
      ]),
    ).toThrow(/Duplicate/);
  });

  it("parses the env spec and refuses a missing ring in production", () => {
    const a = key().toString("base64");
    const b = key().toString("base64");
    const parsed = parseKeyRing(` k2:${a} , k1:${b} ,`);
    expect(parsed.map((p) => p.id)).toEqual(["k2", "k1"]);
    expect(() => parseKeyRing("nokey")).toThrow(/id:base64key/);
    expect(keyRingFromEnv({ spec: `k2:${a}`, production: true }).activeKeyId).toBe("k2");
    expect(() => keyRingFromEnv({ spec: undefined, production: true, devFallbackSecret: "x" })).toThrow(
      /required in production/,
    );
    expect(() => keyRingFromEnv({ spec: "", production: false })).toThrow(/not set/);
    const dev1 = keyRingFromEnv({ spec: undefined, production: false, devFallbackSecret: "s".repeat(32) });
    const dev2 = keyRingFromEnv({ spec: "  ", production: false, devFallbackSecret: "s".repeat(32) });
    expect(dev1.activeKeyId).toBe("dev");
    // Deterministic, so dev sessions survive a restart.
    expect(dev2.decrypt("p", dev1.encrypt("p", "x", "a"), "a")).toBe("x");
  });
});
