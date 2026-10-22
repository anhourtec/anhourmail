// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { log, setLogSinkForTests } from "@anhourmail/server/log";
import { platformFacts } from "@anhourmail/shared/platform";

import { runBootstrapAdmin, setPasswordEmail } from "./bootstrap-admin";

const logged: string[] = [];
const clock = { now: () => new Date("2026-10-22T12:00:00Z") };

function setup() {
  const uow = new MemoryUnitOfWork();
  const mailer = memoryMailer();
  const deps = { uow, clock, platform: platformFacts("staging-mail.test") };
  const run = (email = "ada@example.org") =>
    runBootstrapAdmin({
      deps,
      mailer,
      appUrl: "https://app.staging-mail.test/",
      input: { email, firstName: "Ada", lastName: "Lovelace" },
      log: log.child({ component: "bootstrap-admin" }),
      requestId: "bootstrap-test",
    });
  return { uow, mailer, run };
}

beforeEach(() => {
  logged.length = 0;
  setLogSinkForTests((line) => logged.push(line));
});
afterEach(() => {
  setLogSinkForTests(null);
});

describe("runBootstrapAdmin", () => {
  it("creates the administrator and emails a one-time link that is never logged", async () => {
    const { uow, mailer, run } = setup();
    expect(await run()).toBe("created");

    const [token] = uow.state.passwordSetTokens.map((t) => t.token);
    expect(token).toBeDefined();
    const [m] = mailer.sent;
    expect(m?.to).toBe("ada@example.org");
    expect(m?.subject).toBe("Set your AnhourMail administrator password");
    expect(m?.text).toContain(`https://app.staging-mail.test/reset-password?token=${token ?? ""}`);
    expect(m?.text).toContain("Hi Ada,");
    expect(m?.html).toContain(`/reset-password?token=${token ?? ""}`);

    const all = logged.join("\n");
    expect(all).toContain("platform administrator created");
    expect(all).not.toContain(token);
    expect(all).not.toContain("reset-password");
    expect(JSON.stringify(uow.state.audit)).not.toContain(token);
    expect(uow.state.audit.at(-1)).toMatchObject({ action: "platform.admin_bootstrapped", result: "success" });
  });

  it("refuses when an administrator already exists, sends nothing and says so", async () => {
    const { uow, mailer, run } = setup();
    uow.state.platformRoles.push({ userId: "existing", role: "global_admin" });
    expect(await run()).toBe("refused");
    expect(mailer.sent).toEqual([]);
    expect(uow.state.passwordSetTokens).toEqual([]);
    expect(logged.join("\n")).toContain("a platform administrator already exists");
    expect(uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "admin_exists" });
  });

  it("refuses an email that already has a console login", async () => {
    const { uow, mailer, run } = setup();
    uow.state.userEmails.someone = "ada@example.org";
    expect(await run()).toBe("refused");
    expect(mailer.sent).toEqual([]);
    expect(logged.join("\n")).toContain("already has a console login");
  });

  it("reports a failed email without the link; the login stays for a later password reset", async () => {
    const { uow, mailer, run } = setup();
    mailer.send = () => Promise.reject(new Error("smtp down"));
    expect(await run()).toBe("mail_failed");
    const [token] = uow.state.passwordSetTokens.map((t) => t.token);
    expect(token).toBeDefined();
    expect(uow.state.platformRoles).toHaveLength(1);
    expect(logged.join("\n")).toContain("set-password email failed");
    expect(logged.join("\n")).not.toContain(token);
  });
});

describe("setPasswordEmail", () => {
  it("escapes the HTML part", () => {
    const m = setPasswordEmail({
      to: "a@example.org",
      firstName: "<b>Ada</b>",
      url: "https://x.test/?a=1&b=2",
      minutes: 60,
    });
    expect(m.html).toContain("&#60;b&#62;Ada&#60;/b&#62;");
    expect(m.html).toContain("https://x.test/?a=1&#38;b=2");
    expect(m.text).toContain("within 60 minutes");
  });
});
