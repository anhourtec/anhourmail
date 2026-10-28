// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { MailboxStatus } from "../mailboxes/entity";
import { MailboxAccessGate, type MailboxAccessRecord, webmailAccess, webmailAllowed } from "./access";

const rec = (status: MailboxStatus, personSuspended = false): MailboxAccessRecord => ({ status, personSuspended });

describe("webmail access gate", () => {
  it("allows working mailboxes and refuses suspended, deleting and unknown ones", () => {
    for (const s of ["active", "provisioning", "failed"] as const) expect(webmailAllowed(rec(s))).toBe(true);
    for (const r of [rec("suspended"), rec("deleting"), null]) expect(webmailAllowed(r)).toBe(false);
  });

  it("says why: the person's suspension first, then the mailbox's state", () => {
    expect(webmailAccess(rec("active"))).toBe("ok");
    expect(webmailAccess(rec("active", true))).toBe("person_suspended");
    expect(webmailAccess(rec("suspended", true))).toBe("person_suspended");
    expect(webmailAccess(rec("suspended"))).toBe("suspended");
    expect(webmailAccess(rec("deleting"))).toBe("deleting");
    expect(webmailAccess(null)).toBe("gone");
  });

  it("refuses a working mailbox whose person is suspended", () => {
    expect(webmailAllowed(rec("active", true))).toBe(false);
  });

  it("caches answers for at most 30 seconds, per normalised address", async () => {
    let now = 0;
    let record: MailboxAccessRecord | null = rec("active");
    const seen: string[] = [];
    const gate = new MailboxAccessGate(
      async (a) => {
        seen.push(a);
        return record;
      },
      { ttlMs: 60_000, now: () => now },
    );
    expect(await gate.allowed(" Owner@X.test ")).toBe(true);
    record = rec("suspended");
    now = 29_999;
    expect(await gate.allowed("owner@x.test")).toBe(true); // still cached
    now = 30_000; // the TTL is capped at 30 s even though 60 s was asked for
    expect(await gate.allowed("owner@x.test")).toBe(false);
    expect(await gate.state("owner@x.test")).toBe("suspended");
    expect(seen).toEqual(["owner@x.test", "owner@x.test"]);
    record = rec("active");
    gate.forget("OWNER@x.test");
    expect(await gate.allowed("owner@x.test")).toBe(true);
    record = rec("active", true);
    gate.forget("owner@x.test");
    expect(await gate.state("owner@x.test")).toBe("person_suspended");
    record = null;
    gate.forget("owner@x.test");
    expect(await gate.allowed("owner@x.test")).toBe(false);
    expect(await gate.state("owner@x.test")).toBe("gone");
  });

  it("uses a 30 second default and the system clock", async () => {
    const gate = new MailboxAccessGate(async () => rec("deleting"));
    expect(await gate.allowed("a@b.test")).toBe(false);
    expect(await gate.state("a@b.test")).toBe("deleting");
  });
});
