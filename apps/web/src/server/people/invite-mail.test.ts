// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { systemClock } from "@anhourmail/core";
import type { SentInvite } from "@anhourmail/core/people";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { setContainerForTests } from "../container";
import { resetEnvForTests } from "../env";
import { sendInviteEmail } from "./invite-mail";

const sent: SentInvite = {
  accountName: "Family A",
  token: "T".repeat(43),
  invite: {
    id: "i1",
    email: "new@example.test",
    role: "user_admin",
    sentAt: new Date(),
    expiresAt: new Date(),
    expired: false,
    canManage: true,
  },
};

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

describe("sendInviteEmail", () => {
  it("emails the single-use link with the inviter, account and role, and no tracking", async () => {
    expect(await sendInviteEmail(sent, { name: " Sam ", email: "sam@example.test" })).toBe(true);
    const [m] = mailer.sent;
    expect(m?.to).toBe("new@example.test");
    expect(m?.subject).toBe("You've been invited to an AnhourMail account");
    expect(m?.text).toContain("Sam invited you to join Family A");
    expect(m?.text).toContain(`http://localhost:43200/invite/${"T".repeat(43)}`);
    expect(m?.text).toContain("as User Administrator");
    expect(m?.text).toContain("for 7 days");
    expect(m?.html).not.toContain("<img");
  });

  it("falls back to the inviter's email, and reports a failed send without logging the token", async () => {
    await sendInviteEmail(sent, { email: "sam@example.test" });
    expect(mailer.sent[0]?.text).toContain("sam@example.test invited you");
    mailer.send = async () => {
      throw new Error("smtp down");
    };
    expect(await sendInviteEmail(sent, { name: "", email: "sam@example.test" })).toBe(false);
    expect(logged.join("\n")).toContain("invite email failed");
    expect(logged.join("\n")).not.toContain("T".repeat(43));
  });
});
