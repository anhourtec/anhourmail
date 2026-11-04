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

import { GET as GET_RULES, PUT as PUT_RULES } from "../rules/route";
import { DELETE, PATCH } from "./[templateId]/route";
import { GET, POST } from "./route";

vi.mock("@/server/auth/actor", () => ({ getActor: async () => ANONYMOUS }));

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

const request = (method: string, path: string, origin = "http://localhost:43300", body?: unknown) =>
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

const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });

describe("webmail template and mail rules routes", () => {
  it("answer 401 without a webmail session, whatever the method", async () => {
    const calls: Promise<Response>[] = [
      GET(request("GET", "/api/webmail/settings/templates"), params()),
      POST(request("POST", "/api/webmail/settings/templates", undefined, { name: "A", html: "<p>A</p>" }), params()),
      PATCH(
        request("PATCH", `/api/webmail/settings/templates/${ID}`, undefined, { name: "B" }),
        params({ templateId: ID }),
      ),
      DELETE(request("DELETE", `/api/webmail/settings/templates/${ID}`), params({ templateId: ID })),
      GET_RULES(request("GET", "/api/webmail/settings/rules"), params()),
      PUT_RULES(request("PUT", "/api/webmail/settings/rules", undefined, { rules: [], version: null }), params()),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  it("refuse cross-origin changes before anything else", async () => {
    for (const res of [
      await POST(
        request("POST", "/api/webmail/settings/templates", "https://evil.example", { name: "A", html: "<p>A</p>" }),
        params(),
      ),
      await DELETE(
        request("DELETE", `/api/webmail/settings/templates/${ID}`, "https://evil.example"),
        params({ templateId: ID }),
      ),
      await PUT_RULES(
        request("PUT", "/api/webmail/settings/rules", "https://evil.example", { rules: [], version: null }),
        params(),
      ),
    ]) {
      expect(res.status).toBe(403);
    }
  });

  it("are rate limited: reads on the settings tier, changes on the write tier", async () => {
    expect(
      (await GET(request("GET", "/api/webmail/settings/templates"), params())).headers.get("ratelimit-limit"),
    ).toBe("60");
    expect(
      (await GET_RULES(request("GET", "/api/webmail/settings/rules"), params())).headers.get("ratelimit-limit"),
    ).toBe("60");
    const write = await PUT_RULES(
      request("PUT", "/api/webmail/settings/rules", undefined, { rules: [], version: null }),
      params(),
    );
    expect(write.headers.get("ratelimit-limit")).toBe("120");
  });
});
