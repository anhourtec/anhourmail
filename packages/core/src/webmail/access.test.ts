// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { MailboxStatus } from "../mailboxes/entity";
import { MailboxAccessGate, webmailAllowed } from "./access";

describe("webmail access gate", () => {
  it("allows working mailboxes and refuses suspended, deleting and unknown ones", () => {
    for (const s of ["active", "provisioning", "failed"] as const) expect(webmailAllowed(s)).toBe(true);
    for (const s of ["suspended", "deleting", null] as const) expect(webmailAllowed(s)).toBe(false);
  });

  it("caches answers for at most 30 seconds, per normalised address", async () => {
    let now = 0;
    let status: MailboxStatus | null = "active";
    const seen: string[] = [];
    const gate = new MailboxAccessGate(
      async (a) => {
        seen.push(a);
        return status;
      },
      { ttlMs: 60_000, now: () => now },
    );
    expect(await gate.allowed(" Owner@X.test ")).toBe(true);
    status = "suspended";
    now = 29_999;
    expect(await gate.allowed("owner@x.test")).toBe(true); // still cached
    now = 30_000; // the TTL is capped at 30 s even though 60 s was asked for
    expect(await gate.allowed("owner@x.test")).toBe(false);
    expect(seen).toEqual(["owner@x.test", "owner@x.test"]);
    status = "active";
    gate.forget("OWNER@x.test");
    expect(await gate.allowed("owner@x.test")).toBe(true);
    status = null;
    gate.forget("owner@x.test");
    expect(await gate.allowed("owner@x.test")).toBe(false);
  });

  it("uses a 30 second default and the system clock", async () => {
    const gate = new MailboxAccessGate(async () => "deleting");
    expect(await gate.allowed("a@b.test")).toBe(false);
  });
});
