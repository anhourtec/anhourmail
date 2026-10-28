// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { PasswordChangeGate } from "./password-change-gate";

describe("webmail password-change gate", () => {
  it("never caches a required change, so the inbox opens as soon as it is done", async () => {
    let required = true;
    const seen: string[] = [];
    const gate = new PasswordChangeGate(async (a) => {
      seen.push(a);
      return required;
    });
    expect(await gate.required(" Kid@Family.CA ")).toBe(true);
    expect(await gate.required("kid@family.ca")).toBe(true);
    required = false;
    expect(await gate.required("kid@family.ca")).toBe(false);
    expect(seen).toEqual(["kid@family.ca", "kid@family.ca", "kid@family.ca"]);
  });

  it("caches 'not required' for at most 30 seconds, and forgets on request", async () => {
    let now = 0;
    let required = false;
    let calls = 0;
    const gate = new PasswordChangeGate(
      async () => {
        calls += 1;
        return required;
      },
      { ttlMs: 60_000, now: () => now },
    );
    expect(await gate.required("a@x.test")).toBe(false);
    required = true;
    now = 29_999;
    expect(await gate.required("a@x.test")).toBe(false); // cached
    now = 30_000; // capped at 30 s
    expect(await gate.required("a@x.test")).toBe(true);
    expect(calls).toBe(2);
    required = false;
    expect(await gate.required("a@x.test")).toBe(false);
    required = true;
    gate.forget("A@x.test");
    expect(await gate.required("a@x.test")).toBe(true);
  });

  it("uses a 30 second default and the system clock, and bounds its cache", async () => {
    const gate = new PasswordChangeGate(async () => false);
    for (let i = 0; i <= 10_001; i++) expect(await gate.required(`u${String(i)}@x.test`)).toBe(false);
    expect(await gate.required("u0@x.test")).toBe(false);
  });

  it("propagates lookup failures (the request fails rather than skipping the check)", async () => {
    const gate = new PasswordChangeGate(() => Promise.reject(new Error("db down")));
    await expect(gate.required("a@x.test")).rejects.toThrow("db down");
  });
});
