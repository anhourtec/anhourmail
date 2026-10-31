// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { addTiming, currentTimings, serverTimingHeader, timed, timingFields, withTimings } from "./server-timing";

describe("Server-Timing phases", () => {
  it("adds durations and counts per phase within one request, in a fixed order", async () => {
    const header = await withTimings(async (t) => {
      addTiming("kv", 1.24);
      addTiming("kv", 2);
      await timed("stalwart", async () => undefined);
      addTiming("rate", 0.5);
      return serverTimingHeader(t, 12.34);
    });
    expect(header).toMatch(/^total;dur=12\.3, rate;dur=0\.5, kv;dur=3\.2;desc="x2", stalwart;dur=\d+(\.\d)?$/);
  });

  it("records a phase that throws, and nothing outside a request", async () => {
    expect(currentTimings()).toBeUndefined();
    addTiming("kv", 5);
    await expect(timed("db", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    const fields = await withTimings(async (t) => {
      await expect(timed("db", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
      return timingFields(t, 3.6);
    });
    expect(fields).toMatchObject({ totalMs: 4, dbCount: 1 });
    expect(Object.keys(fields)).toEqual(["totalMs", "dbMs", "dbCount"]);
  });

  it("keeps requests apart", async () => {
    const [a, b] = await Promise.all([
      withTimings(async (t) => {
        addTiming("kv", 1);
        await new Promise((r) => setTimeout(r, 5));
        return serverTimingHeader(t, 1);
      }),
      withTimings(async (t) => {
        addTiming("stalwart", 1);
        return serverTimingHeader(t, 1);
      }),
    ]);
    expect(a).toBe("total;dur=1, kv;dur=1");
    expect(b).toBe("total;dur=1, stalwart;dur=1");
  });

  it("only ever carries the fixed phase names and numbers", async () => {
    const header = await withTimings(async (t) => {
      for (const p of ["rate", "access", "delegation", "password", "kv", "kvhit", "db", "refresh", "queue"] as const) {
        addTiming(p, 1);
      }
      await timed("handler", () => timed("stalwart", async () => undefined));
      return serverTimingHeader(t, 9);
    });
    for (const part of header.split(", ")) expect(part).toMatch(/^[a-z]+;dur=[\d.]+(;desc="x\d+")?$/);
  });
});
