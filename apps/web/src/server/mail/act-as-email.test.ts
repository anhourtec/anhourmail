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
import { actAsEmail, sendActAsNotices } from "./act-as-email";

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

describe("act-as notices", () => {
  const ACCOUNT = "11111111-1111-4111-8111-111111111111";

  it("tells each Owner it's read-only, for how long, the reason and where it's recorded; links to the audit log", async () => {
    await sendActAsNotices(["owner@example.test", "owner2@example.test"], {
      accountId: ACCOUNT,
      reason: "Ticket 1234: DNS help <b>",
      startedAt: new Date("2026-10-29T10:00:00Z"),
    });
    expect(mailer.sent.map((m) => m.to)).toEqual(["owner@example.test", "owner2@example.test"]);
    const [m] = mailer.sent;
    expect(m?.subject).toBe("Anhourtec support opened your AnhourMail account");
    expect(m?.text).toContain("read-only, for up to 30 minutes");
    expect(m?.text).toContain("can't change anything, sign in to webmail or read your mail");
    expect(m?.text).toContain("Ticket 1234: DNS help <b>");
    expect(m?.text).toContain("2026");
    expect(m?.text).toContain(`http://localhost:43200/accounts/${ACCOUNT}/audit`);
    expect(m?.text).toContain("support@anhourtec.com");
    // The staff member's reason is escaped in HTML, and the email loads nothing remote.
    expect(m?.html).not.toContain("<b>");
    expect(m?.html).toContain("&#60;b&#62;");
    expect(m?.html).not.toMatch(/<img[^>]+src="(?!cid:)/);
  });

  it("refuses a non-web audit link", () => {
    expect(() =>
      actAsEmail({
        to: "o@example.test",
        reason: "Ticket 1234",
        startedAt: new Date(),
        auditUrl: "javascript:alert(1)",
        site: "x.test",
      }),
    ).toThrow(/http/);
  });

  it("logs a failed send by error name only and keeps going", async () => {
    let calls = 0;
    mailer.send = async (msg) => {
      calls += 1;
      if (calls === 1) throw new TypeError("smtp down");
      mailer.sent.push(msg);
      await Promise.resolve();
    };
    await sendActAsNotices(["a@example.test", "b@example.test"], {
      accountId: ACCOUNT,
      reason: "Ticket 1234: DNS help",
      startedAt: new Date(),
    });
    expect(mailer.sent.map((m) => m.to)).toEqual(["b@example.test"]);
    const out = logged.join("\n");
    expect(out).toContain("act-as notice failed");
    expect(out).not.toContain("a@example.test");
    expect(out).not.toContain("Ticket 1234");
  });
});
