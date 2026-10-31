// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { ANONYMOUS, systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { LIMITS } from "@anhourmail/server/rate-limit";

import { setContainerForTests } from "@/server/container";
import { resetEnvForTests } from "@/server/env";

import { GET } from "./route";

const LIMIT = String(LIMITS.webmail.limit);

vi.mock("@/server/auth/actor", () => ({ getActor: async () => ANONYMOUS }));

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

const request = (method: string, path: string, origin = "http://localhost:43300", body?: unknown): Request =>
  new Request(`http://localhost:43300${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      host: "localhost:43300",
      origin,
      "x-webmail-account": "acc1",
      // A console session never grants the webmail.
      cookie: "am.session_token=console-session",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const params = () => ({ params: Promise.resolve({}) });

describe("the webmail first-load route", () => {
  it("answers 401 without a webmail session, with where the time went and its rate limit", async () => {
    const res = await GET(
      request("GET", "/api/webmail/bootstrap?start=inbox&grouping=conversations&chips=0"),
      params(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("ratelimit-limit")).toBe(LIMIT);
    // Phase names and numbers only.
    const timing = res.headers.get("server-timing") ?? "";
    expect(timing).toMatch(/^total;dur=[\d.]+/);
    for (const part of timing.split(", ")) expect(part).toMatch(/^[a-z]+;dur=[\d.]+(;desc="x\d+")?$/);
  });
});
