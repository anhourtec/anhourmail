// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { type ManagedScriptStore, outboundCommands } from "@anhourmail/core/webmail";
import { memoryAccountSignals } from "@anhourmail/server/account-signals";

import { applyPauseToMailboxes, type PauseMailbox, takeSendingPauseSignals } from "./sending-pause-apply";
import { buildScript, DEFAULT_RULES, type MailRules } from "./sieve";

const ctx = { identities: ["me@a.test"], contacts: [], authservIds: [], mailboxDomain: "a.test" };
const rules = (address: string): MailRules => ({
  ...DEFAULT_RULES,
  vacation: { ...DEFAULT_RULES.vacation, enabled: true, message: "Away." },
  forwarding: { enabled: true, address, keepCopy: true },
});
const outsideOnly = async (addresses: readonly string[]) => addresses.filter((a) => !a.endsWith("@a.test"));

type Script = { content: string; active: boolean; state?: string } | null;

function store(scripts: Record<string, Script | "fail">, opts: { stale?: string[] } = {}) {
  const writes: { id: string; content: string; state: string }[] = [];
  const s: ManagedScriptStore = {
    read: async (id) => {
      const v = scripts[id];
      if (v === "fail") throw new TypeError("fetch failed");
      return v ?? null;
    },
    write: async (id, content, state) => {
      if (opts.stale?.includes(id)) return false;
      writes.push({ id, content, state });
      const prev = scripts[id];
      if (prev && prev !== "fail") scripts[id] = { ...prev, content, state: `${state}+` };
      return true;
    },
  };
  return { s, writes, scripts };
}

const box = (id: string, tier: PauseMailbox["tier"]): PauseMailbox => ({
  stalwartId: id,
  address: `${id}@a.test`,
  tier,
});

describe("applying the trust tier to managed scripts (ADR-0034)", () => {
  it("restricted pauses replies and redirects; new pauses only outside redirects; standard lifts them back", async () => {
    const outside = buildScript(rules("friend@elsewhere.example"), ctx);
    const internal = buildScript(rules("colleague@a.test"), ctx);
    const t = store({
      r: { content: internal, active: true, state: "1" },
      n: { content: outside, active: true, state: "1" },
      i: { content: internal, active: true, state: "1" },
    });
    const first = await applyPauseToMailboxes(
      [box("r", "restricted"), box("n", "new"), box("i", "new")],
      t.s,
      outsideOnly,
    );
    expect(first).toMatchObject({ checked: 3, updated: 2, current: 1, failed: 0 });
    const paused = (id: string) => {
      const v = t.scripts[id];
      return v && v !== "fail" ? outboundCommands(v.content).map((c) => [c.kind, c.paused]) : [];
    };
    expect(paused("r")).toEqual([
      ["vacation", true],
      ["redirect", true],
    ]);
    expect(paused("n")).toEqual([
      ["vacation", false],
      ["redirect", true],
    ]);
    // Written on the state each read.
    expect(t.writes.map((w) => [w.id, w.state])).toEqual([
      ["r", "1"],
      ["n", "1"],
    ]);
    // Lifted (promotion, or staff lifting a restriction): exactly what was there before.
    const lifted = await applyPauseToMailboxes([box("r", "standard"), box("n", "standard")], t.s, outsideOnly);
    expect(lifted.updated).toBe(2);
    const content = (id: string) => {
      const v = t.scripts[id];
      return v && v !== "fail" ? v.content : "";
    };
    expect(content("r")).toBe(internal);
    expect(content("n")).toBe(outside);
  });

  it("counts no script, a switched-off one, one changed meanwhile, no state and a failure; never writes blind", async () => {
    const script = buildScript(rules("friend@elsewhere.example"), ctx);
    const t = store(
      {
        none: null,
        off: { content: script, active: false, state: "1" },
        stale: { content: script, active: true, state: "1" },
        blind: { content: script, active: true },
        down: "fail",
      },
      { stale: ["stale"] },
    );
    const out = await applyPauseToMailboxes(
      ["none", "off", "stale", "blind", "down"].map((id) => box(id, "restricted")),
      t.s,
      outsideOnly,
    );
    expect(out).toEqual({ checked: 4, updated: 0, current: 1, skippedInactive: 1, skippedChanged: 1, failed: 2 });
    expect(t.writes).toEqual([]);
  });

  it("a failed hosted-domain check counts as failed for that mailbox and changes nothing", async () => {
    const t = store({ n: { content: buildScript(rules("x@elsewhere.example"), ctx), active: true, state: "1" } });
    const out = await applyPauseToMailboxes([box("n", "new")], t.s, () => Promise.reject(new Error("db down")));
    expect(out.failed).toBe(1);
    expect(t.writes).toEqual([]);
  });
});

describe("the worker's signals (a billing sync moved a tier)", () => {
  it("schedules each signalled account once and drops anything that isn't an account id", async () => {
    const signals = memoryAccountSignals();
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    for (const id of [a, b, a, "not-an-id", "am:other"]) await signals.signal(id);
    const scheduled: string[] = [];
    expect(await takeSendingPauseSignals(signals, (id) => scheduled.push(id))).toBe(2);
    expect(scheduled.sort()).toEqual([a, b]);
    expect(signals.pending()).toEqual([]);
    expect(await takeSendingPauseSignals(signals, (id) => scheduled.push(id))).toBe(0);
  });
});
