// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

const get = (url: string, headers: Record<string, string> = {}) => proxy(new NextRequest(url, { headers }));

describe("webmail pages are never cached", () => {
  it("answers no-store for the webmail page and its RSC payload, signed in or redirected", () => {
    vi.stubEnv("WEBMAIL_DEV_PORT", "43300");
    const cookie = { cookie: "am.webmail=x".padEnd(60, "x"), host: "localhost:43300" };
    for (const res of [
      get("http://localhost:43300/", cookie),
      get("http://localhost:43300/", { ...cookie, rsc: "1" }),
      get("http://localhost:43300/mailbox/desk%40example.test/", cookie),
      get("http://localhost:43300/", { host: "localhost:43300" }),
    ]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("leaves console pages to Next", () => {
    vi.stubEnv("WEBMAIL_DEV_PORT", "43300");
    const res = get("http://localhost:43200/sign-in", { host: "localhost:43200" });
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("dev-only paths (ADR-0029 §3, guard layer 3)", () => {
  it("answers 404 for the fake billing pages and the simulate route on production builds, before routing", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const path of ["/dev/billing/checkout/cs_1", "/api/dev/billing/simulate", "/%64ev/billing/portal/cus_1"]) {
      const res = get(`https://app.anhourmail.com${path}`, { host: "app.anhourmail.com" });
      expect(res.status).toBe(404);
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    }
  });

  it("lets them through in development (the pages check billing themselves)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = get("http://localhost:43200/dev/billing/checkout/cs_1", { host: "localhost:43200" });
    expect(res.status).toBe(200);
  });
});
