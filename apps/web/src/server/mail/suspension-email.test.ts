// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { setContainerForTests } from "../container";
import { resetEnvForTests } from "../env";
import { sendSuspensionNotices, suspensionEmail } from "./suspension-email";

let mailer: ReturnType<typeof memoryMailer>;
const logged: string[] = [];

beforeEach(() => {
  vi.stubEnv("APP_URL", "http://localhost:43200/");
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  resetEnvForTests();
  mailer = memoryMailer();
  setContainerForTests({
    deps: { uow: new MemoryUnitOfWork(), clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer,
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: { check: () => Promise.resolve("unknown") },
  });
  logged.length = 0;
  setLogSinkForTests((line) => logged.push(line));
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("suspension notices", () => {
  it("account suspended: plain-words reason, mail kept, the appeal address; never a note", async () => {
    await sendSuspensionNotices(["owner@example.test", "admin@example.test"], {
      subject: "account",
      state: "suspended",
      reason: "spam",
    });
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.test", "admin@example.test"]);
    const [m] = mailer.sent;
    expect(m?.subject).toBe("Your AnhourMail account has been suspended");
    expect(m?.text).toContain("Sending spam");
    expect(m?.text).toContain("Your stored mail is kept");
    expect(m?.text).toContain("support@anhourtec.com");
    expect(m?.text).toContain("http://localhost:43200");
    expect(m?.html).not.toMatch(/<img[^>]+src="(?!cid:)/);
  });

  it("person suspended and restored wording", () => {
    const base = { to: "p@example.test", reason: "abuse" as const, consoleUrl: "https://app.x.test", site: "x.test" };
    const suspended = suspensionEmail({ ...base, subject: "person", state: "suspended" });
    expect(suspended.subject).toBe("Your AnhourMail sign-in has been suspended");
    expect(suspended.text).toContain("You can't sign in to the console");
    expect(suspended.text).toContain("https://app.x.test/sign-in");
    const restored = suspensionEmail({ ...base, subject: "account", state: "restored" });
    expect(restored.subject).toBe("Your AnhourMail account has been restored");
    expect(restored.text).toContain("no longer suspended");
    expect(restored.text).not.toContain("Abuse");
  });

  it("logs a failed send by error name only, keeps going, and doesn't throw", async () => {
    let calls = 0;
    mailer.send = async (msg) => {
      calls += 1;
      if (calls === 1) throw new TypeError("smtp down");
      mailer.sent.push(msg);
      await Promise.resolve();
    };
    await expect(
      sendSuspensionNotices(["a@example.test", "b@example.test"], {
        subject: "person",
        state: "restored",
        reason: "other",
      }),
    ).resolves.toBeUndefined();
    expect(mailer.sent.map((m) => m.to)).toEqual(["b@example.test"]);
    const out = logged.join("\n");
    expect(out).toContain("suspension notice failed");
    expect(out).toContain("TypeError");
    expect(out).not.toContain("a@example.test");
  });
});
