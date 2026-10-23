// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  emailVerificationEmail,
  firstFactorEmail,
  forwardingConfirmEmail,
  inviteEmail,
  passkeyAddedEmail,
  passwordResetEmail,
} from "./system-email";

describe("security notices", () => {
  it("a new passkey: the name given quoted in mono, when, and what to do if it wasn't them", () => {
    const m = passkeyAddedEmail({
      to: "kim@example.test",
      passkeyName: "<b>Laptop</b>",
      at: new Date("2026-10-22T09:30:00Z"),
      securityUrl: "https://app.example.test/security",
      site: "example.test",
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
      site: "example.test",
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

describe("email confirmation", () => {
  it("names the link's lifetime, carries the link once, and says what happens if it wasn't them", () => {
    const url = "https://app.example.test/api/auth/verify-email?token=abc&callbackURL=%2Femail-verified";
    const m = emailVerificationEmail({ to: "kim@example.test", url, hours: 24, site: "example.test" });
    expect(m.subject).toBe("Confirm your email address for AnhourMail");
    // Never the name typed at sign-up (anyone can sign up with someone else's address).
    expect(m.text.startsWith("Hi,")).toBe(true);
    expect(m.text).toContain("The link works for 24 hours.");
    expect(m.text).toContain(`Confirm your email address: ${url}`);
    expect(m.text).toContain("If you didn't sign up for AnhourMail, ignore this email");
    expect(m.html).toContain("verify-email?token=abc&#38;callbackURL=%2Femail-verified");
  });
});

describe("every system email uses the shared layout", () => {
  const site = "example.test";
  const all = [
    passwordResetEmail({ to: "kim@example.test", name: "Kim", url: "https://app.example.test/reset?token=t", site }),
    inviteEmail({
      to: "sam@example.test",
      accountName: "Family <A>",
      inviter: "Kim",
      role: "Member",
      url: "https://app.example.test/invite/t",
      days: 7,
      site,
    }),
    passkeyAddedEmail({
      to: "kim@example.test",
      passkeyName: "Laptop",
      at: new Date("2026-10-22T09:30:00Z"),
      securityUrl: "https://app.example.test/security",
      site,
    }),
    forwardingConfirmEmail({
      to: "out@example.test",
      mailbox: "k***@family.test",
      url: "https://mail.example.test/forwarding/confirm/t",
      hours: 24,
      site,
    }),
    emailVerificationEmail({
      to: "kim@example.test",
      url: "https://app.example.test/verify?t=1",
      hours: 24,
      site,
    }),
  ];

  it("embeds the logo, links the site plainly, and keeps the text part's footer", () => {
    for (const m of all) {
      expect(m.attachments?.map((a) => a.cid)).toEqual(["logo-light@anhourmail", "logo-dark@anhourmail"]);
      expect(m.html).toContain('src="cid:logo-light@anhourmail"');
      expect(m.html).not.toMatch(/<img[^>]+src="https?:/);
      expect(m.html).toContain('href="https://example.test"');
      expect(m.text).toContain("AnhourMail by Anhourtec");
      expect(m.text).toContain("https://example.test");
    }
  });

  it("keeps each email's wording: expiry, what to ignore, and why it was sent", () => {
    const [reset, invite, , forwarding, verify] = all;
    expect(reset?.text).toContain("use this link within an hour");
    expect(reset?.text).toContain("If you didn't ask, ignore this email");
    expect(reset?.text).toContain("Reset your password: https://app.example.test/reset?token=t");
    expect(invite?.subject).toBe("You've been invited to an AnhourMail account");
    expect(invite?.text).toContain("You've been invited to join an account on AnhourMail as Member.");
    // People-chosen names are quoted facts, never part of our sentences (run-28 C2).
    expect(invite?.text).toContain('Account: "Family <A>"');
    expect(invite?.text).toContain('Invited by: "Kim"');
    expect(invite?.text).not.toContain("Kim invited you");
    expect(invite?.text).toContain("for 7 days");
    expect(invite?.html).toMatch(/<code class="am-code"[^>]*>&quot;Family &#60;A&#62;&quot;<\/code>/);
    expect(invite?.html).toMatch(/<code class="am-code"[^>]*>&quot;Kim&quot;<\/code>/);
    // Inviter-chosen text stays out of what inbox previews show.
    expect(invite?.html).not.toMatch(/display:none[^>]*>[^<]*Family/);
    expect(forwarding?.text).toContain("for 24 hours");
    expect(forwarding?.text).toContain('Mailbox: "k***@family.test"');
    expect(forwarding?.text).toContain("an AnhourMail mailbox asked to forward its mail to this address");
    expect(verify?.text).toMatch(/^Hi,/);
  });
});
