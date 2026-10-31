// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CachedView,
  clearViewCache,
  importViewKey,
  isCachedView,
  MAX_AGE_MS,
  openView,
  readCachedView,
  sealView,
  writeCachedView,
} from "./view-cache";

const NOW = 1_800_000_000_000;
const entry = (over: Record<string, unknown> = {}) => ({
  v: 1,
  address: "pat@example.test",
  start: "inbox",
  grouping: "conversations",
  attachments: false,
  folders: [],
  priorityCount: 0,
  view: { kind: "folder", id: "in" },
  list: { pinned: [], total: 0, rows: [] },
  savedAt: NOW - 1000,
  ...over,
});
const rawKey = () => randomBytes(32).toString("base64url");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("this browser's copy of the first view", () => {
  it("is used only for the mailbox it was saved for, while it is recent and well-formed", () => {
    expect(isCachedView(entry(), "Pat@Example.test", NOW)).toBe(true);
    expect(isCachedView(entry(), "sam@example.test", NOW)).toBe(false);
    expect(isCachedView(entry({ savedAt: NOW - MAX_AGE_MS }), "pat@example.test", NOW)).toBe(false);
    expect(isCachedView(entry({ savedAt: NOW + 3_600_000 }), "pat@example.test", NOW)).toBe(false);
    expect(isCachedView(entry({ v: 2 }), "pat@example.test", NOW)).toBe(false);
    expect(isCachedView(entry({ list: { rows: [] } }), "pat@example.test", NOW)).toBe(false);
    expect(isCachedView(entry({ grouping: "threads" }), "pat@example.test", NOW)).toBe(false);
    expect(isCachedView(null, "pat@example.test", NOW)).toBe(false);
  });

  it("is sealed: nothing readable at rest, and it opens only with this session's key for this address", async () => {
    const key = await importViewKey(rawKey());
    if (!key) throw new Error("no key");
    expect(key.extractable).toBe(false);
    const fresh = entry({ savedAt: Date.now(), list: { pinned: [], total: 1, rows: [{ subject: "Quarterly plan" }] } });
    const sealed = await sealView(fresh as CachedView, key);
    expect(new TextDecoder().decode(sealed.data)).not.toContain("Quarterly");
    expect(await openView(sealed, key, "pat@example.test")).toEqual(fresh);
    // Another session's key (the session ended, a new one began), another address, or altered bytes: nothing.
    const other = await importViewKey(rawKey());
    if (!other) throw new Error("no key");
    expect(await openView(sealed, other, "pat@example.test")).toBeNull();
    expect(await openView(sealed, key, "sam@example.test")).toBeNull();
    const altered = new Uint8Array(sealed.data.slice(0));
    altered[0] = (altered[0] ?? 0) ^ 1;
    expect(await openView({ ...sealed, data: altered.buffer }, key, "pat@example.test")).toBeNull();
    expect(await openView(fresh, key, "pat@example.test")).toBeNull();
  });

  it("has no key without a well-formed one from the server", async () => {
    expect(await importViewKey(null)).toBeNull();
    expect(await importViewKey("short")).toBeNull();
  });

  it("does nothing, and never throws, without a key or where the browser has no IndexedDB", async () => {
    const key = await importViewKey(rawKey());
    const e = {
      address: "pat@example.test",
      start: "inbox",
      grouping: "conversations" as const,
      attachments: false,
      folders: [],
      priorityCount: 0,
      view: { kind: "priority" as const },
      list: { pinned: [], total: 0, rows: [] },
    };
    await writeCachedView(e, null);
    await writeCachedView(e, key);
    expect(await readCachedView("pat@example.test", key)).toBeNull();
    expect(await readCachedView("pat@example.test", null)).toBeNull();
    await expect(clearViewCache()).resolves.toBeUndefined();
  });
});

describe("a clear in one tab", () => {
  /** A localStorage shared by the "tabs" (module instances) of one browser. */
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        m.set(k, v);
      },
    };
  };
  const tab = async () => {
    vi.resetModules();
    return import("./view-cache");
  };

  it("stops every other tab of the browser from writing (epoch and broadcast)", async () => {
    vi.stubGlobal("localStorage", storage());
    const a = await tab();
    const b = await tab();
    expect(a.writesAllowed()).toBe(true);
    expect(b.writesAllowed()).toBe(true);
    await a.clearViewCache();
    expect(a.writesAllowed()).toBe(false);
    // The epoch moved: tab B refuses even before the broadcast arrives.
    expect(b.writesAllowed()).toBe(false);
    // A tab opened after the clear (a new sign-in) writes again.
    const c = await tab();
    expect(c.writesAllowed()).toBe(true);
  });

  it("reaches other tabs over the channel even without localStorage", async () => {
    const a = await tab();
    const b = await tab();
    await a.clearViewCache();
    await vi.waitFor(() => {
      expect(b.writesAllowed()).toBe(false);
    });
  });
});
