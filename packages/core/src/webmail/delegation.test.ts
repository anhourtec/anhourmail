// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps, fixedClock, req } from "../__tests__/helpers";
import type { DelegationRight } from "../delegation/entity";
import { DelegatedMailboxRefusedError, ForbiddenError, TryAgainError } from "../errors";
import type { Mailbox, MailboxStatus } from "../mailboxes/entity";
import type { WebmailAccess } from "./access";
import {
  CredentialSlotTakenError,
  type DelegatedTarget,
  delegatedMailboxesFor,
  delegationCheck,
  DelegationGate,
  openDelegatedMailbox,
} from "./delegation";

const DESK = "aaaaaaaa-0000-4000-8000-000000000001";
const KIM_BOX = "aaaaaaaa-0000-4000-8000-000000000002";
const LEE_BOX = "aaaaaaaa-0000-4000-8000-000000000003";
const OLD = "aaaaaaaa-0000-4000-8000-000000000004";
const B_BOX = "bbbbbbbb-0000-4000-8000-000000000001";
const B_DESK = "bbbbbbbb-0000-4000-8000-000000000002";

/** Account A (Plus): Kim and Lee (members) with their mailboxes, a shared desk@ and a deleting old@; account B. */
function world(plan: "plus" | "free" = "plus") {
  const clock = fixedClock("2026-10-30T12:00:00Z");
  const d = deps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Family A", plan }, { id: ACCOUNT_B, name: "Family B", plan: "plus" });
  for (const [id, accountId] of [
    ["kim", ACCOUNT_A],
    ["lee", ACCOUNT_A],
    ["bea", ACCOUNT_B],
  ] as const) {
    s.userEmails[id] = `${id}@console.test`;
    s.userNames[id] = id;
    s.memberships.push({ userId: id, accountId, role: "member" });
  }
  const box = (id: string, accountId: string, address: string, userId: string | null, status: MailboxStatus) =>
    ({
      id,
      accountId,
      userId,
      address,
      status,
      quotaBytes: 1,
      stalwartId: `s-${id.slice(-2)}`,
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(0),
    }) satisfies Mailbox;
  s.mailboxes.push(
    box(DESK, ACCOUNT_A, "desk@family.test", null, "active"),
    box(KIM_BOX, ACCOUNT_A, "kim@family.test", "kim", "active"),
    box(LEE_BOX, ACCOUNT_A, "lee@family.test", "lee", "active"),
    box(OLD, ACCOUNT_A, "old@family.test", null, "deleting"),
    box(B_BOX, ACCOUNT_B, "bea@b.test", "bea", "active"),
    box(B_DESK, ACCOUNT_B, "desk@b.test", null, "active"),
  );
  const grant = (mailboxId: string, userId: string, right: DelegationRight, accountId = ACCOUNT_A) =>
    s.delegations.push({
      id: `${mailboxId}-${userId}-${right}`,
      accountId,
      mailboxId,
      granteeUserId: userId,
      right,
      grantedBy: "owner",
      createdAt: new Date(0),
    });
  const states: Record<string, WebmailAccess> = {};
  const access = { state: async (a: string) => states[a] ?? ("ok" as const) };
  const opened: DelegatedTarget[] = [];
  const signIn = async (t: DelegatedTarget) => {
    opened.push(t);
    return { username: t.address, accessToken: "secret-token" };
  };
  const open = (
    address: string,
    owners = ["kim@family.test"],
    extra: { console?: { userId: string; sessionId: string } } = {},
  ) => openDelegatedMailbox(d, access, { owners, address, ...extra }, signIn, req);
  const audits = (accountId = ACCOUNT_A) =>
    s.audit.filter((e) => e.scope === `account:${accountId}` && e.action === "delegation.mailbox_opened");
  return { d, s, clock, grant, states, access, opened, open, audits, signIn };
}

describe("delegatedMailboxesFor", () => {
  it("lists every mailbox the session's people hold a right on, with the rights and the mailbox they came through", async () => {
    const { d, grant } = world();
    grant(DESK, "kim", "full_access");
    grant(DESK, "kim", "send_as");
    grant(LEE_BOX, "kim", "send_on_behalf");
    grant(LEE_BOX, "lee", "full_access"); // never on one's own mailbox in practice; skipped if it happens
    expect(await delegatedMailboxesFor(d, ["KIM@family.test"])).toEqual([
      {
        accountId: ACCOUNT_A,
        mailboxId: DESK,
        address: "desk@family.test",
        granteeUserId: "kim",
        via: "kim@family.test",
        rights: ["full_access", "send_as"],
      },
      {
        accountId: ACCOUNT_A,
        mailboxId: LEE_BOX,
        address: "lee@family.test",
        granteeUserId: "kim",
        via: "kim@family.test",
        rights: ["send_on_behalf"],
      },
    ]);
    // Lee's own mailbox never shows as delegated to Lee.
    expect(await delegatedMailboxesFor(d, ["lee@family.test"])).toEqual([]);
  });

  it("maps nothing for a shared mailbox signed in by password, unknown addresses, or a plan without delegation", async () => {
    const { d, grant } = world("free");
    grant(DESK, "kim", "full_access");
    expect(await delegatedMailboxesFor(d, ["desk@family.test", "nobody@x.test"])).toEqual([]);
    expect(await delegatedMailboxesFor(d, ["kim@family.test"])).toEqual([]);
  });

  it("leaves out suspended or deleting mailboxes, and everything for a removed or suspended person", async () => {
    const { d, s, grant } = world();
    grant(DESK, "kim", "full_access");
    grant(OLD, "kim", "full_access");
    expect((await delegatedMailboxesFor(d, ["kim@family.test"])).map((m) => m.address)).toEqual(["desk@family.test"]);
    s.suspended.push("kim");
    expect(await delegatedMailboxesFor(d, ["kim@family.test"])).toEqual([]);
    s.suspended = [];
    s.memberships = s.memberships.filter((m) => m.userId !== "kim");
    expect(await delegatedMailboxesFor(d, ["kim@family.test"])).toEqual([]);
  });

  it("keeps people in different accounts apart: each sees their own account's grants only", async () => {
    const { d, grant } = world();
    grant(DESK, "kim", "full_access");
    grant(B_DESK, "bea", "full_access", ACCOUNT_B);
    const list = await delegatedMailboxesFor(d, ["kim@family.test", "bea@b.test"]);
    expect(list.map((m) => `${m.via}→${m.address}`)).toEqual([
      "kim@family.test→desk@family.test",
      "bea@b.test→desk@b.test",
    ]);
  });
});

describe("openDelegatedMailbox", () => {
  it("opens a granted mailbox under the account and credential locks, and audits it in the account", async () => {
    const { s, grant, open, opened, audits } = world();
    grant(DESK, "kim", "full_access");
    const out = await open("Desk@Family.test");
    expect(out.mailbox).toMatchObject({ mailboxId: DESK, address: "desk@family.test", via: "kim@family.test" });
    expect(opened).toEqual([
      {
        accountId: ACCOUNT_A,
        mailboxId: DESK,
        address: "desk@family.test",
        externalId: "s-01",
        granteeUserId: "kim",
        via: "kim@family.test",
      },
    ]);
    expect(s.credentialLocks).toEqual([DESK]);
    const [entry] = audits();
    expect(entry).toMatchObject({
      result: "success",
      actor: { type: "user", userId: "kim", email: "kim@console.test" },
      target: { type: "mailbox", id: DESK, label: "desk@family.test" },
      meta: { need: "full_access" },
    });
    expect(JSON.stringify(s.audit)).not.toContain("secret-token");
  });

  it("answers the same refusal for no grant, a send-only grant, an unknown address and another account's mailbox", async () => {
    const { grant, open, opened, audits } = world();
    grant(LEE_BOX, "kim", "send_as");
    for (const address of [
      "desk@family.test",
      "lee@family.test",
      "nobody@family.test",
      "desk@b.test",
      "x".repeat(300),
    ]) {
      const err = await open(address).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DelegatedMailboxRefusedError);
      expect((err as Error).message).toBe("You don't have access to this mailbox.");
    }
    expect(opened).toEqual([]);
    // Every refusal is in Kim's own account; another account's mailbox is never named there.
    const rows = audits();
    expect(rows.map((r) => `${r.result}:${r.errorCode ?? ""}`)).toEqual(Array(5).fill("denied:not_granted"));
    expect(rows.map((r) => r.target.id)).toEqual([DESK, LEE_BOX, null, null, null]);
    expect(JSON.stringify(rows)).not.toContain("desk@b.test");
    expect(audits(ACCOUNT_B)).toEqual([]);
  });

  it("refuses after a revoke, a removal, a suspension and a plan downgrade, and for a suspended or deleting mailbox", async () => {
    const t = world();
    t.grant(DESK, "kim", "full_access");
    await t.open("desk@family.test");
    t.s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "free" };
    await expect(t.open("desk@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    t.s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus" };
    t.states["desk@family.test"] = "suspended";
    await expect(t.open("desk@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    delete t.states["desk@family.test"];
    t.s.suspended.push("kim");
    await expect(t.open("desk@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    t.s.suspended = [];
    t.grant(OLD, "kim", "full_access");
    await expect(t.open("old@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    t.s.delegations = [];
    await expect(t.open("desk@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    expect(t.opened).toHaveLength(1);
    expect(t.audits().map((r) => `${r.result}:${r.errorCode ?? ""}`)).toEqual([
      "success:",
      "denied:not_granted",
      "denied:mailbox_unavailable",
      "denied:forbidden",
      "denied:mailbox_unavailable",
      "denied:not_granted",
    ]);
  });

  it("refuses when the delegate's own mailbox is no longer theirs or can't be used", async () => {
    const t = world();
    t.grant(DESK, "kim", "full_access");
    t.states["kim@family.test"] = "suspended";
    await expect(t.open("desk@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    delete t.states["kim@family.test"];
    const kim = t.s.mailboxes.find((m) => m.id === KIM_BOX);
    if (kim) kim.userId = null;
    await expect(t.open("desk@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
    expect(t.opened).toEqual([]);
  });

  it("refuses with 403 while the console session the webmail came from has act-as open, before any lookup", async () => {
    const t = world();
    t.grant(DESK, "kim", "full_access");
    t.s.actAsSessions.push({
      id: "aa",
      staffUserId: "kim",
      staffRole: "support_admin",
      authSessionId: "cs-1",
      accountId: ACCOUNT_B,
      reason: "ticket",
      startedAt: new Date("2026-10-30T11:00:00Z"),
      expiresAt: new Date("2026-10-30T13:00:00Z"),
      endedAt: null,
      endReason: null,
    });
    await expect(
      t.open("desk@family.test", ["kim@family.test"], { console: { userId: "kim", sessionId: "cs-1" } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(t.audits()[0]).toMatchObject({ result: "denied", errorCode: "act_as", target: { id: DESK } });
    expect(t.opened).toEqual([]);
    // Another console session of the same person is unaffected.
    await t.open("desk@family.test", ["kim@family.test"], { console: { userId: "kim", sessionId: "cs-2" } });
    expect(t.opened).toHaveLength(1);
  });

  it("picks the session's person who holds the right, and audits nothing when no own mailbox has a person", async () => {
    const t = world();
    t.grant(DESK, "lee", "full_access");
    const out = await t.open("desk@family.test", ["kim@family.test", "lee@family.test"]);
    expect(out.mailbox).toMatchObject({ granteeUserId: "lee", via: "lee@family.test" });
    await expect(t.open("desk@family.test", ["desk@family.test", "nobody@x.test"])).rejects.toBeInstanceOf(
      DelegatedMailboxRefusedError,
    );
    expect(t.audits()).toHaveLength(1);
  });

  it("retries once when the credential slot was taken, then answers 503, audited as failed", async () => {
    const t = world();
    t.grant(DESK, "kim", "full_access");
    let tries = 0;
    const flaky = async (target: DelegatedTarget) => {
      tries += 1;
      if (tries === 1) throw new CredentialSlotTakenError("slot");
      return { username: target.address };
    };
    await openDelegatedMailbox(t.d, t.access, { owners: ["kim@family.test"], address: "desk@family.test" }, flaky, req);
    expect(tries).toBe(2);
    const busy = async () => {
      tries += 1;
      throw new CredentialSlotTakenError("slot");
    };
    await expect(
      openDelegatedMailbox(t.d, t.access, { owners: ["kim@family.test"], address: "desk@family.test" }, busy, req),
    ).rejects.toBeInstanceOf(TryAgainError);
    expect(tries).toBe(4);
    // A mail server naming another mailbox is a failure too; other errors pass through.
    await expect(
      openDelegatedMailbox(
        t.d,
        t.access,
        { owners: ["kim@family.test"], address: "desk@family.test" },
        async () => ({ username: "kim@family.test" }),
        req,
      ),
    ).rejects.toBeInstanceOf(TryAgainError);
    const boom = new Error("down");
    await expect(
      openDelegatedMailbox(
        t.d,
        t.access,
        { owners: ["kim@family.test"], address: "desk@family.test" },
        () => Promise.reject(boom),
        req,
      ),
    ).rejects.toBe(boom);
    expect(t.audits().map((r) => `${r.result}:${r.errorCode ?? ""}`)).toEqual([
      "success:",
      "failed:unavailable",
      "failed:unavailable",
      "failed:server_error",
    ]);
  });

  it("opens for sending only with a send right (slice 13 uses it)", async () => {
    const t = world();
    t.grant(LEE_BOX, "kim", "send_on_behalf");
    const send = (address: string) =>
      openDelegatedMailbox(t.d, t.access, { owners: ["kim@family.test"], address, need: "send" }, t.signIn, req);
    expect((await send("lee@family.test")).mailbox.rights).toEqual(["send_on_behalf"]);
    t.grant(DESK, "kim", "full_access");
    await expect(send("desk@family.test")).rejects.toBeInstanceOf(DelegatedMailboxRefusedError);
  });
});

describe("DelegationGate", () => {
  const entry = { mailboxId: DESK, granteeUserId: "kim", via: "kim@family.test", need: "full_access" as const };

  it("checks the grant now: a revoke, a removal, a plan downgrade or a suspended mailbox refuse at once", async () => {
    const t = world();
    const check = delegationCheck(t.d, t.access);
    expect(await check(entry)).toBe(false);
    t.grant(DESK, "kim", "full_access");
    expect(await check(entry)).toBe(true);
    expect(await check({ ...entry, need: "send" })).toBe(false);
    expect(await check({ ...entry, via: "lee@family.test" })).toBe(false);
    expect(await check({ ...entry, via: "nobody@x.test" })).toBe(false);
    t.s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "free" };
    expect(await check(entry)).toBe(false);
    t.s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "plus" };
    t.states["desk@family.test"] = "deleting";
    expect(await check(entry)).toBe(false);
    delete t.states["desk@family.test"];
    t.s.memberships = t.s.memberships.filter((m) => m.userId !== "kim");
    expect(await check(entry)).toBe(false);
    expect(t.s.audit).toEqual([]);
  });

  it("caches 'has the right' for at most 10 s per session and mailbox, and never caches 'no right'", async () => {
    let now = 0;
    let allowed = true;
    let asked = 0;
    const gate = new DelegationGate(
      async () => {
        asked += 1;
        return allowed;
      },
      { ttlMs: 60_000, now: () => now },
    );
    expect(await gate.allowed("s1", entry)).toBe(true);
    allowed = false;
    now = 9_999;
    expect(await gate.allowed("s1", entry)).toBe(true);
    // Another session, mailbox or need asks again.
    expect(await gate.allowed("s2", entry)).toBe(false);
    expect(await gate.allowed("s1", { ...entry, need: "send" })).toBe(false);
    now = 10_000;
    expect(await gate.allowed("s1", entry)).toBe(false);
    expect(await gate.allowed("s1", entry)).toBe(false);
    expect(asked).toBe(5);
    allowed = true;
    expect(await gate.allowed("s1", entry)).toBe(true);
    gate.forget("s1");
    expect(await gate.allowed("s1", entry)).toBe(true);
    expect(asked).toBe(7);
  });
});
