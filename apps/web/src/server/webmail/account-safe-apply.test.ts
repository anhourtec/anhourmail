// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { ManagedScriptStore } from "@anhourmail/core/webmail";

import { applyToMailboxes } from "./account-safe-apply";
import { buildScript, DEFAULT_RULES, MAX_SCRIPT_BYTES, type MailRules } from "./sieve";

const ctx = { identities: [], contacts: ["friend@example.org"], authservIds: [], mailboxDomain: "a.test" };
const trusted: MailRules = { ...DEFAULT_RULES, junk: { blocked: [], safe: [], trustedOnly: true } };

type Script = { content: string; active: boolean; state?: string } | null;

function store(scripts: Record<string, Script | "fail">, opts: { stale?: string[]; throwOnWrite?: string[] } = {}) {
  const writes: { id: string; content: string; state: string; address: string }[] = [];
  const s: ManagedScriptStore = {
    read: async (id) => {
      const v = scripts[id];
      if (v === "fail") throw new TypeError("fetch failed");
      return v ?? null;
    },
    write: async (id, content, state, address) => {
      if (opts.throwOnWrite?.includes(id)) throw new Error("refused");
      if (opts.stale?.includes(id)) return false;
      writes.push({ id, content, state, address });
      return true;
    },
  };
  return { s, writes };
}

describe("applying the account's Safe senders to mailboxes (ADR-0032 §1)", () => {
  it("rewrites only scripts that carry the line, on the state it read, and counts the rest", async () => {
    const current = buildScript(trusted, { ...ctx, accountSafe: ["new.example"] });
    const { s, writes } = store(
      {
        a: { content: buildScript(trusted, ctx), active: true, state: "s1" },
        b: { content: current, active: true, state: "s2" },
        c: { content: buildScript(DEFAULT_RULES, ctx), active: true, state: "s3" },
        d: null,
        e: { content: buildScript(trusted, ctx), active: false, state: "s5" },
        f: { content: buildScript(trusted, ctx), active: true, state: "s6" },
        g: "fail",
        h: { content: buildScript(trusted, ctx), active: true },
        i: { content: buildScript(trusted, ctx), active: true, state: "s9" },
      },
      { stale: ["f"], throwOnWrite: ["i"] },
    );
    const mailboxes = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => ({
      stalwartId: id,
      address: `${id}@a.test`,
    }));
    const out = await applyToMailboxes(mailboxes, ["new.example"], s);
    expect(out).toEqual({
      checked: 8,
      updated: 1,
      current: 3,
      skippedInactive: 1,
      skippedChanged: 1,
      skippedTooLarge: 0,
      failed: 3,
    });
    expect(writes).toEqual([{ id: "a", content: current, state: "s1", address: "a@a.test" }]);
  });

  it("never writes a script that would exceed the size budget", async () => {
    const { s, writes } = store({ a: { content: buildScript(trusted, ctx), active: true, state: "s1" } });
    // Far beyond what the console allows: the guard here is independent of it.
    const huge = Array.from({ length: 800 }, (_, i) => `${"x".repeat(60)}.${"y".repeat(60)}.d${String(i)}.example`);
    expect(new TextEncoder().encode(huge.join(",")).length).toBeGreaterThan(MAX_SCRIPT_BYTES);
    const out = await applyToMailboxes([{ stalwartId: "a", address: "a@a.test" }], huge, s);
    expect(out.skippedTooLarge).toBe(1);
    expect(writes).toEqual([]);
  });
});
