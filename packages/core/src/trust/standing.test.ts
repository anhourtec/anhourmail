// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { TRUST_TIER_ORDER } from "@anhourmail/shared/sending";

import { ACCOUNT_A, ACCOUNT_B, deps as makeDeps, fixedClock, TEST_PLATFORM } from "../__tests__/helpers";
import { defaultBilling } from "../billing/lifecycle";
import { GB } from "../mailboxes/entity";

import { effectiveTier } from "./entity";
import { hostedDomains, sendingStanding } from "./standing";

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
    expect(await sendingStanding(w.d, "me@acme.test")).toEqual({ tier: "new", billingBlock: null });
  });

  it("follows the account's tier at once (uncached) and trims and lowercases the address", async () => {
    const w = world();
    w.setTier(ACCOUNT_A, "standard");
    expect(await sendingStanding(w.d, "  ME@Acme.TEST ")).toEqual({ tier: "standard", billingBlock: null });
    w.setTier(ACCOUNT_A, "restricted");
    expect(await sendingStanding(w.d, "me@acme.test")).toEqual({ tier: "restricted", billingBlock: null });
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
    expect(await sendingStanding(w.d, "me@acme.test")).toEqual({ tier: "new", billingBlock: "restricted" });
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
