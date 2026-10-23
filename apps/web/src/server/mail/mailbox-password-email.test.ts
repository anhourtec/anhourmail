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
import { sendMailboxPasswordResetNotice } from "./mailbox-password-email";

const at = new Date("2026-10-23T12:00:00Z");

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

describe("sendMailboxPasswordResetNotice", () => {
  it("tells the person which mailbox was given a new password, by whom, and what it ends — never the password", async () => {
    await sendMailboxPasswordResetNotice("person@example.test", { address: "kid@family.test", by: "admin", at });
    const [m] = mailer.sent;
    expect(m?.to).toBe("person@example.test");
    expect(m?.subject).toBe("Your mailbox password was changed");
    expect(m?.text).toContain("An administrator of your account set a new password for kid@family.test");
    expect(m?.text).toContain("Oct 23, 2026");
    expect(m?.text).toContain("Webmail sessions for this mailbox are signed out");
    expect(m?.text).toContain("http://localhost:43300");
    // Only the embedded logo: no remote images or tracking pixels.
    expect(m?.html).not.toMatch(/<img[^>]+src="(?!cid:)/);
    await sendMailboxPasswordResetNotice("person@example.test", { address: "kid@family.test", by: "self", at });
    expect(mailer.sent[1]?.text).toContain("You set a new password for kid@family.test");
    await sendMailboxPasswordResetNotice("person@example.test", { address: "kid@family.test", by: "webmail", at });
    expect(mailer.sent[2]?.text).toContain("The password for kid@family.test was changed in the webmail");
    expect(mailer.sent[2]?.text).toContain("Other webmail sessions");
  });

  it("logs a failed send by error name only, and doesn't throw", async () => {
    mailer.send = async () => {
      throw new TypeError("smtp down");
    };
    await expect(
      sendMailboxPasswordResetNotice("person@example.test", { address: "kid@family.test", by: "admin", at }),
    ).resolves.toBeUndefined();
    const out = logged.join("\n");
    expect(out).toContain("mailbox password notice failed");
    expect(out).toContain("TypeError");
    expect(out).not.toContain("person@example.test");
  });
});
