// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Folder } from "./mail-client";
import {
  adjustUnread,
  coalescer,
  MAX_POLL_MS,
  newMailToAnnounce,
  notificationHelp,
  POLL_MS,
  pollDelay,
  raceFirstPaint,
  shouldPoll,
  tabTitle,
} from "./sync";

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

  it("names a shared mailbox's tab by its address", () => {
    expect(tabTitle("Inbox", 0, { mailbox: "desk@example.com" })).toBe("desk@example.com · Inbox");
    expect(tabTitle("Sent", 2, { mailbox: "desk@example.com" })).toBe("(2) desk@example.com · Sent");
    expect(tabTitle(null, 0, { mailbox: "desk@example.com" })).toBe("desk@example.com");
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

describe("coalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once for changes close together, after the delay", async () => {
    const run = vi.fn(() => Promise.resolve());
    const c = coalescer(run, 300);
    c.schedule();
    c.schedule();
    await vi.advanceTimersByTimeAsync(200);
    c.schedule();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs once more after a run in flight when a change arrives meanwhile, never two at a time", async () => {
    let finish: () => void = () => undefined;
    let inFlight = 0;
    let most = 0;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          finish = () => {
            inFlight -= 1;
            resolve();
          };
        }),
    );
    const c = coalescer(run, 300);
    c.schedule();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(1);
    c.schedule();
    c.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(300);
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it("keeps working after a failed run", async () => {
    const run = vi.fn(() => Promise.reject(new Error("offline")));
    const c = coalescer(run, 10);
    c.schedule();
    await vi.advanceTimersByTimeAsync(10);
    c.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs nothing once cancelled", async () => {
    const run = vi.fn(() => Promise.resolve());
    const c = coalescer(run, 300);
    c.schedule();
    c.cancel();
    c.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("adjustUnread", () => {
  const folder = (id: string, unreadEmails: number): Folder => ({
    id,
    name: id,
    role: null,
    parentId: null,
    sortOrder: 0,
    totalEmails: 10,
    unreadEmails,
    totalThreads: 10,
    unreadThreads: unreadEmails,
  });
  const folders = [folder("inbox", 2), folder("work", 1), folder("sent", 0)];

  it("takes one off each folder of a message that becomes read", () => {
    const next = adjustUnread(folders, [{ mailboxIds: { inbox: true, work: true }, keywords: {} }], true);
    expect(next.map((f) => f.unreadEmails)).toEqual([1, 0, 0]);
    expect(next[2]).toBe(folders[2]);
  });

  it("adds one for a message marked unread, and ignores messages already in that state", () => {
    const next = adjustUnread(
      folders,
      [
        { mailboxIds: { inbox: true }, keywords: { $seen: true } },
        { mailboxIds: { work: true }, keywords: {} },
      ],
      false,
    );
    expect(next.map((f) => f.unreadEmails)).toEqual([3, 1, 0]);
  });

  it("never goes below zero and leaves the list alone when nothing flips", () => {
    expect(adjustUnread(folders, [{ mailboxIds: { sent: true }, keywords: {} }], true)[2]?.unreadEmails).toBe(0);
    expect(adjustUnread(folders, [{ mailboxIds: { inbox: true }, keywords: { $seen: true } }], true)).toBe(folders);
    expect(adjustUnread(folders, [{ mailboxIds: { inbox: false }, keywords: {} }], true)).toBe(folders);
  });
});

describe("raceFirstPaint", () => {
  const deferred = <T>() => {
    let resolve: (v: T) => void = () => undefined;
    let reject: (e: unknown) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const run = (
    cached: Promise<string | null> | null,
    fresh: Promise<string>,
    fatalErr: unknown = null,
    live = () => true,
  ) => {
    const shown: string[] = [];
    let fellBack = false;
    const done = raceFirstPaint({
      cached,
      fresh,
      showCached: (c) => shown.push(`cached:${c}`),
      showFresh: (f) => shown.push(`fresh:${f}`),
      fallback: async () => {
        fellBack = true;
      },
      fatal: (err) => err === fatalErr,
      live,
    });
    return { shown, done, fellBack: () => fellBack };
  };

  it("shows this browser's copy first, then the server's answer over it", async () => {
    const c = deferred<string | null>();
    const f = deferred<string>();
    const r = run(c.promise, f.promise);
    c.resolve("copy");
    await tick();
    f.resolve("server");
    await r.done;
    expect(r.shown).toEqual(["cached:copy", "fresh:server"]);
  });

  it("never shows the copy once the server's answer is in, or when there is none", async () => {
    const c = deferred<string | null>();
    const r = run(c.promise, Promise.resolve("server"));
    await r.done;
    c.resolve("copy");
    await tick();
    expect(r.shown).toEqual(["fresh:server"]);
    const none = run(Promise.resolve(null), Promise.resolve("server"));
    await none.done;
    expect(none.shown).toEqual(["fresh:server"]);
    const failing = run(Promise.reject(new Error("no storage")), Promise.resolve("server"));
    await failing.done;
    expect(failing.shown).toEqual(["fresh:server"]);
    const scoped = run(null, Promise.resolve("server"));
    await scoped.done;
    expect(scoped.shown).toEqual(["fresh:server"]);
  });

  it("falls back to the step-by-step load when the server's answer fails, but not when signed out", async () => {
    const r = run(null, Promise.reject(new Error("503")));
    await r.done;
    expect(r.fellBack()).toBe(true);
    const signedOut = new Error("signed out");
    const out = run(null, Promise.reject(signedOut), signedOut);
    await expect(out.done).rejects.toBe(signedOut);
    expect(out.fellBack()).toBe(false);
  });

  it("shows nothing once the page has gone", async () => {
    let live = true;
    const c = deferred<string | null>();
    const f = deferred<string>();
    const r = run(c.promise, f.promise, null, () => live);
    live = false;
    c.resolve("copy");
    f.resolve("server");
    await r.done;
    expect(r.shown).toEqual([]);
  });
});
