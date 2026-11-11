// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { checkTrustPromoteSettings, trustPromoteSettings } from "./trust";

const ALL = { TRUST_PROMOTE_MIN_AGE_HOURS: "3", TRUST_PROMOTE_MAX_HELD: "4", TRUST_PROMOTE_BATCH: "5" };

describe("trust promotion settings", () => {
  it("reads all three", () => {
    expect(checkTrustPromoteSettings(ALL)).toEqual({ minAgeHours: 3, maxHeld: 4, batch: 5 });
    expect(checkTrustPromoteSettings({ ...ALL, NODE_ENV: "production" })).toEqual({
      minAgeHours: 3,
      maxHeld: 4,
      batch: 5,
    });
  });

  it("outside production, none set turns the job off", () => {
    expect(trustPromoteSettings({})).toEqual({ settings: null, problems: [] });
    expect(checkTrustPromoteSettings({ NODE_ENV: "development", TRUST_PROMOTE_BATCH: " " })).toBeNull();
  });

  it("production refuses to start without every one, naming settings and never values", () => {
    expect(() => checkTrustPromoteSettings({ NODE_ENV: "production" })).toThrow(
      /TRUST_PROMOTE_MIN_AGE_HOURS must be set in production.*TRUST_PROMOTE_MAX_HELD.*TRUST_PROMOTE_BATCH/,
    );
    const { TRUST_PROMOTE_BATCH: _batch, ...two } = ALL;
    expect(() => checkTrustPromoteSettings({ ...two, NODE_ENV: "production" })).toThrow(/TRUST_PROMOTE_BATCH/);
  });

  it("one set without the others, or a value that isn't a whole number in range, is refused anywhere", () => {
    expect(() => checkTrustPromoteSettings({ TRUST_PROMOTE_MIN_AGE_HOURS: "3" })).toThrow(/TRUST_PROMOTE_MAX_HELD/);
    for (const bad of ["0", "-1", "1.5", "abc", "999999999"]) {
      const out = trustPromoteSettings({ ...ALL, TRUST_PROMOTE_MAX_HELD: bad });
      expect(out.settings).toBeNull();
      // The setting and its range only, never the value given.
      expect(out.problems).toEqual(["TRUST_PROMOTE_MAX_HELD must be a whole number from 1 to 100000"]);
    }
  });
});
