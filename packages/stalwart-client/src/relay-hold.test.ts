// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { StalwartError } from "./client";
import type { StalwartManagement } from "./management";
import {
  DEFAULT_RELAYING,
  desiredRelaying,
  isDesiredRelaying,
  isRelayHoldInPlace,
  RELAY_HOLD_CONDITION,
  RELAY_HOLD_NAMESPACE,
  RelayHoldList,
  relayHoldKey,
} from "./relay-hold";

type Key = { id: string; namespace: string; key: string; isGlobPattern: boolean };

/**
 * A fake management client with Stalwart's lookup-key behaviour (verified on v0.16.27): a duplicate create is refused
 * with `primaryKeyViolation` and the existing key's id, and what the server enforces changes only on a reload.
 */
function fake(
  opts: {
    allowRelaying?: unknown;
    failReload?: () => boolean;
    reloadMs?: number;
    /** Another process's reload, landing right after a key is written. */
    reloadElsewhereAfterCreate?: boolean;
  } = {},
) {
  const state = {
    keys: [] as Key[],
    loaded: new Set<string>(),
    reloads: 0,
    writes: [] as string[],
    next: 1,
  };
  const mgmt = {
    transport: {
      set: async (object: string, args: { create?: Record<string, Record<string, unknown>>; destroy?: string[] }) => {
        if (object === "x:Action") {
          const type = Object.values(args.create ?? {})[0]?.["@type"];
          if (type !== "ReloadLookupStores") throw new Error(`unexpected action ${String(type)}`);
          state.reloads += 1;
          await new Promise((r) => setTimeout(r, opts.reloadMs ?? 0));
          if (opts.failReload?.()) {
            throw new StalwartError("x:Action/set notCreated", "set", { a: { type: "invalidProperties" } });
          }
          state.loaded = new Set(state.keys.filter((k) => k.namespace === RELAY_HOLD_NAMESPACE).map((k) => k.key));
          return { created: { a: { id: "x" } } };
        }
        if (object !== "x:MemoryLookupKey") throw new Error(`unexpected ${object}`);
        const created: Record<string, { id: string }> = {};
        for (const [ref, v] of Object.entries(args.create ?? {})) {
          const k = v as Omit<Key, "id">;
          const dup = state.keys.find((x) => x.namespace === k.namespace && x.key === k.key);
          if (dup) {
            throw new StalwartError("x:MemoryLookupKey/set notCreated", "set", {
              [ref]: { type: "primaryKeyViolation", properties: ["namespace"], objectId: { id: dup.id } },
            });
          }
          const id = `k${String(state.next++)}`;
          state.keys.push({ ...k, id });
          state.writes.push(`create ${k.key}`);
          created[ref] = { id };
          if (opts.reloadElsewhereAfterCreate) {
            state.loaded = new Set(state.keys.filter((x) => x.namespace === RELAY_HOLD_NAMESPACE).map((x) => x.key));
          }
        }
        for (const id of args.destroy ?? []) {
          state.writes.push(`destroy ${state.keys.find((k) => k.id === id)?.key ?? id}`);
          state.keys = state.keys.filter((k) => k.id !== id);
        }
        return { created };
      },
      queryAll: async (object: string, filter: { namespace?: string }) => {
        expect(object).toBe("x:MemoryLookupKey");
        return state.keys.filter((k) => k.namespace === filter.namespace).map((k) => k.id);
      },
      getAll: async (object: string, _props: string[], ids: string[] | null) => {
        if (object === "x:MtaStageRcpt") return [{ id: "singleton", allowRelaying: opts.allowRelaying }];
        return state.keys.filter((k) => ids?.includes(k.id) ?? true);
      },
    },
  } as unknown as StalwartManagement;
  return { mgmt, state };
}

describe("the relay hold expression", () => {
  it("refuses relaying for listed accounts first, then the default", () => {
    expect(RELAY_HOLD_CONDITION).toBe(`key_exists('${RELAY_HOLD_NAMESPACE}', authenticated_as)`);
    expect(desiredRelaying()).toEqual({
      match: { "0": { if: RELAY_HOLD_CONDITION, then: "false" } },
      else: "!is_empty(authenticated_as)",
    });
    expect(isRelayHoldInPlace(desiredRelaying())).toBe(true);
    expect(isDesiredRelaying(desiredRelaying())).toBe(true);
  });

  it("isn't in place when missing, not first, or not refusing", () => {
    expect(isRelayHoldInPlace(null)).toBe(false);
    expect(isRelayHoldInPlace({ match: {}, else: DEFAULT_RELAYING })).toBe(false);
    expect(
      isRelayHoldInPlace({
        match: { "0": { if: "true", then: "true" }, "1": { if: RELAY_HOLD_CONDITION, then: "false" } },
        else: DEFAULT_RELAYING,
      }),
    ).toBe(false);
    expect(isRelayHoldInPlace({ match: { "0": { if: RELAY_HOLD_CONDITION, then: "true" } }, else: "false" })).toBe(
      false,
    );
    // In place, but with more than ours: drift for the reconciler, still holding.
    const more = { match: { ...desiredRelaying().match, "1": { if: "true", then: "true" } }, else: DEFAULT_RELAYING };
    expect(isRelayHoldInPlace(more)).toBe(true);
    expect(isDesiredRelaying(more)).toBe(false);
    expect(isDesiredRelaying({ ...desiredRelaying(), else: "true" })).toBe(false);
  });

  it("keys are plain lower-case addresses only (nothing that could be a pattern or close a quote)", () => {
    expect(relayHoldKey(" New.Person@Example.TEST ")).toBe("new.person@example.test");
    for (const bad of [
      "*",
      "*@example.test",
      "a@b",
      "a'@example.test",
      "a@example.test'",
      "",
      `${"a".repeat(65)}@x.test`,
    ]) {
      expect(() => relayHoldKey(bad)).toThrow(/plain addresses/);
    }
  });
});

describe("RelayHoldList", () => {
  it("adds once (idempotent) and says when a reload is needed", async () => {
    const { mgmt, state } = fake();
    const list = new RelayHoldList(mgmt);
    expect(await list.add("Held@Example.test")).toBe(true);
    expect(await list.add("held@example.test")).toBe(false);
    expect(state.keys).toEqual([
      { id: "k1", namespace: RELAY_HOLD_NAMESPACE, key: "held@example.test", isGlobPattern: false },
    ]);
    // Not enforced until the reload.
    expect(state.loaded.has("held@example.test")).toBe(false);
    await list.reload();
    expect(state.loaded.has("held@example.test")).toBe(true);
    expect(await list.list()).toEqual(["held@example.test"]);
  });

  it("removes what is there; removing an address that isn't listed leaves nothing behind", async () => {
    const { mgmt, state } = fake();
    const list = new RelayHoldList(mgmt);
    await list.add("held@example.test");
    expect(await list.remove("held@example.test")).toBe(true);
    expect(await list.remove("other@example.test")).toBe(false);
    expect(state.keys).toEqual([]);
    expect(state.writes).toEqual([
      "create held@example.test",
      "destroy held@example.test",
      // The probe: written, destroyed again, then reloaded so nothing it might have been loaded as stays.
      "create other@example.test",
      "destroy other@example.test",
    ]);
    // Only the probe reloads here; taking a listed key off leaves the reload to the caller (before it relaxes anything).
    expect(state.reloads).toBe(1);
  });

  it("never leaves its probe loaded, even when another process reloads in between", async () => {
    const { mgmt, state } = fake({ reloadElsewhereAfterCreate: true });
    const list = new RelayHoldList(mgmt);
    expect(await list.remove("standard@example.test")).toBe(false);
    expect(state.keys).toEqual([]);
    expect(state.loaded.has("standard@example.test")).toBe(false);
  });

  it("throws when the reload after its probe fails (the caller retries; nothing stays loaded by it then)", async () => {
    const { mgmt, state } = fake({ reloadElsewhereAfterCreate: true, failReload: () => true });
    await expect(new RelayHoldList(mgmt).remove("standard@example.test")).rejects.toThrow(/notCreated/);
    expect(state.keys).toEqual([]);
  });

  it("passes on any other refusal", async () => {
    const { mgmt } = fake();
    const refusing = {
      transport: {
        set: () =>
          Promise.reject(new StalwartError("x:MemoryLookupKey/set notCreated", "set", { k: { type: "forbidden" } })),
      },
    } as unknown as StalwartManagement;
    await expect(new RelayHoldList(refusing).add("held@example.test")).rejects.toThrow(/notCreated/);
    await expect(new RelayHoldList(mgmt).add("not an address")).rejects.toThrow(/plain addresses/);
  });

  it("reads whether allowRelaying holds listed accounts", async () => {
    expect(await new RelayHoldList(fake({ allowRelaying: desiredRelaying() }).mgmt).inPlace()).toBe(true);
    expect(await new RelayHoldList(fake({ allowRelaying: { match: {}, else: DEFAULT_RELAYING } }).mgmt).inPlace()).toBe(
      false,
    );
    expect(await new RelayHoldList(fake().mgmt).inPlace()).toBe(false);
  });

  it("coalesces reloads: callers during a reload share one more, which starts after it", async () => {
    const { mgmt, state } = fake({ reloadMs: 20 });
    const list = new RelayHoldList(mgmt);
    const first = list.reload();
    await list.add("late@example.test");
    // Written during the first reload: it must be covered by a reload that starts after the write.
    const [a, b, c] = [list.reload(), list.reload(), list.reload()];
    expect(b).toBe(a);
    expect(c).toBe(a);
    await Promise.all([first, a]);
    expect(state.reloads).toBe(2);
    expect(state.loaded.has("late@example.test")).toBe(true);
    // Idle again: the next call reloads at once.
    await list.reload();
    expect(state.reloads).toBe(3);
  });

  it("a failed reload rejects its callers and the next call tries again", async () => {
    let fail = true;
    const { mgmt, state } = fake({ failReload: () => fail, reloadMs: 5 });
    const list = new RelayHoldList(mgmt);
    await list.add("held@example.test");
    const running = list.reload();
    const queued = list.reload();
    await expect(running).rejects.toThrow(/notCreated/);
    fail = false;
    // The queued one still runs after the failed one, and succeeds.
    await expect(queued).resolves.toBeUndefined();
    expect(state.loaded.has("held@example.test")).toBe(true);
    expect(state.reloads).toBe(2);
  });
});
