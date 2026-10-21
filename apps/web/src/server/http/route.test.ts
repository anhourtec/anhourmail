// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { ANONYMOUS, ForbiddenError, systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { memoryMailer } from "@anhourmail/adapters/mail";

import { setContainerForTests } from "../container";
import { resetEnvForTests } from "../env";
import { logPath, ok, readJson, route } from "./route";

vi.mock("../auth/actor", () => ({ getActor: async () => ANONYMOUS }));

const params = { params: Promise.resolve({}) };
const noDns = { lookup: async () => [] };
let uow: MemoryUnitOfWork;

beforeEach(() => {
  vi.stubEnv("APP_URL", "http://localhost:43200");
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  resetEnvForTests();
  uow = new MemoryUnitOfWork();
  setContainerForTests({
    deps: { uow, clock: systemClock },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: noDns,
  });
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:43200", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("route()", () => {
  it("wraps the response with request id, no-store and rate-limit headers", async () => {
    const res = await route(async () => ok({ hi: 1 }))(
      new Request("http://localhost:43200/api/x", { headers: { "x-request-id": "abcdefgh123" } }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { hi: 1 } });
    expect(res.headers.get("x-request-id")).toBe("abcdefgh123");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("ratelimit-limit")).toBeTruthy();
  });

  it("maps domain errors, bad JSON and unexpected errors", async () => {
    const forbidden = await route(async () => {
      throw new ForbiddenError();
    })(new Request("http://localhost:43200/api/x"), params);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "forbidden" } });
    const bad = await route(async ({ req }) => ok(await readJson(req)))(
      post("http://localhost:43200/api/x", "{nope", { origin: "http://localhost:43200" }),
      params,
    );
    expect(bad.status).toBe(400);
    const boom = await route(async () => {
      throw new Error("secret detail");
    })(new Request("http://localhost:43200/api/x"), params);
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("secret detail");
  });

  it("blocks cross-origin writes and writes without an origin", async () => {
    const handler = async () => ok(true);
    const evil = await route(handler)(
      post("http://localhost:43200/api/x", {}, { origin: "https://evil.example" }),
      params,
    );
    expect(evil.status).toBe(403);
    const same = await route(handler)(
      post("http://localhost:43200/api/x", {}, { origin: "http://localhost:43200" }),
      params,
    );
    expect(same.status).toBe(200);
    const site = await route(handler)(
      post("http://localhost:43200/api/x", {}, { origin: "http://localhost:43100" }),
      params,
    );
    expect(site.status).toBe(403);
    const noOrigin = await route(handler)(post("http://localhost:43200/api/x", {}), params);
    expect(noOrigin.status).toBe(403);
  });

  it("returns 429 past the limit", async () => {
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
    const h = route(async () => ok(true), { limit: "export" });
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await h(new Request("http://localhost:43200/api/export"), params)).status;
    expect(last).toBe(429);
  });
});

describe("security hardening (audit 2026-10-21)", () => {
  it("never logs one-time tokens in paths", () => {
    expect(logPath("/api/auth/reset-password/abc123TOKEN")).toBe("/api/auth/reset-password/[redacted]");
    expect(logPath("/invite/xyz?x=1")).toBe("/invite/[redacted]?x=1");
    expect(logPath("/api/me")).toBe("/api/me");
  });

  it("refuses per-IP routes without a client address in production instead of sharing one bucket", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("APP_URL", "https://app.example.test");
    vi.stubEnv("WEBMAIL_URL", "https://mail.example.test");
    vi.stubEnv("SITE_URL", "https://example.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "y".repeat(48));
    resetEnvForTests();
    const res = await route(async () => ok(true), { limit: "publicForm" })(
      post("https://app.example.test/api/example", {}, { origin: "https://app.example.test" }),
      params,
    );
    expect(res.status).toBe(400);
  });
});
