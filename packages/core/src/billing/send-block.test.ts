// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, deps as makeDeps, fixedClock } from "../__tests__/helpers";
import { GB } from "../mailboxes/entity";

import { defaultBilling } from "./lifecycle";
import { billingSendBlock } from "./send-block";

const BOX = "a0000000-0000-4000-8000-000000000001";

function world() {
  const clock = fixedClock("2026-11-05T10:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "plus" });
  s.mailboxes.push({
    id: BOX,
    accountId: ACCOUNT_A,
    userId: null,
    address: "me@acme.test",
    status: "active",
    quotaBytes: GB,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: clock.now(),
  });
  const setState = (state: "active" | "restricted" | "lapsed") => {
    s.billing = [{ ...defaultBilling(ACCOUNT_A, "plus", clock.now()), state }];
  };
  return { d, s, clock, setState };
}

describe("billingSendBlock", () => {
  it("a restricted account's mailbox and a held mailbox can't send; others can", async () => {
    const w = world();
    expect(await billingSendBlock(w.d, "me@acme.test")).toBeNull();
    w.setState("restricted");
    expect(await billingSendBlock(w.d, " Me@Acme.test ")).toBe("restricted");
    w.setState("lapsed");
    expect(await billingSendBlock(w.d, "me@acme.test")).toBeNull();
    w.s.planHolds.push({
      id: "h1",
      accountId: ACCOUNT_A,
      subjectType: "mailbox",
      subjectId: BOX,
      heldAt: w.clock.now(),
      receiveUntil: null,
    });
    expect(await billingSendBlock(w.d, "me@acme.test")).toBe("held");
  });

  it("an address we don't hold (or no address) has nothing to say", async () => {
    const w = world();
    w.setState("restricted");
    expect(await billingSendBlock(w.d, "someone@else.test")).toBeNull();
    expect(await billingSendBlock(w.d, "")).toBeNull();
    expect(await billingSendBlock(w.d, `${"x".repeat(255)}@a.test`)).toBeNull();
  });
});
