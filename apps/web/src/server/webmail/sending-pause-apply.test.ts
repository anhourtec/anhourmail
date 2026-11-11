// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { type ManagedScriptStore, outboundCommands } from "@anhourmail/core/webmail";
import { memoryAccountSignals } from "@anhourmail/server/account-signals";

import {
  applyPauseToMailboxes,
  catchUpSendingPauses,
  type PauseApplyResult,
  type PauseMailbox,
  takeSendingPauseSignals,
} from "./sending-pause-apply";
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
  it("restricted pauses replies and redirects; new pauses replies and outside redirects; standard lifts them", async () => {
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
    expect(first).toMatchObject({ checked: 3, updated: 3, current: 0, failed: 0 });
    const paused = (id: string) => {
      const v = t.scripts[id];
      return v && v !== "fail" ? outboundCommands(v.content).map((c) => [c.kind, c.paused]) : [];
    };
    expect(paused("r")).toEqual([
      ["vacation", true],
      ["redirect", true],
    ]);
    // New: automatic replies paused (finding F4), the outside redirect too, the internal one runs.
    expect(paused("n")).toEqual([
      ["vacation", true],
      ["redirect", true],
    ]);
    expect(paused("i")).toEqual([
      ["vacation", true],
      ["redirect", false],
    ]);
    // Written on the state each read.
    expect(t.writes.map((w) => [w.id, w.state])).toEqual([
      ["r", "1"],
      ["n", "1"],
      ["i", "1"],
    ]);
    // Lifted (promotion, or staff lifting a restriction): exactly what was there before.
    const lifted = await applyPauseToMailboxes(
      [box("r", "standard"), box("n", "standard"), box("i", "standard")],
      t.s,
      outsideOnly,
    );
    expect(lifted.updated).toBe(3);
    const content = (id: string) => {
      const v = t.scripts[id];
      return v && v !== "fail" ? v.content : "";
    };
    expect(content("r")).toBe(internal);
    expect(content("n")).toBe(outside);
    expect(content("i")).toBe(internal);
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

describe("the catch-up pass (tier changes and restrictions made anywhere)", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const ok = (): PauseApplyResult => ({
    checked: 1,
    updated: 1,
    current: 0,
    skippedInactive: 0,
    skippedChanged: 0,
    failed: 0,
  });

  it("applies every account changed since the last pass, then moves on from this pass's start", async () => {
    const asked: Date[] = [];
    const applied: string[] = [];
    const t0 = new Date("2026-11-11T12:00:00Z");
    const now = new Date("2026-11-11T12:05:00Z");
    const out = await catchUpSendingPauses(
      { since: t0, retry: new Set() },
      {
        changed: async (since) => {
          asked.push(since);
          return [a, b, a, "not-an-id"];
        },
        apply: async (id) => {
          applied.push(id);
          return ok();
        },
        now: () => now,
      },
    );
    expect(asked).toEqual([t0]);
    expect(applied.sort()).toEqual([a, b]);
    expect(out.accounts).toBe(2);
    expect(out.unfinished).toBe(0);
    // From just before this pass began (worker and web clocks differ a little).
    expect(out.state.since.getTime()).toBe(now.getTime() - 2 * 60_000);
    expect(out.state.retry.size).toBe(0);
  });

  it("tries an account again next time when a mailbox failed, changed meanwhile, or the pass threw", async () => {
    const results: Record<string, PauseApplyResult | Error> = {
      [a]: { ...ok(), failed: 1 },
      [b]: { ...ok(), skippedChanged: 1 },
    };
    const deps = {
      changed: async () => [a, b],
      apply: async (id: string) => {
        const r = results[id];
        if (r instanceof Error) throw r;
        return r ?? ok();
      },
      now: () => new Date("2026-11-11T12:05:00Z"),
    };
    const first = await catchUpSendingPauses({ since: new Date(0), retry: new Set() }, deps);
    expect([...first.state.retry].sort()).toEqual([a, b]);
    // Next pass: nothing new changed, the retries go again; one throws now and stays.
    results[a] = new Error("mail server down");
    results[b] = ok();
    const second = await catchUpSendingPauses(first.state, { ...deps, changed: async () => [] });
    expect(second.accounts).toBe(2);
    expect([...second.state.retry]).toEqual([a]);
  });

  it("keeps looking from the same moment when the batch was full", async () => {
    const t0 = new Date("2026-11-11T12:00:00Z");
    const many = Array.from({ length: 1_000 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const out = await catchUpSendingPauses(
      { since: t0, retry: new Set() },
      { changed: async () => many, apply: async () => ok(), now: () => new Date("2026-11-11T12:05:00Z") },
    );
    expect(out.state.since).toEqual(t0);
  });
});
