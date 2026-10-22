// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { workerPlatform } from "./platform";

describe("workerPlatform", () => {
  it("defaults to the product domain outside production", () => {
    expect(workerPlatform({ NODE_ENV: "development" }).hosts.mx).toEqual(["mx1.anhourmail.com"]);
    expect(workerPlatform({}).domain).toBe("anhourmail.com");
  });

  it("uses the configured domain in production when the console is directly under it", () => {
    const p = workerPlatform({
      NODE_ENV: "production",
      PLATFORM_DOMAIN: "staging.example.org",
      APP_URL: "https://app.staging.example.org",
    });
    expect(p.spfInclude).toBe("_spf.staging.example.org");
  });

  it("refuses to start in production without an explicit PLATFORM_DOMAIN", () => {
    expect(() => workerPlatform({ NODE_ENV: "production", APP_URL: "https://app.anhourmail.com" })).toThrow(
      /PLATFORM_DOMAIN must be set explicitly in production/,
    );
  });

  it("refuses to start in production when APP_URL isn't directly under PLATFORM_DOMAIN", () => {
    for (const APP_URL of ["https://app.staging.anhourmail.com", "https://console.other.example", undefined, "nope"]) {
      expect(() => workerPlatform({ NODE_ENV: "production", PLATFORM_DOMAIN: "anhourmail.com", APP_URL })).toThrow(
        /APP_URL must be a host directly under PLATFORM_DOMAIN \(anhourmail\.com\)/,
      );
    }
  });

  it("refuses an unusable PLATFORM_DOMAIN anywhere", () => {
    expect(() => workerPlatform({ PLATFORM_DOMAIN: "https://example.org" })).toThrow(/PLATFORM_DOMAIN/);
  });
});
