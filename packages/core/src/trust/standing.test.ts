// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { TRUST_TIER_ORDER } from "@anhourmail/shared/sending";

import { ACCOUNT_A, ACCOUNT_B, deps as makeDeps, fixedClock, TEST_PLATFORM } from "../__tests__/helpers";
import { defaultBilling } from "../billing/lifecycle";
import { GB } from "../mailboxes/entity";

import { effectiveTier } from "./entity";
import { hostedDomains, mailboxTier, sendingStanding } from "./standing";

const BOX_A = "a0000000-0000-4000-8000-000000000001";
const BOX_B = "b0000000-0000-4000-8000-000000000002";

function world() {
  const clock = fixedClock("2026-11-11T10:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "free", createdAt: clock.now() });
  s.accounts.push({ id: ACCOUNT_B, name: "Other", plan: "plus", createdAt: clock.now() });
  const box = (id: string, accountId: string, address: string) => ({
    id,
    accountId,
    userId: null,
    address,
    status: "active" as const,
    quotaBytes: GB,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: clock.now(),
  });
  s.mailboxes.push(box(BOX_A, ACCOUNT_A, "me@acme.test"), box(BOX_B, ACCOUNT_B, "you@other.test"));
  const setTier = (accountId: string, tier: (typeof TRUST_TIER_ORDER)[number]) => {
    s.trust = [
      ...s.trust.filter((t) => t.accountId !== accountId),
      {
        accountId,
        tier,
        since: clock.now(),
        source: "staff",
        reason: null,
        note: null,
        setBy: null,
        lastRestrictedAt: null,
      },
    ];
  };
  const restrictMailbox = (mailboxId: string) =>
    s.mailboxRestrictions.push({ mailboxId, at: clock.now(), reason: "spam", note: null, byUserId: null });
  return { d, s, clock, setTier, restrictMailbox };
}

describe("effectiveTier", () => {
  it("is the account's tier, or restricted while the mailbox is restricted", () => {
    for (const t of TRUST_TIER_ORDER) {
      expect(effectiveTier(t, false)).toBe(t);
      expect(effectiveTier(t, true)).toBe("restricted");
    }
  });
});

describe("sendingStanding", () => {
  it("a new account's mailbox reads new with no billing block", async () => {
    const w = world();
    expect(await sendingStanding(w.d, "me@acme.test")).toEqual({
      tier: "new",
      billingBlock: null,
      heldOnServer: false,
    });
  });

  it("follows the account's tier at once (uncached) and trims and lowercases the address", async () => {
    const w = world();
    w.setTier(ACCOUNT_A, "standard");
    expect(await sendingStanding(w.d, "  ME@Acme.TEST ")).toEqual({
      tier: "standard",
      billingBlock: null,
      heldOnServer: false,
    });
    w.setTier(ACCOUNT_A, "restricted");
    expect(await sendingStanding(w.d, "me@acme.test")).toEqual({
      tier: "restricted",
      billingBlock: null,
      heldOnServer: false,
    });
  });

  it("a loosened tier is still held on the server until the ensure queued for the change has succeeded", async () => {
    const w = world();
    const job = (status: "queued" | "running" | "succeeded" | "failed", at: Date) => ({
      id: `j-${String(w.s.jobs.length)}`,
      kind: "mailbox.ensure" as const,
      subjectId: BOX_A,
      status,
      attempts: 0,
      lastError: null,
      runAfter: at,
      lockToken: null,
      createdAt: at,
    });
    const before = new Date(w.clock.now().getTime() - 60_000);
    const after = new Date(w.clock.now().getTime() + 1_000);
    // Promoted now; its mailbox was last applied a minute ago (held then).
    w.s.jobs.push(job("succeeded", before));
    w.setTier(ACCOUNT_A, "standard");
    const held = async () => (await sendingStanding(w.d, "me@acme.test"))?.heldOnServer;
    w.s.jobs.push(job("queued", after));
    expect(await held()).toBe(true);
    w.s.jobs.at(-1)!.status = "running";
    expect(await held()).toBe(true);
    w.s.jobs.at(-1)!.status = "failed";
    expect(await held()).toBe(true);
    // Applied: and an unrelated ensure queued later (an alias, a backfill) doesn't hold it again.
    w.s.jobs.at(-1)!.status = "succeeded";
    expect(await held()).toBe(false);
    w.s.jobs.push(job("queued", new Date(after.getTime() + 1_000)));
    expect(await held()).toBe(false);
  });

  it("an older queued ensure reused by the change holds until it succeeds; no ensure at all holds nothing", async () => {
    const w = world();
    const at = new Date(w.clock.now().getTime() - 5_000);
    w.s.jobs.push({
      id: "j-old",
      kind: "mailbox.ensure",
      subjectId: BOX_A,
      status: "queued",
      attempts: 0,
      lastError: null,
      runAfter: at,
      lockToken: null,
      createdAt: at,
    });
    w.setTier(ACCOUNT_A, "standard");
    expect((await sendingStanding(w.d, "me@acme.test"))?.heldOnServer).toBe(true);
    w.s.jobs[0]!.status = "succeeded";
    expect((await sendingStanding(w.d, "me@acme.test"))?.heldOnServer).toBe(false);
    // A tier held anyway (new, restricted) never reads held on the server: the tier itself holds it.
    w.s.jobs[0]!.status = "queued";
    w.setTier(ACCOUNT_A, "new");
    expect((await sendingStanding(w.d, "me@acme.test"))?.heldOnServer).toBe(false);
    // The other account's mailbox has no job at all.
    w.setTier(ACCOUNT_B, "standard");
    expect((await sendingStanding(w.d, "you@other.test"))?.heldOnServer).toBe(false);
  });

  it("a restricted mailbox in a standard account reads restricted; the other account's mailbox is unaffected", async () => {
    const w = world();
    w.setTier(ACCOUNT_A, "standard");
    w.setTier(ACCOUNT_B, "standard");
    w.restrictMailbox(BOX_A);
    expect((await sendingStanding(w.d, "me@acme.test"))?.tier).toBe("restricted");
    expect((await sendingStanding(w.d, "you@other.test"))?.tier).toBe("standard");
  });

  it("carries billing's block next to the tier", async () => {
    const w = world();
    w.s.billing = [{ ...defaultBilling(ACCOUNT_A, "free", w.clock.now()), state: "restricted" }];
    expect(await sendingStanding(w.d, "me@acme.test")).toEqual({
      tier: "new",
      billingBlock: "restricted",
      heldOnServer: false,
    });
    w.s.planHolds.push({
      id: "h1",
      accountId: ACCOUNT_A,
      subjectType: "mailbox",
      subjectId: BOX_A,
      heldAt: w.clock.now(),
      receiveUntil: null,
    });
    expect((await sendingStanding(w.d, "me@acme.test"))?.billingBlock).toBe("held");
  });

  it("an address we don't hold, an empty one or an overlong one reads null", async () => {
    const w = world();
    expect(await sendingStanding(w.d, "someone@else.test")).toBeNull();
    expect(await sendingStanding(w.d, "   ")).toBeNull();
    expect(await sendingStanding(w.d, `${"x".repeat(250)}@acme.test`)).toBeNull();
  });
});

describe("mailboxTier", () => {
  it("is the account's tier, restricted while the mailbox is, and restricted for anything not the account's", async () => {
    const w = world();
    const tier = (accountId: string, mailboxId: string) => w.d.uow.run((r) => mailboxTier(r, accountId, mailboxId));
    expect(await tier(ACCOUNT_A, BOX_A)).toBe("new");
    w.setTier(ACCOUNT_A, "standard");
    expect(await tier(ACCOUNT_A, BOX_A)).toBe("standard");
    w.restrictMailbox(BOX_A);
    expect(await tier(ACCOUNT_A, BOX_A)).toBe("restricted");
    // Another account's mailbox, or an unknown account, never reads laxer than restricted.
    w.setTier(ACCOUNT_B, "trusted");
    expect(await tier(ACCOUNT_A, BOX_B)).toBe("restricted");
    expect(await tier("99999999-9999-4999-8999-999999999999", BOX_A)).toBe("restricted");
    expect(await tier(ACCOUNT_B, BOX_B)).toBe("trusted");
  });
});

describe("hostedDomains", () => {
  it("platform domains from configuration and verified customer domains, lowercased; the rest is outside", async () => {
    const w = world();
    const at = w.clock.now();
    const domain = (id: string, accountId: string, name: string, status: "active" | "pending_dns" | "removing") => ({
      id,
      accountId,
      name,
      status,
      verifyToken: "t",
      stalwartId: null,
      lastError: null,
      createdAt: at,
    });
    w.s.domains.push(
      domain("d1", ACCOUNT_A, "acme.test", "active"),
      domain("d2", ACCOUNT_B, "pending.test", "pending_dns"),
      domain("d3", ACCOUNT_B, "leaving.test", "removing"),
    );
    const hosted = await hostedDomains(w.d, [
      TEST_PLATFORM.freeAddressDomain.toUpperCase(),
      " ACME.test ",
      "acme.test",
      "pending.test",
      "leaving.test",
      "gmail.example",
      "",
      `${"a".repeat(250)}.test`,
    ]);
    expect([...hosted].sort()).toEqual([TEST_PLATFORM.freeAddressDomain, "acme.test"].sort());
  });

  it("asks the database nothing when every domain is a platform domain or there are none", async () => {
    const w = world();
    let runs = 0;
    const counting = {
      ...w.d,
      uow: {
        run: <T>(fn: Parameters<typeof w.d.uow.run<T>>[0]) => {
          runs += 1;
          return w.d.uow.run(fn);
        },
      },
    };
    expect([...(await hostedDomains(counting, [TEST_PLATFORM.domain]))]).toEqual([TEST_PLATFORM.domain]);
    expect([...(await hostedDomains(counting, []))]).toEqual([]);
    expect(runs).toBe(0);
    await hostedDomains(counting, ["other.test"]);
    expect(runs).toBe(1);
  });
});
