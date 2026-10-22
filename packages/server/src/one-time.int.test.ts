// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { redisOneTime } from "./one-time";
import { redis as shared } from "./redis";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set (integration tests need the compose stack)");
const redis = shared();
afterAll(() => redis.quit());

describe("redis one-time claims", () => {
  it("of 20 concurrent claims of one key exactly one wins, and the key expires", async () => {
    const claim = redisOneTime(redis);
    const key = `am:test:one-time:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => claim(key, 500)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(500);
  });
});
