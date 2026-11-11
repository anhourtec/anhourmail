// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import type { StalwartManagement } from "./management";
import {
  ABUSE_BAN_PERIOD_ENV,
  abuseBanPeriod,
  abuseBanPeriodFromEnv,
  applyAbuseBanPeriod,
  assertNoPrivateAllowedIps,
  overlapsPrivateNetwork,
  parseNetwork,
  privateAllowedIps,
} from "./security";

/** A fake client holding `x:Security` and `x:AllowedIp`, recording updates. */
function fake(opts: { period?: number | null; allowed?: string[] } = {}) {
  const state = { period: opts.period ?? null, updates: [] as Record<string, unknown>[] };
  const mgmt = {
    transport: {
      getAll: async (object: string) => {
        if (object === "x:Security") return [{ id: "singleton", abuseBanPeriod: state.period }];
        if (object === "x:AllowedIp")
          return (opts.allowed ?? []).map((address, i) => ({ id: `a${String(i)}`, address }));
        throw new Error(`unexpected ${object}`);
      },
    },
    updateSingleton: async (object: string, fields: Record<string, unknown>) => {
      if (object !== "x:Security") throw new Error(`unexpected ${object}`);
      state.updates.push(fields);
      if (typeof fields.abuseBanPeriod === "number") state.period = fields.abuseBanPeriod;
    },
  } as unknown as StalwartManagement;
  return { mgmt, state };
}

describe("abuse-ban period", () => {
  it("writes only the period, and only when it differs", async () => {
    const f = fake();
    expect(await abuseBanPeriod(f.mgmt)).toBeNull();
    expect(await applyAbuseBanPeriod(f.mgmt, 3_600_000)).toBe(true);
    expect(f.state.updates).toEqual([{ abuseBanPeriod: 3_600_000 }]);
    expect(await applyAbuseBanPeriod(f.mgmt, 3_600_000)).toBe(false);
    expect(f.state.updates).toHaveLength(1);
  });

  it("refuses a period that isn't a whole number of ms between a minute and thirty days", async () => {
    const f = fake();
    for (const bad of [0, 59_999, 1.5, Number.NaN, 31 * 86_400_000]) {
      await expect(applyAbuseBanPeriod(f.mgmt, bad)).rejects.toThrow(/abuse ban period/);
    }
    expect(f.state.updates).toEqual([]);
  });

  it("reads the period from the environment; production requires it", () => {
    expect(abuseBanPeriodFromEnv({ [ABUSE_BAN_PERIOD_ENV]: "86400000" })).toBe(86_400_000);
    expect(abuseBanPeriodFromEnv({})).toBeNull();
    expect(abuseBanPeriodFromEnv({ [ABUSE_BAN_PERIOD_ENV]: "  " })).toBeNull();
    expect(() => abuseBanPeriodFromEnv({ NODE_ENV: "production" })).toThrow(/must be set in production/);
    expect(() => abuseBanPeriodFromEnv({ [ABUSE_BAN_PERIOD_ENV]: "1h" })).toThrow(/abuse ban period/);
    expect(() => abuseBanPeriodFromEnv({ [ABUSE_BAN_PERIOD_ENV]: "1000" })).toThrow(/abuse ban period/);
  });
});

describe("private ranges on the allow-list", () => {
  it("parses addresses and networks as Stalwart stores them", () => {
    expect(parseNetwork("10.0.0.0/8")).toEqual({ v: 4, bits: 10n << 24n, prefix: 8 });
    expect(parseNetwork("203.0.113.7")?.prefix).toBe(32);
    expect(parseNetwork("2001:db8::1")?.prefix).toBe(128);
    for (const bad of [
      "",
      "10.0.0",
      "10.0.0.256",
      "10.0.0.0/33",
      "1:2:3:4:5:6:7:8:9",
      "::1::2",
      "x/8",
      "1.2.3.4/8/1",
    ]) {
      expect(parseNetwork(bad)).toBeNull();
    }
  });

  it("flags anything inside, equal to or containing a private range", () => {
    for (const hit of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "172.19.0.5",
      "172.20.0.0/16",
      "10.1.2.3/32",
      "0.0.0.0/0",
      "fd00::1",
      "fe80::1/64",
      "::ffff:192.168.1.1",
      "not an address",
    ]) {
      expect([hit, overlapsPrivateNetwork(hit)]).toEqual([hit, true]);
    }
    for (const miss of ["203.0.113.7", "198.51.100.0/24", "172.32.0.1", "11.0.0.0/8", "2001:db8::/32", "127.0.0.1"]) {
      expect([miss, overlapsPrivateNetwork(miss)]).toEqual([miss, false]);
    }
  });

  it("lists the offending entries and refuses them for production", async () => {
    const clean = fake({ allowed: ["203.0.113.7"] });
    expect(await privateAllowedIps(clean.mgmt)).toEqual([]);
    await expect(assertNoPrivateAllowedIps(clean.mgmt)).resolves.toBeUndefined();
    const dev = fake({ allowed: ["10.0.0.0/8", "203.0.113.7", "172.16.0.0/12"] });
    expect(await privateAllowedIps(dev.mgmt)).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    await expect(assertNoPrivateAllowedIps(dev.mgmt)).rejects.toThrow(/2 entries/);
  });
});
