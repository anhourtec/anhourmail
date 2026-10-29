// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  accountDeletedEmail,
  deletionCancelledEmail,
  deletionScheduledEmail,
  exportReadyEmail,
  loginDeletedEmail,
} from "./data-lifecycle";

const site = "anhourmail.test";
const name = "<b>Evil</b> & Co";

describe("data export and account deletion emails", () => {
  it("export ready: links to the console (never a download), says when it goes", () => {
    const m = exportReadyEmail({
      to: "a@example.test",
      kind: "account",
      expiresAt: new Date("2026-11-05T12:00:00Z"),
      url: "https://app.anhourmail.test/accounts/x/settings",
      site,
    });
    expect(m.subject).toBe("Your AnhourMail account data export is ready");
    expect(m.text).toContain("November 5, 2026");
    expect(m.text).toContain("https://app.anhourmail.test/accounts/x/settings");
    expect(m.html).not.toMatch(/<img[^>]+src="https?:/); // no remote images or pixels
  });

  it("deletion emails show the account name only as an escaped fact, never in the subject", () => {
    const args = { to: "a@example.test", accountName: name, url: "https://app.anhourmail.test/", site };
    for (const m of [
      deletionScheduledEmail({ ...args, deleteAfter: new Date("2026-11-12T00:00:00Z"), isOwner: true }),
      deletionCancelledEmail(args),
      accountDeletedEmail(args),
    ]) {
      expect(m.subject).not.toContain("Evil");
      expect(m.html).not.toContain("<b>Evil</b>");
      expect(m.html).toContain("&#60;b&#62;Evil&#60;/b&#62;");
    }
    const owner = deletionScheduledEmail({ ...args, deleteAfter: new Date("2026-11-12T00:00:00Z"), isOwner: true });
    const member = deletionScheduledEmail({ ...args, deleteAfter: new Date("2026-11-12T00:00:00Z"), isOwner: false });
    expect(owner.text).toContain("You can cancel it");
    expect(member.text).toContain("ask an Owner to cancel");
  });

  it("login deleted: plain confirmation", () => {
    const m = loginDeletedEmail({ to: "a@example.test", url: "https://anhourmail.test", site });
    expect(m.subject).toBe("Your AnhourMail login was deleted");
  });
});
