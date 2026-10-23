// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { systemClock } from "@anhourmail/core";
import type { CreatedAppPassword } from "@anhourmail/core/app-passwords";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { setContainerForTests } from "../container";
import { resetEnvForTests } from "../env";
import { sendAppPasswordNotice } from "./app-password-email";

const SECRET = `app_${"k3".repeat(18)}`;
const created: CreatedAppPassword = {
  secret: SECRET,
  address: "kid@family.test",
  appPassword: {
    id: "p1",
    name: "Phone <b>",
    protocols: ["imap", "smtp"],
    status: "active",
    createdAt: new Date("2026-10-22T12:00:00Z"),
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

describe("sendAppPasswordNotice", () => {
  it("tells the person which mailbox and name, links to the page, and never includes the password", async () => {
    await sendAppPasswordNotice("person@example.test", "acc-1", created);
    const [m] = mailer.sent;
    expect(m?.to).toBe("person@example.test");
    expect(m?.subject).toBe("An app password was created for your mailbox");
    expect(m?.text).toContain("kid@family.test");
    expect(m?.text).toContain('"Phone <b>"');
    expect(m?.text).toContain("Oct 22, 2026");
    expect(m?.text).toContain("http://localhost:43200/accounts/acc-1/app-passwords");
    expect(m?.html).toContain("Phone &#60;b&#62;");
    expect(`${m?.text ?? ""}${m?.html ?? ""}`).not.toContain(SECRET);
    // Only the embedded logo: no remote images or tracking pixels.
    expect(m?.html).not.toMatch(/<img[^>]+src="(?!cid:)/);
  });

  it("logs a failed send by error name only, and doesn't throw", async () => {
    mailer.send = async () => {
      throw new TypeError("smtp down");
    };
    await expect(sendAppPasswordNotice("person@example.test", "acc-1", created)).resolves.toBeUndefined();
    const out = logged.join("\n");
    expect(out).toContain("app password notice failed");
    expect(out).toContain("TypeError");
    expect(out).not.toContain("person@example.test");
    expect(out).not.toContain(SECRET);
  });
});
