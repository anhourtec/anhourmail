// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";

import { withTimings } from "../http/server-timing";
import { memoryKv, type SessionKv, type WebmailSession, WebmailSessionStore, withSessionReads } from "./session-store";

const ring = () => createKeyRing([{ id: "t", key: randomBytes(32) }]);
const session = (over: Partial<WebmailSession> = {}): WebmailSession => ({
  username: "a@x.test",
  accountId: "acc",
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: Date.now() + 3_600_000,
  createdAt: Date.now(),
  ...over,
});

/** A KV that counts its reads. */
function counted(): SessionKv & { gets: () => number } {
  const kv = memoryKv();
  let gets = 0;
  return {
    ...kv,
    get: (k) => {
      gets += 1;
      return kv.get(k);
    },
    gets: () => gets,
  };
}

describe("session reads shared within one request", () => {
  it("reads the record once per request, each caller getting its own copy", async () => {
    const kv = counted();
    const store = new WebmailSessionStore(kv, ring());
    const id = await store.create(session());
    await withSessionReads(async () => {
      const a = await store.read(id);
      const b = await store.read(id);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      if (a) a.username = "changed@x.test";
      expect((await store.read(id))?.username).toBe("a@x.test");
    });
    expect(kv.gets()).toBe(1);
    // Outside a request every read goes to the store.
    await store.read(id);
    await store.read(id);
    expect(kv.gets()).toBe(3);
  });

  it("reads afresh after any write, a lost compare-and-set, or a delete", async () => {
    const kv = counted();
    const store = new WebmailSessionStore(kv, ring());
    const id = await store.create(session());
    await withSessionReads(async () => {
      const first = await store.read(id);
      if (!first) throw new Error("no session");
      expect(await store.write(id, { ...first, accessToken: "at2" })).toBe(true);
      expect((await store.read(id))?.accessToken).toBe("at2");
      // A stale copy written again loses the compare-and-set; the next read is the stored record.
      expect(await store.write(id, { ...first, accessToken: "stale" })).toBe(false);
      expect((await store.read(id))?.accessToken).toBe("at2");
      await store.destroy(id);
      expect(await store.read(id)).toBeNull();
    });
    expect(kv.gets()).toBe(4);
  });

  it("sees a write another request made meanwhile", async () => {
    const kv = counted();
    const store = new WebmailSessionStore(kv, ring());
    const id = await store.create(session());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = withSessionReads(async () => {
      const before = await store.read(id);
      await gate;
      return [before?.accessToken, (await store.read(id))?.accessToken];
    });
    await withSessionReads(async () => {
      const cur = await store.read(id);
      if (cur) await store.write(id, { ...cur, accessToken: "fresh" });
    });
    release();
    expect(await slow).toEqual(["at", "fresh"]);
  });

  it("stops sharing once the request has answered (work it scheduled reads afresh)", async () => {
    const kv = counted();
    const store = new WebmailSessionStore(kv, ring());
    const id = await store.create(session());
    let later: (() => Promise<unknown>) | null = null;
    await withSessionReads(async () => {
      await store.read(id);
      later = () => store.read(id);
    });
    await (later as unknown as () => Promise<unknown>)();
    expect(kv.gets()).toBe(2);
  });

  it("counts shared reads as kvhit in the request's timings", async () => {
    const store = new WebmailSessionStore(counted(), ring());
    const id = await store.create(session());
    const t = await withTimings((timings) =>
      withSessionReads(async () => {
        await store.read(id);
        await store.read(id);
        await store.read(id);
        return timings;
      }),
    );
    expect(t.get("kv")?.count).toBe(1);
    expect(t.get("kvhit")?.count).toBe(2);
  });

  it("never shares a copy past the session's lifetime", async () => {
    let now = 1_000_000;
    const kv = memoryKv(() => now);
    const store = new WebmailSessionStore(kv, ring(), { now: () => now, maxAgeMs: 10_000 });
    const id = await store.create(session({ createdAt: now }));
    await withSessionReads(async () => {
      expect(await store.read(id)).not.toBeNull();
      now += 10_000;
      expect(await store.read(id)).toBeNull();
    });
  });
});

describe("deleting a session record", () => {
  it("leaves no read copy taken while the delete was on its way", async () => {
    const kv = memoryKv();
    let releaseDel: () => void = () => undefined;
    const slow: SessionKv = {
      ...kv,
      del: async (k) => {
        if (k.startsWith("am:wm:s:")) {
          await new Promise<void>((r) => {
            releaseDel = r;
          });
        }
        await kv.del(k);
      },
    };
    const store = new WebmailSessionStore(slow, ring());
    const id = await store.create(session());
    await withSessionReads(async () => {
      expect(await store.read(id)).not.toBeNull();
      const gone = store.destroy(id);
      // Read while the delete is still in flight: the record is still there, and this read may be copied...
      expect(await store.read(id)).not.toBeNull();
      releaseDel();
      await gone;
      // ...but never reused once the delete has landed.
      expect(await store.read(id)).toBeNull();
    });
  });
});

describe("the view key (the browser copy's key)", () => {
  it("is made once per session, sealed at rest, and goes with the session", async () => {
    const kv = memoryKv();
    const store = new WebmailSessionStore(kv, ring());
    const id = await store.create(session());
    const key = await store.viewKey(id);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await store.viewKey(id)).toBe(key);
    const stored = [...kv.raw()].find(([k]) => k.startsWith("am:wm:vk:"));
    expect(stored?.[1]).toBeDefined();
    expect(stored?.[1]).not.toContain(key);
    // Another session has another key.
    const other = await store.create(session());
    expect(await store.viewKey(other)).not.toBe(key);
    await store.destroy(id);
    expect(await store.viewKey(id)).toBeNull();
    expect([...kv.raw().keys()].filter((k) => k.startsWith("am:wm:vk:"))).toHaveLength(1);
    expect(await store.viewKey("not-a-session")).toBeNull();
  });
});
