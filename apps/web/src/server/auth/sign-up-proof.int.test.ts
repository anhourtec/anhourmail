// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sign-up proof-of-work against the real Redis (ADR-0031): of many concurrent sign-ups carrying the same correct proof,
 * exactly one is accepted, and the spent challenge's key expires with the challenge; a sign-up that created no account
 * gives its count back, and a give-back after the window ended leaves no key behind.
 */
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { issueChallenge, powKeyFrom, verifyProof } from "@anhourmail/core/sign-up";
import { redisOneTime } from "@anhourmail/server/one-time";
import { checkRateLimit, redisCounter, redisUncount } from "@anhourmail/server/rate-limit";
import { redis as shared } from "@anhourmail/server/redis";
import { leadingZeroBits, POW_TTL_SEC, powInput } from "@anhourmail/shared/proof-of-work";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set (integration tests need the compose stack)");
const redis = shared();
afterAll(() => redis.quit());

const KEY = powKeyFrom("integration-test-secret-0123456789abcdef");

describe("sign-up proof single use (Redis)", () => {
  it("accepts one of 20 concurrent uses of a proof; the claim expires with the challenge", async () => {
    const now = new Date();
    const { challenge } = issueChallenge({ key: KEY, bits: 10, client: "198.51.100.30", now });
    let n = 0;
    while (
      leadingZeroBits(
        createHash("sha256")
          .update(powInput(challenge, String(n)))
          .digest(),
      ) < 10
    )
      n++;
    const claim = redisOneTime(redis);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        verifyProof({ key: KEY, minBits: 10, client: "198.51.100.30", challenge, proof: String(n), now, claim }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "replayed")).toHaveLength(19);
    const ttl = await redis.pttl(`am:pow:${challenge.split(".")[3] ?? ""}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(POW_TTL_SEC * 1000 + 1000);
  });

  it("gives a counted sign-up back, and never creates a key once its window has gone", async () => {
    // Dev's RATE_LIMIT_MULTIPLIER would scale the limit.
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
    const limit = { limit: 1, windowSec: 60, by: "ip", failMode: "closed" } as const;
    const subject = `test-${String(Date.now())}-${String(Math.random())}`;
    const first = await checkRateLimit(redisCounter(redis), "signupTest", limit, subject);
    expect(first.allowed).toBe(true);
    expect((await checkRateLimit(redisCounter(redis), "signupTest", limit, subject)).allowed).toBe(false);
    const uncount = redisUncount(redis);
    await uncount(first.key ?? "");
    await uncount(first.key ?? "");
    expect((await checkRateLimit(redisCounter(redis), "signupTest", limit, subject)).allowed).toBe(true);
    const gone = `am:rl:signupTest:${subject}:gone`;
    await uncount(gone);
    expect(await redis.exists(gone)).toBe(0);
    vi.unstubAllEnvs();
  });
});
