// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { memoryAccountSignals, redisAccountSignals } from "./account-signals";

describe("account signals", () => {
  it("redis: SADD with an expiry; SPOP a batch; store errors are swallowed on both sides", async () => {
    const calls: unknown[][] = [];
    const set = new Set<string>();
    const signals = redisAccountSignals(
      {
        sadd: async (key, member) => {
          calls.push(["sadd", key, member]);
          set.add(member);
          return 1;
        },
        expire: async (key, seconds) => {
          calls.push(["expire", key, seconds]);
          return 1;
        },
        spop: async (key, count) => {
          calls.push(["spop", key, count]);
          const out = [...set].slice(0, count);
          for (const id of out) set.delete(id);
          return out;
        },
      },
      "k",
    );
    await signals.signal("a");
    await signals.signal("a");
    await signals.signal("b");
    expect(calls.slice(0, 2)).toEqual([
      ["sadd", "k", "a"],
      ["expire", "k", 7 * 24 * 3600],
    ]);
    expect((await signals.take(10)).sort()).toEqual(["a", "b"]);
    expect(await signals.take(10)).toEqual([]);
    expect(await signals.take(0)).toEqual([]);

    const down = () => Promise.reject(new Error("down"));
    const broken = redisAccountSignals({ sadd: down, expire: down, spop: down }, "k");
    await expect(broken.signal("a")).resolves.toBeUndefined();
    await expect(broken.take(5)).resolves.toEqual([]);
  });

  it("memory: each id once, in batches", async () => {
    const signals = memoryAccountSignals();
    for (const id of ["a", "b", "a", "c"]) await signals.signal(id);
    expect(signals.pending()).toEqual(["a", "b", "c"]);
    expect(await signals.take(2)).toEqual(["a", "b"]);
    expect(await signals.take(2)).toEqual(["c"]);
    expect(await signals.take(-1)).toEqual([]);
  });
});
