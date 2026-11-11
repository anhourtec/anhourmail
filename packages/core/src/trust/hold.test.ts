// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps as makeDeps, fixedClock, TEST_PLATFORM } from "../__tests__/helpers";
import { GB } from "../mailboxes/entity";

import { externalHeld, outsideAddresses, recordSendHeld, SEND_HELD_EVERY_MS, SendingHeldError } from "./hold";

const BOX_A = "a0000000-0000-4000-8000-000000000001";
const BOX_A2 = "a0000000-0000-4000-8000-000000000003";
const BOX_B = "b0000000-0000-4000-8000-000000000002";
const req = { requestId: "req-held", ip: "203.0.113.9", userAgent: "test" };

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
  s.mailboxes.push(
    box(BOX_A, ACCOUNT_A, "me@acme.test"),
    box(BOX_A2, ACCOUNT_A, "two@acme.test"),
    box(BOX_B, ACCOUNT_B, "you@other.test"),
  );
  s.domains.push({
    id: "d1",
    accountId: ACCOUNT_A,
    name: "acme.test",
    status: "active",
    verifyToken: "t",
    stalwartId: null,
    lastError: null,
    createdAt: clock.now(),
  });
  const held = () => s.audit.filter((e) => e.action === "trust.send_held");
  return { d, s, clock, held };
}

describe("externalHeld", () => {
  it("holds only the new tier", () => {
    expect(externalHeld("new")).toBe(true);
    for (const t of ["standard", "trusted", "restricted"] as const) expect(externalHeld(t)).toBe(false);
  });
});

describe("SendingHeldError", () => {
  it("carries the sending_held code and the published wording", () => {
    const e = new SendingHeldError();
    expect(e.code).toBe("sending_held");
    expect(e.message).toMatch(/^New accounts can send to addresses hosted on AnhourMail/);
  });
});

describe("outsideAddresses", () => {
  it("returns the addresses on domains we don't host, lowercased and once each", async () => {
    const w = world();
    const out = await outsideAddresses(w.d, [
      "Friend@Gmail.Example",
      "friend@gmail.example",
      " me@ACME.test ",
      `x@${TEST_PLATFORM.freeAddressDomain}`,
      `y@${TEST_PLATFORM.domain.toUpperCase()}`,
      "z@sub.acme.test",
      "",
    ]);
    expect(out).toEqual(["friend@gmail.example", "z@sub.acme.test"]);
  });

  it("treats an address without @ as outside, and needs no database read for an empty list", async () => {
    const w = world();
    expect(await outsideAddresses(w.d, ["nobody"])).toEqual(["nobody"]);
    expect(await outsideAddresses(w.d, [])).toEqual([]);
  });

  it("a customer domain that isn't verified is outside", async () => {
    const w = world();
    w.s.domains.push({
      id: "d2",
      accountId: ACCOUNT_B,
      name: "pending.test",
      status: "pending_dns",
      verifyToken: "t",
      stalwartId: null,
      lastError: null,
      createdAt: w.clock.now(),
    });
    expect(await outsideAddresses(w.d, ["a@pending.test"])).toEqual(["a@pending.test"]);
  });
});

describe("recordSendHeld", () => {
  it("writes one denied entry in the mailbox's account log with a count only", async () => {
    const w = world();
    expect(
      await recordSendHeld(w.d, { address: " ME@acme.test", actorAddress: "Me@Acme.test", externalRecipients: 3 }, req),
    ).toBe(true);
    const [entry, ...rest] = w.held();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      result: "denied",
      errorCode: "sending_held",
      target: { type: "mailbox", id: BOX_A, label: "me@acme.test" },
      actor: { type: "system", email: "me@acme.test" },
      meta: { externalRecipients: 3 },
      requestId: "req-held",
    });
    // Never an address in the meta (rule 24).
    expect(JSON.stringify(entry?.meta)).not.toContain("@");
  });

  it("writes at most one entry per mailbox per hour; another mailbox gets its own", async () => {
    const w = world();
    const input = { address: "me@acme.test", actorAddress: "me@acme.test", externalRecipients: 1 };
    expect(await recordSendHeld(w.d, input, req)).toBe(true);
    expect(await recordSendHeld(w.d, input, req)).toBe(false);
    w.clock.set(new Date(w.clock.now().getTime() + SEND_HELD_EVERY_MS - 1000));
    expect(await recordSendHeld(w.d, input, req)).toBe(false);
    expect(await recordSendHeld(w.d, { ...input, address: "two@acme.test" }, req)).toBe(true);
    w.clock.set(new Date(w.clock.now().getTime() + 2000));
    expect(await recordSendHeld(w.d, input, req)).toBe(true);
    expect(w.held().map((e) => e.target.id)).toEqual([BOX_A, BOX_A2, BOX_A]);
  });

  it("records a send from a shared mailbox with the person's own mailbox as the actor", async () => {
    const w = world();
    await recordSendHeld(w.d, { address: "you@other.test", actorAddress: "me@acme.test", externalRecipients: 2 }, req);
    expect(w.held()[0]).toMatchObject({
      scope: `account:${ACCOUNT_B}`,
      actor: { type: "system", email: "me@acme.test" },
      target: { id: BOX_B },
    });
  });

  it("writes nothing for an address we don't hold, and clamps a bad count to 0", async () => {
    const w = world();
    expect(
      await recordSendHeld(w.d, { address: "ghost@acme.test", actorAddress: "x@y.test", externalRecipients: 1 }, req),
    ).toBe(false);
    expect(w.held()).toEqual([]);
    await recordSendHeld(w.d, { address: "me@acme.test", actorAddress: "me@acme.test", externalRecipients: NaN }, req);
    await recordSendHeld(w.d, { address: "two@acme.test", actorAddress: "two@acme.test", externalRecipients: -4 }, req);
    expect(w.held().map((e) => e.meta.externalRecipients)).toEqual([0, 0]);
  });
});
