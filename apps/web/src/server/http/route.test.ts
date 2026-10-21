// SPDX-License-Identifier: AGPL-3.0-only
import type * as NextServerModule from "next/server";
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
// `after()` needs a Next request scope; outside one, collect the deferred work so tests can await it.
type NextServer = typeof NextServerModule;
const deferred: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<NextServer>()),
  after: (task: () => Promise<unknown>) => {
    deferred.push(task());
  },
}));

const params = { params: Promise.resolve({}) };
const noDns = { lookup: async () => [] };
let uow: MemoryUnitOfWork;
let mailer: ReturnType<typeof memoryMailer>;

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
  mailer = memoryMailer();
  setContainerForTests({ deps: { uow, clock: systemClock }, counter: memoryCounter(), mailer, dns: noDns });
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

  it("blocks cross-origin writes; public routes accept the site origin", async () => {
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
    const site = await route(handler, { origin: "public" })(
      post("http://localhost:43200/api/x", {}, { origin: "http://localhost:43100" }),
      params,
    );
    expect(site.status).toBe(200);
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
    const res = await route(async () => ok(true), { limit: "publicForm", origin: "public" })(
      post("https://app.example.test/api/public/waitlist", {}),
      params,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/public/waitlist", () => {
  it("accepts, stores and audits; answers the same for a duplicate", async () => {
    const { POST } = await import("../../app/api/public/waitlist/route");
    const body = { email: "route@example.com", startedAt: Date.now() - 10_000 };
    const first = await POST(
      post("http://localhost:43200/api/public/waitlist", body, { origin: "http://localhost:43100" }),
      params,
    );
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ data: { status: "accepted" } });
    // The confirmation email is sent after the response (no timing difference between new and known addresses).
    await Promise.all(deferred);
    expect(mailer.sent.map((m) => m.to)).toEqual(["route@example.com"]);
    const again = await POST(post("http://localhost:43200/api/public/waitlist", body), params);
    expect(again.status).toBe(202);
    expect(uow.state.waitlist).toHaveLength(1);
    expect(uow.state.audit.map((e) => e.action)).toEqual(["waitlist.joined", "waitlist.joined"]);
    const invalid = await POST(post("http://localhost:43200/api/public/waitlist", { email: "x" }), params);
    expect(invalid.status).toBe(400);
  });

  it("stops confirmation emails to an address over its daily cap, with the same 202", async () => {
    const { POST } = await import("../../app/api/public/waitlist/route");
    // The per-address email tier is exhausted; the per-IP form tier is not.
    const counter = async (key: string) => (key.includes(":waitlistMail:") ? 99 : 1);
    setContainerForTests({ deps: { uow, clock: systemClock }, counter, mailer, dns: noDns });
    const res = await POST(
      post("http://localhost:43200/api/public/waitlist", {
        email: "capped@example.com",
        startedAt: Date.now() - 10_000,
      }),
      params,
    );
    expect(res.status).toBe(202);
    await Promise.all(deferred);
    expect(mailer.sent).toHaveLength(0);
  });
});
