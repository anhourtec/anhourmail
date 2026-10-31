// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setLogSinkForTests } from "@anhourmail/server/log";

import { createSafeSenders, type RulesVersions, rulesVersionKey, SAFE_SENDERS_TTL_MS } from "./safe-senders";
import { buildScript, DEFAULT_RULES } from "./sieve";

const ME = "me@a.test";
const ctx = { identities: [], contacts: [], authservIds: [], mailboxDomain: "a.test" };
const script = (safe: string[]) =>
  buildScript({ ...DEFAULT_RULES, junk: { blocked: [], safe, trustedOnly: false } }, ctx);

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  setLogSinkForTests((line) => lines.push(line));
});
afterEach(() => {
  setLogSinkForTests(null);
});

function setup(opts: { content?: string | null; active?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis = { down: false, gets: 0 };
  const versions: RulesVersions = {
    get: async (key) => {
      if (redis.down) throw new Error("ECONNREFUSED");
      redis.gets += 1;
      return store.get(key) ?? null;
    },
    init: async (key, value) => {
      if (redis.down) throw new Error("ECONNREFUSED");
      if (!store.has(key)) store.set(key, value);
    },
    bump: async (key) => {
      if (redis.down) throw new Error("ECONNREFUSED");
      const v = String(Number(store.get(key) ?? "0") + 1);
      store.set(key, v);
      return v;
    },
  };
  const mail = {
    content: opts.content === undefined ? script(["jane@example.com", "partner.example"]) : opts.content,
    active: opts.active ?? true,
    reads: 0,
    fail: false,
    slow: false,
    /** Holds a read until released, then answers `served` (or the content at that time). */
    hold: null as Promise<void> | null,
    served: null as string | null,
  };
  let now = 1_000_000;
  const safe = createSafeSenders({
    read: async () => {
      mail.reads += 1;
      if (mail.fail) throw new TypeError("fetch failed");
      if (mail.slow) await new Promise((r) => setTimeout(r, 400));
      const content = mail.content;
      if (mail.hold) {
        await mail.hold;
        const served = mail.served ?? content;
        return served === null ? null : { content: served, active: mail.active };
      }
      return content === null ? null : { content, active: mail.active };
    },
    versions,
    now: () => now,
    timeoutMs: 200,
    max: 3,
  });
  return {
    safe,
    store,
    redis,
    mail,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("a mailbox's Safe senders for the image check", () => {
  it("matches the parsed list, and reads the script once while the version stays", async () => {
    const t = setup();
    expect(await t.safe.match("acc1", ME, "Jane@Example.com")).toEqual({ kind: "address", value: "jane@example.com" });
    expect(await t.safe.match("acc1", ME, "bob@partner.example")).toEqual({ kind: "domain", value: "partner.example" });
    expect(await t.safe.match("acc1", ME, "bob@news.partner.example")).toBeNull();
    expect(t.mail.reads).toBe(1);
    // The counter was created (at a random number) before the first read; nothing but a number is in Redis.
    expect([...t.store.keys()]).toEqual([rulesVersionKey("acc1", ME)]);
    expect(t.store.get(rulesVersionKey("acc1", ME))).toMatch(/^\d+$/);
  });

  it("reads again after another process's write moves the version on", async () => {
    const t = setup();
    await t.safe.lookup("acc1", ME);
    t.mail.content = script(["bob@example.com"]);
    expect(await t.safe.match("acc1", ME, "bob@example.com")).toBeNull(); // still the cached list
    await t.safe.written("acc2", ME); // another mailbox's write changes nothing here
    expect(await t.safe.match("acc1", ME, "bob@example.com")).toBeNull();
    t.store.set(rulesVersionKey("acc1", ME), `${t.store.get(rulesVersionKey("acc1", ME)) ?? ""}1`); // another process's write
    expect(await t.safe.match("acc1", ME, "bob@example.com")).toEqual({ kind: "address", value: "bob@example.com" });
    expect(t.mail.reads).toBe(2);
  });

  it("re-reads when the version is missing (Redis flushed, or the counter expired)", async () => {
    const t = setup();
    await t.safe.lookup("acc1", ME);
    t.store.clear();
    await t.safe.lookup("acc1", ME);
    expect(t.mail.reads).toBe(2);
  });

  it("drops this process's own entry on a write and bumps the version for everyone else", async () => {
    const t = setup();
    await t.safe.lookup("acc1", ME);
    const before = Number(t.store.get(rulesVersionKey("acc1", ME)));
    t.mail.content = script(["new@example.com"]);
    await t.safe.written("acc1", ME);
    expect(Number(t.store.get(rulesVersionKey("acc1", ME)))).toBe(before + 1);
    expect(await t.safe.match("acc1", ME, "new@example.com")).toEqual({ kind: "address", value: "new@example.com" });
    expect(await t.safe.match("acc1", ME, "jane@example.com")).toBeNull();
    expect(t.mail.reads).toBe(2);
  });

  it("never keeps a list read before a concurrent write", async () => {
    const t = setup();
    // A lookup reads its stamp, then the script; a write lands between the two and its bump comes first.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const old = t.mail.content;
    t.mail.hold = gate;
    const pending = t.safe.lookup("acc1", ME);
    await new Promise((r) => setTimeout(r, 0));
    t.mail.content = script(["new@example.com"]);
    await t.safe.written("acc1", ME);
    t.mail.hold = null;
    // The slow read saw the old script; it was stamped with the old counter, so the next lookup reads again.
    t.mail.served = old;
    release();
    await pending;
    t.mail.served = null;
    expect(await t.safe.match("acc1", ME, "new@example.com")).toEqual({ kind: "address", value: "new@example.com" });
  });

  it("keeps mailboxes apart when the mail server reuses an account id for another address", async () => {
    const t = setup();
    expect(await t.safe.match("acc1", ME, "jane@example.com")).not.toBeNull();
    t.mail.content = null; // the new mailbox under the same id has no rules yet
    expect(await t.safe.match("acc1", "someone-else@a.test", "jane@example.com")).toBeNull();
    expect(rulesVersionKey("acc1", ME)).not.toBe(rulesVersionKey("acc1", "someone-else@a.test"));
    expect(rulesVersionKey("acc1", ME)).not.toContain("@");
    expect(rulesVersionKey("acc1", " Me@A.test ")).toBe(rulesVersionKey("acc1", ME));
  });

  it("falls back to a short time-to-live while Redis is down", async () => {
    const t = setup();
    t.redis.down = true;
    await t.safe.lookup("acc1", ME);
    t.advance(SAFE_SENDERS_TTL_MS - 1);
    await t.safe.lookup("acc1", ME);
    expect(t.mail.reads).toBe(1);
    t.advance(2);
    expect(await t.safe.match("acc1", ME, "jane@example.com")).not.toBeNull();
    expect(t.mail.reads).toBe(2);
    // A write while Redis is down still drops this process's own entry: the next lookup reads what was written.
    t.mail.content = script([]);
    await t.safe.written("acc1", ME);
    expect(await t.safe.match("acc1", ME, "jane@example.com")).toBeNull();
  });

  it("reads again after ten minutes even with the version unchanged (a bump lost while Redis was down)", async () => {
    const t = setup();
    await t.safe.lookup("acc1", ME);
    t.advance(10 * 60_000);
    await t.safe.lookup("acc1", ME);
    expect(t.mail.reads).toBe(2);
  });

  it("matches nothing when the script can't be read or is too slow, and logs no entry", async () => {
    const t = setup();
    t.mail.fail = true;
    expect(await t.safe.lookup("acc1", ME)).toBeNull();
    expect(await t.safe.match("acc1", ME, "jane@example.com")).toBeNull();
    t.mail.fail = false;
    t.mail.slow = true;
    expect(await t.safe.match("acc2", ME, "jane@example.com")).toBeNull();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry).toMatchObject({ msg: "safe senders unavailable", component: "webmail" });
      expect(line).not.toContain("jane");
      expect(line).not.toContain("example");
    }
    expect(lines.map((l) => (JSON.parse(l) as { error: string }).error)).toEqual([
      "TypeError",
      "TypeError",
      "TimeoutError",
    ]);
  });

  it("is empty for no script or one that isn't ours, and still applies while the script is switched off", async () => {
    expect(await setup({ content: null }).safe.match("acc1", ME, "jane@example.com")).toBeNull();
    expect(await setup({ content: "keep;\n" }).safe.lookup("acc1", ME)).toEqual({
      addresses: new Set(),
      domains: new Set(),
    });
    expect(await setup({ active: false }).safe.match("acc1", ME, "jane@example.com")).toEqual({
      kind: "address",
      value: "jane@example.com",
    });
  });

  it("keeps at most the newest mailboxes", async () => {
    const t = setup();
    for (const id of ["a", "b", "c", "d"]) await t.safe.lookup(id, ME);
    expect(t.mail.reads).toBe(4);
    await t.safe.lookup("d", ME);
    await t.safe.lookup("b", ME);
    expect(t.mail.reads).toBe(4);
    await t.safe.lookup("a", ME); // dropped first
    expect(t.mail.reads).toBe(5);
  });
});
