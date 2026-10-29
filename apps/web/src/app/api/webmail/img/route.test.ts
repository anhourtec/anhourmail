// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { ANONYMOUS, systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { setContainerForTests } from "@/server/container";
import { resetEnvForTests } from "@/server/env";

import { POST } from "./route";

vi.mock("@/server/auth/actor", () => ({ getActor: async () => ANONYMOUS }));

const params = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.stubEnv("APP_URL", "http://localhost:43200");
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  resetEnvForTests();
  setContainerForTests({
    deps: { uow: new MemoryUnitOfWork(), clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: { check: () => Promise.resolve("unknown") },
  });
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const post = (headers: Record<string, string>) =>
  new Request("http://localhost:43300/api/webmail/img", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:43300", ...headers },
    body: JSON.stringify({ token: "v1.1.aHR0cDovLzEyNy4wLjAuMS8.x" }),
  });

describe("POST /api/webmail/img", () => {
  it("answers 401 without a webmail session", async () => {
    const res = await POST(post({ origin: "http://localhost:43300" }), params);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("refuses a cross-origin request before anything else", async () => {
    const res = await POST(post({ origin: "https://evil.example" }), params);
    expect(res.status).toBe(403);
  });

  it("is rate limited per caller (the webmailImage tier)", async () => {
    const res = await POST(post({ origin: "http://localhost:43300" }), params);
    expect(res.headers.get("ratelimit-limit")).toBe("300");
  });
});
