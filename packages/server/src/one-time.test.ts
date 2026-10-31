// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { memoryOneTime, memoryStrikes, redisOneTime, redisStrikes } from "./one-time";

describe("one-time claims", () => {
  it("memory: the first claim wins until it expires", async () => {
    let t = 0;
    const claim = memoryOneTime(() => t);
    expect(await claim("k", 1000)).toBe(true);
    expect(await claim("k", 1000)).toBe(false);
    t = 1001;
    expect(await claim("k", 1000)).toBe(true);
  });

  it("redis: SET NX PX, only an OK reply wins; errors propagate", async () => {
    const calls: unknown[][] = [];
    const keys = new Set<string>();
    const claim = redisOneTime({
      set: async (...args) => {
        calls.push(args);
        if (keys.has(args[0])) return null;
        keys.add(args[0]);
        return "OK";
      },
    });
    const results = await Promise.all([claim("a", 120_000), claim("a", 120_000)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(calls[0]).toEqual(["a", "1", "PX", 120_000, "NX"]);
    const broken = redisOneTime({ set: () => Promise.reject(new Error("down")) });
    await expect(broken("a", 1)).rejects.toThrow("down");
  });

  it("memory strikes: concurrent strikes all count, and the window restarts after it expires", async () => {
    let t = 0;
    const strike = memoryStrikes(() => t);
    const counts = await Promise.all(Array.from({ length: 5 }, () => strike("s", 1000)));
    expect([...counts].sort()).toEqual([1, 2, 3, 4, 5]);
    t = 1001;
    expect(await strike("s", 1000)).toBe(1);
  });

  it("redis strikes: one INCR script call per strike with the window; errors propagate", async () => {
    const calls: unknown[][] = [];
    let n = 0;
    const strike = redisStrikes({
      eval: async (...args) => {
        calls.push(args);
        n += 1;
        return n;
      },
    });
    expect(await strike("k", 60_000)).toBe(1);
    expect(calls[0]?.slice(1)).toEqual([1, "k", 60_000]);
    const broken = redisStrikes({ eval: () => Promise.reject(new Error("down")) });
    await expect(broken("k", 1)).rejects.toThrow("down");
  });
});
