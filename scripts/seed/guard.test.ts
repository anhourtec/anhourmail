// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { seedRefusal } from "./guard";

const dev = { APP_URL: "http://localhost:43200" };

describe("seedRefusal", () => {
  it("allows a developer machine and CI", () => {
    expect(seedRefusal(dev, [])).toBeNull();
    expect(seedRefusal({ APP_URL: "http://app.localhost:43200", PLATFORM_DOMAIN: "dev-mail.test" }, [])).toBeNull();
    expect(seedRefusal({ APP_URL: "http://127.0.0.1:43200", PLATFORM_DOMAIN: " " }, ["--demo"])).toBeNull();
  });

  it("refuses NODE_ENV=production unless --force-dev-seed", () => {
    expect(seedRefusal({ ...dev, NODE_ENV: "production" }, [])).toMatch(/NODE_ENV=production/);
    expect(seedRefusal({ ...dev, NODE_ENV: "production" }, ["--force-dev-seed"])).toBeNull();
  });

  it("refuses a real console address, and --force-dev-seed doesn't override it", () => {
    for (const APP_URL of [
      "https://localhost:43200",
      "http://app.example.org",
      "https://app.staging.example.org",
      "http://192.168.1.20:43200",
      "http://localhost.example.org",
      undefined,
      "not a url",
    ]) {
      expect(seedRefusal({ APP_URL }, [])).not.toBeNull();
      expect(seedRefusal({ APP_URL, NODE_ENV: "production" }, ["--force-dev-seed"])).not.toBeNull();
    }
  });

  it("refuses a real PLATFORM_DOMAIN, even with --force-dev-seed", () => {
    expect(seedRefusal({ ...dev, PLATFORM_DOMAIN: "staging.example.org" }, [])).toMatch(/PLATFORM_DOMAIN/);
    expect(seedRefusal({ ...dev, PLATFORM_DOMAIN: "anhourmail.com" }, ["--force-dev-seed"])).toMatch(/PLATFORM_DOMAIN/);
  });

  it("never echoes the values it refused", () => {
    const msg = seedRefusal({ APP_URL: "https://secret-host.example.org" }, []) ?? "";
    expect(msg).not.toContain("secret-host");
  });
});
