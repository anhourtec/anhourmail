// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { leadingZeroBits, POW_TTL_SEC, powInput } from "@anhourmail/shared/proof-of-work";

import { deps, req } from "../__tests__/helpers";
import { signUpClient } from "./network";
import { issueChallenge, type PowClaim, powKeyFrom, SIGNED_REFUSALS, verifyProof } from "./proof-of-work";
import { recordSignUpRefusal } from "./refusal";

/** In-memory `SET NX PX`, as the server's Redis claim does it. */
function memoryOneTime(now: () => number): PowClaim {
  const until = new Map<string, number>();
  return async (key, ttlMs) => {
    if ((until.get(key) ?? 0) > now()) return false;
    until.set(key, now() + ttlMs);
    return true;
  };
}

const KEY = powKeyFrom("x".repeat(40));
const NOW = new Date("2026-11-04T12:00:00Z");
const CLIENT = "203.0.113.7";

/** The test's own solver (the browser's does the same with Web Crypto). */
function solve(challenge: string, bits: number): string {
  for (let n = 0; ; n++) {
    const d = createHash("sha256")
      .update(powInput(challenge, String(n)))
      .digest();
    if (leadingZeroBits(d) >= bits) return String(n);
  }
}

/** A proof that does NOT meet `bits` (so the work check is what refuses it). */
function wrongProof(challenge: string, bits: number): string {
  for (let n = 0; ; n++) {
    const d = createHash("sha256")
      .update(powInput(challenge, String(n)))
      .digest();
    if (leadingZeroBits(d) < bits) return String(n);
  }
}

const verify = (
  challenge: string | null,
  proof: string | null,
  over: Partial<{ client: string; now: Date; minBits: number; claim: PowClaim }> = {},
) =>
  verifyProof({
    key: KEY,
    minBits: over.minBits ?? 8,
    client: over.client ?? CLIENT,
    challenge,
    proof,
    now: over.now ?? NOW,
    claim: over.claim ?? memoryOneTime(() => NOW.getTime()),
  });

describe("leadingZeroBits", () => {
  it("counts zero bits across bytes", () => {
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x10]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });
});

describe("sign-up proof-of-work", () => {
  it("issues a signed challenge with the difficulty and a ten-minute expiry, never the client address", () => {
    const c = issueChallenge({ key: KEY, bits: 12, client: CLIENT, now: NOW });
    expect(c.bits).toBe(12);
    expect(c.expiresAt.getTime()).toBe(NOW.getTime() + POW_TTL_SEC * 1000);
    expect(c.challenge.split(".")).toHaveLength(6);
    expect(c.challenge).not.toContain(CLIENT);
    // Random every time.
    expect(issueChallenge({ key: KEY, bits: 12, client: CLIENT, now: NOW }).challenge).not.toBe(c.challenge);
  });

  it("accepts a correct proof once; the same proof again is a replay", async () => {
    const { challenge } = issueChallenge({ key: KEY, bits: 10, client: CLIENT, now: NOW });
    const proof = solve(challenge, 10);
    const claim = memoryOneTime(() => NOW.getTime());
    expect(await verify(challenge, proof, { claim })).toEqual({ ok: true });
    expect(await verify(challenge, proof, { claim })).toEqual({ ok: false, reason: "replayed" });
  });

  it("refuses missing, malformed and forged challenges and proofs", async () => {
    const { challenge } = issueChallenge({ key: KEY, bits: 8, client: CLIENT, now: NOW });
    const proof = solve(challenge, 8);
    expect(await verify(null, proof)).toEqual({ ok: false, reason: "missing" });
    expect(await verify(challenge, null)).toEqual({ ok: false, reason: "missing" });
    expect(await verify(challenge, "-1")).toEqual({ ok: false, reason: "malformed" });
    expect(await verify(challenge, `0${proof}`)).toEqual({ ok: false, reason: "malformed" });
    expect(await verify(challenge, "1".repeat(16))).toEqual({ ok: false, reason: "malformed" });
    expect(await verify("v1.8.1.a.b", proof)).toEqual({ ok: false, reason: "malformed" });
    expect(await verify(`${challenge}x`.repeat(3), proof)).toEqual({ ok: false, reason: "malformed" });
    // Lowering the difficulty, moving the expiry or signing with another key breaks the signature.
    const parts = challenge.split(".");
    const easier = [parts[0], "1", ...parts.slice(2)].join(".");
    expect(await verify(easier, "0")).toEqual({ ok: false, reason: "forged" });
    const later = [parts[0], parts[1], String(Number(parts[2]) + 3600), ...parts.slice(3)].join(".");
    expect(await verify(later, proof)).toEqual({ ok: false, reason: "forged" });
    const other = issueChallenge({ key: powKeyFrom("y".repeat(40)), bits: 8, client: CLIENT, now: NOW }).challenge;
    expect(await verify(other, solve(other, 8))).toEqual({ ok: false, reason: "forged" });
  });

  it("refuses an expired challenge, one from another client, too little work, and an easier one than configured", async () => {
    const { challenge } = issueChallenge({ key: KEY, bits: 10, client: CLIENT, now: NOW });
    const proof = solve(challenge, 10);
    const late = new Date(NOW.getTime() + POW_TTL_SEC * 1000);
    expect(await verify(challenge, proof, { now: late })).toEqual({ ok: false, reason: "expired" });
    expect(await verify(challenge, proof, { client: "203.0.113.8" })).toEqual({ ok: false, reason: "wrong_client" });
    expect(await verify(challenge, wrongProof(challenge, 10))).toEqual({ ok: false, reason: "insufficient_work" });
    expect(await verify(challenge, proof, { minBits: 11 })).toEqual({ ok: false, reason: "too_easy" });
    // None of those spent it: the right proof still works once.
    expect(await verify(challenge, proof)).toEqual({ ok: true });
  });

  it("spends the challenge only for a correct proof, until it expires, and fails closed when the store fails", async () => {
    const seen: { key: string; ttl: number }[] = [];
    const claim: PowClaim = async (key, ttl) => {
      seen.push({ key, ttl });
      return true;
    };
    const { challenge } = issueChallenge({ key: KEY, bits: 8, client: CLIENT, now: NOW });
    await verify(challenge, wrongProof(challenge, 8), { claim });
    expect(seen).toEqual([]);
    await verify(challenge, solve(challenge, 8), { claim });
    expect(seen).toEqual([{ key: `am:pow:${challenge.split(".")[3] ?? ""}`, ttl: POW_TTL_SEC * 1000 + 1000 }]);
    const broken: PowClaim = () => Promise.reject(new Error("redis down"));
    await expect(verify(challenge, solve(challenge, 8), { claim: broken })).rejects.toThrow("redis down");
  });

  it("audits only refusals that carry a challenge we signed", () => {
    expect([...SIGNED_REFUSALS].sort()).toEqual([
      "expired",
      "insufficient_work",
      "replayed",
      "too_easy",
      "wrong_client",
    ]);
  });
});

describe("signUpClient", () => {
  it("keys IPv4 by address and /24, and reads every spelling of mapped and NAT64 addresses as IPv4", () => {
    const v4 = {
      address: "ip4:203.0.113.7",
      attempt: "ip4:203.0.113.7",
      network: "net4:203.0.113",
      network56: null,
      network48: null,
      audit: "net4:203.0.113",
    };
    for (const spelling of [
      "203.0.113.7",
      "::ffff:203.0.113.7",
      "::FFFF:cb00:7107",
      "0:0:0:0:0:ffff:203.0.113.7",
      "0000:0000:0000:0000:0000:ffff:cb00:7107",
      "64:ff9b::203.0.113.7",
      "64:ff9b::cb00:7107",
      " 203.0.113.7 ",
    ]) {
      expect({ spelling, client: signUpClient(spelling) }).toEqual({ spelling, client: v4 });
    }
  });

  it("keys IPv6 by address, /64 (attempts and network), /56, /48, and audits by /48", () => {
    expect(signUpClient("2001:DB8:1:2a34:aaaa::1")).toEqual({
      address: "ip6:2001:db8:1:2a34:aaaa:0:0:1",
      attempt: "net6/64:2001:db8:1:2a34",
      network: "net6/64:2001:db8:1:2a34",
      network56: "net6/56:2001:db8:1:2a",
      network48: "net6/48:2001:db8:1",
      audit: "net6/48:2001:db8:1",
    });
    // Spellings of one address are one address.
    expect(signUpClient("2001:0db8:0001:2a34:aaaa:0000:0000:0001").address).toBe("ip6:2001:db8:1:2a34:aaaa:0:0:1");
    expect(signUpClient("2001:db8::1").network).toBe("net6/64:2001:db8:0:0");
    expect(signUpClient("2001:db8:1:2aff::9").network56).toBe("net6/56:2001:db8:1:2a");
    expect(signUpClient("2001:db8:1:2bff::9").network56).toBe("net6/56:2001:db8:1:2b");
    expect(signUpClient("::1").network).toBe("net6/64:0:0:0:0");
    // A ::ffff:0:0/96 neighbour that isn't the mapped prefix stays IPv6.
    expect(signUpClient("::fffe:cb00:7107").address).toBe("ip6:0:0:0:0:0:fffe:cb00:7107");
  });

  it("treats a missing or non-IP address as its own client", () => {
    expect(signUpClient(null)).toMatchObject({ address: "other:direct", network: "other:direct", network48: null });
    expect(signUpClient("1::2::3").address).toBe("other:1::2::3");
    expect(signUpClient("1:2:3:4:5:6:7:8:9").network).toBe("other:1:2:3:4:5:6:7:8:9");
  });
});

describe("powKeyFrom", () => {
  it("derives a 32-byte key with HKDF-SHA-256, different per secret and never the secret", () => {
    const k = powKeyFrom("x".repeat(40));
    expect(k).toHaveLength(32);
    expect(Buffer.from(k).equals(Buffer.from(powKeyFrom("x".repeat(40))))).toBe(true);
    expect(Buffer.from(k).equals(Buffer.from(powKeyFrom("y".repeat(40))))).toBe(false);
    expect(Buffer.from(k).toString()).not.toContain("x".repeat(8));
  });
});

describe("recordSignUpRefusal", () => {
  it("writes one denied platform entry per network (IPv4 /24, IPv6 /48) and reason per hour, with nothing of the person", async () => {
    const d = deps();
    let t = NOW.getTime();
    const once = memoryOneTime(() => t);
    const r = { code: "proof_of_work", reason: "replayed" } as const;
    expect(await recordSignUpRefusal(d, once, r, req)).toBe(true);
    expect(await recordSignUpRefusal(d, once, r, req)).toBe(false);
    expect(await recordSignUpRefusal(d, once, { code: "sign_up_limited", reason: "network_day" }, req)).toBe(true);
    // Another address in the same /24 shares the entry; another network gets its own.
    expect(await recordSignUpRefusal(d, once, r, { ...req, ip: "203.0.113.99" })).toBe(false);
    expect(await recordSignUpRefusal(d, once, r, { ...req, ip: "198.51.100.99" })).toBe(true);
    // IPv6: two /64s in one /48 share the entry.
    expect(await recordSignUpRefusal(d, once, r, { ...req, ip: "2001:db8:5:1::1" })).toBe(true);
    expect(await recordSignUpRefusal(d, once, r, { ...req, ip: "2001:db8:5:2::1" })).toBe(false);
    t += 3600_000;
    expect(await recordSignUpRefusal(d, once, r, req)).toBe(true);
    expect(d.uow.state.audit).toHaveLength(5);
    expect(d.uow.state.audit[0]).toMatchObject({
      action: "auth.sign_up_refused",
      scope: "platform",
      result: "denied",
      errorCode: "proof_of_work",
      actor: { type: "system", email: "identity" },
      target: { type: "user", id: null, label: null },
      meta: { reason: "replayed" },
      ip: req.ip,
      userAgent: null,
    });
    expect(d.uow.state.audit[1]).toMatchObject({ errorCode: "sign_up_limited", meta: { reason: "network_day" } });
  });
});
