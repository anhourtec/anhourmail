// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { firstFactorEmail, passkeyAddedEmail } from "./system-email";

describe("security notices", () => {
  it("a new passkey: the name given quoted in mono, when, and what to do if it wasn't them", () => {
    const m = passkeyAddedEmail({
      to: "kim@example.test",
      passkeyName: "<b>Laptop</b>",
      at: new Date("2026-10-22T09:30:00Z"),
      securityUrl: "https://app.example.test/security",
    });
    expect(m.to).toBe("kim@example.test");
    expect(m.subject).toBe("A passkey was added to your AnhourMail login");
    expect(m.text).toContain('Name given: "<b>Laptop</b>"');
    expect(m.text).toContain("If this wasn't you, remove it and change your password");
    expect(m.text).toContain("UTC");
    expect(m.text).toContain("https://app.example.test/security");
    expect(m.html).toContain("<code");
    expect(m.html).toContain("&#60;b&#62;Laptop&#60;/b&#62;");
    expect(m.html).not.toContain("<b>Laptop</b>");
  });

  it("a first factor under a requirement: one wording for the person, another for Owners", () => {
    const base = {
      person: "kim@example.test",
      accountName: "Family A",
      factor: "passkey" as const,
      at: new Date("2026-10-22T09:30:00Z"),
      securityUrl: "https://app.example.test/security",
    };
    const own = firstFactorEmail({ ...base, to: "kim@example.test", forOwner: false });
    expect(own.text).toContain("A passkey was set up");
    expect(own.text).toContain("If this wasn't you, change your password");
    const owner = firstFactorEmail({ ...base, to: "sam@example.test", forOwner: true });
    expect(owner.subject).toBe("Someone in your account set up two-step sign-in");
    expect(owner.text).toContain("kim@example.test set up a passkey");
    expect(owner.text).toContain("(required by Family A)");
  });
});
