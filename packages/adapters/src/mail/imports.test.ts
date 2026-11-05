// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { importDuration, importRoleLine, importSummaryEmail } from "./imports";

const base = {
  to: "kid@example.test",
  address: "kid@family.test",
  startedByRecipient: true,
  startedBy: null,
  status: "completed" as const,
  errorCode: null,
  roles: [
    { role: "inbox" as const, copied: 1204, duplicates: 3, tooLarge: 0, failed: 0 },
    { role: "custom" as const, copied: 10, duplicates: 0, tooLarge: 1, failed: 2 },
  ],
  totals: { copied: 1214, duplicates: 3, tooLarge: 1, failed: 2 },
  startedAt: new Date("2026-11-05T10:00:00Z"),
  finishedAt: new Date("2026-11-05T12:10:00Z"),
  url: "https://app.anhourmail.test/accounts/a/import/i",
  site: "anhourmail.test",
};

describe("import summary email", () => {
  it("counts per role, how long it took, and links to the console", () => {
    const m = importSummaryEmail(base);
    expect(m.subject).toBe("Your mail import is finished");
    expect(m.text).toContain("The import you started into kid@family.test has finished: 1,214 messages copied.");
    expect(m.text).toContain("It took about 2 hours.");
    expect(m.text).toContain("Inbox: 1,204 copied, 3 duplicates skipped");
    expect(m.text).toContain("Other folders: 10 copied, 1 too large, 2 not accepted");
    expect(m.text).toContain("1 message was larger than the per-message limit");
    expect(m.text).toContain(base.url);
    expect(m.html).not.toMatch(/<img[^>]+src="https?:/);
  });

  it("tells the mailbox's person who started it, and says why an import ended early", () => {
    const m = importSummaryEmail({
      ...base,
      startedByRecipient: false,
      startedBy: "admin@family.test",
      status: "failed",
      errorCode: "expired",
      roles: [],
    });
    expect(m.subject).toBe("Your mail import has ended");
    expect(m.text).toContain("The import admin@family.test started into kid@family.test has ended");
    expect(m.text).toContain("longer than its sign-in");
    expect(importSummaryEmail({ ...base, startedByRecipient: false }).text).toContain("The import an admin started");
  });

  it("formats durations and role lines", () => {
    expect(importDuration(20_000)).toBe("less than a minute");
    expect(importDuration(60_000)).toBe("1 minute");
    expect(importDuration(3 * 86_400_000)).toBe("about 3 days");
    expect(importRoleLine({ role: "sent", copied: 1, duplicates: 1, tooLarge: 0, failed: 0 })).toBe(
      "Sent: 1 copied, 1 duplicate skipped",
    );
  });
});
