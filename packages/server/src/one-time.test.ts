// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { memoryOneTime, redisOneTime } from "./one-time";

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
});
