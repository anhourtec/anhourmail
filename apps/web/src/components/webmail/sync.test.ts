// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { MAX_POLL_MS, newMailToAnnounce, notificationHelp, POLL_MS, pollDelay, shouldPoll, tabTitle } from "./sync";

describe("polling", () => {
  it("checks every 30 seconds and backs off after failures, up to 5 minutes", () => {
    expect(pollDelay(0)).toBe(POLL_MS);
    expect(pollDelay(1)).toBe(60_000);
    expect(pollDelay(2)).toBe(120_000);
    expect(pollDelay(3)).toBe(240_000);
    expect(pollDelay(4)).toBe(MAX_POLL_MS);
    expect(pollDelay(50)).toBe(MAX_POLL_MS);
  });

  it("only checks while the tab is visible and online", () => {
    expect(shouldPoll("visible", true)).toBe(true);
    expect(shouldPoll("hidden", true)).toBe(false);
    expect(shouldPoll("visible", false)).toBe(false);
  });
});

describe("newMailToAnnounce", () => {
  const ctx = { inboxId: "in", junkId: "junk", mine: new Set(["me@dev.test"]), firstCheck: false };
  const mail = (over: Partial<Parameters<typeof newMailToAnnounce>[0][number]> = {}) => ({
    id: "e1",
    mailboxIds: { in: true },
    keywords: {},
    from: [{ name: "Sam", email: "sam@example.org" }],
    ...over,
  });

  it("announces new unread Inbox mail from someone else", () => {
    expect(newMailToAnnounce([mail()], ctx)).toHaveLength(1);
  });

  it("stays quiet on the first check", () => {
    expect(newMailToAnnounce([mail()], { ...ctx, firstCheck: true })).toEqual([]);
  });

  it("stays quiet for your own mail, Junk, other folders, read mail and drafts", () => {
    expect(newMailToAnnounce([mail({ from: [{ name: null, email: "ME@dev.test" }] })], ctx)).toEqual([]);
    expect(newMailToAnnounce([mail({ mailboxIds: { junk: true } })], ctx)).toEqual([]);
    expect(newMailToAnnounce([mail({ mailboxIds: { in: true, junk: true } })], ctx)).toEqual([]);
    expect(newMailToAnnounce([mail({ mailboxIds: { archive: true } })], ctx)).toEqual([]);
    expect(newMailToAnnounce([mail({ keywords: { $seen: true } })], ctx)).toEqual([]);
    expect(newMailToAnnounce([mail({ keywords: { $draft: true } })], ctx)).toEqual([]);
    expect(newMailToAnnounce([mail()], { ...ctx, inboxId: undefined })).toEqual([]);
  });
});

describe("tabTitle", () => {
  it("shows the view and the unread Inbox count", () => {
    expect(tabTitle("Inbox", 1)).toBe("(1) Inbox · AnhourMail");
    expect(tabTitle("Archive", 0)).toBe("Archive · AnhourMail");
    expect(tabTitle(null, 0)).toBe("AnhourMail");
  });
});

describe("desktop notification help", () => {
  it("explains how to allow blocked notifications and says nothing once they are allowed", () => {
    expect(notificationHelp("granted")).toBeNull();
    expect(notificationHelp("denied")).toMatch(/site settings.*Allow/);
    expect(notificationHelp("default")).toMatch(/choose Allow/);
    expect(notificationHelp("unsupported")).toMatch(/can't show/);
  });
});
