// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, deps as makeDeps, fixedClock, user } from "../__tests__/helpers";
import { ForbiddenError, NotFoundError } from "../errors";
import { GB, type Mailbox } from "./entity";
import { getMailbox, listMailboxes } from "./service";
import { type MailboxUsageReader, measureStorage } from "./storage";

const MBX = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MBX_2 = "d2d2d2d2-dddd-4ddd-8ddd-dddddddddddd";
const MBX_NEW = "d3d3d3d3-dddd-4ddd-8ddd-dddddddddddd";
const MBX_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });
const outsider = user({ id: "nobody" });

function setup() {
  const clock = fixedClock("2026-10-23T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["member", ACCOUNT_A, "member"],
    ["uadmin", ACCOUNT_A, "user_admin"],
    ["owner-b", ACCOUNT_B, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@example.ca`;
  }
  const mailbox = (id: string, accountId: string, address: string, stalwartId: string | null): Mailbox => ({
    id,
    accountId,
    userId: "member",
    address,
    status: stalwartId ? "active" : "provisioning",
    quotaBytes: 10 * GB,
    stalwartId,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    mailbox(MBX, ACCOUNT_A, "kid@family.ca", "s1"),
    mailbox(MBX_2, ACCOUNT_A, "Mum@family.ca", "s2"),
    mailbox(MBX_NEW, ACCOUNT_A, "new@family.ca", null),
    mailbox(MBX_B, ACCOUNT_B, "b@other.ca", "s3"),
  );
  return { d, s, clock };
}

/** A fake mail server: sizes by account id, with names; can fail chosen calls. */
function reader(
  accounts: Record<string, { name: string; used: number }>,
  opts: { failCalls?: number[] } = {},
): MailboxUsageReader & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    usage: async (ids) => {
      calls.push([...ids]);
      if (opts.failCalls?.includes(calls.length)) throw new Error("mail server unavailable");
      return ids.flatMap((id) => {
        const a = accounts[id];
        return a ? [{ externalId: id, localPart: a.name, usedBytes: a.used }] : [];
      });
    },
  };
}

describe("measureStorage", () => {
  it("measures every mailbox on the mail server in batches and records the time", async () => {
    const { d, clock } = setup();
    const r = reader({ s1: { name: "kid", used: 1234 }, s2: { name: "mum", used: 0 }, s3: { name: "b", used: 9 } });
    const run = await measureStorage(d, r, { batchSize: 2 });
    expect(run).toEqual({ mailboxes: 3, measured: 3, skipped: 0, failedBatches: 0 });
    // Only mailboxes the mail server has, never more than a batch per call.
    expect(r.calls.flat().sort()).toEqual(["s1", "s2", "s3"]);
    expect(r.calls.every((c) => c.length <= 2)).toBe(true);
    expect(r.calls).toHaveLength(2);
    const list = await listMailboxes(d, owner, ACCOUNT_A);
    expect(list.find((m) => m.id === MBX)).toMatchObject({ storageUsedBytes: 1234, storageCheckedAt: clock.now() });
    // Zero is a real measurement (the local part matches case-insensitively).
    expect(list.find((m) => m.id === MBX_2)).toMatchObject({ storageUsedBytes: 0 });
    expect(list.find((m) => m.id === MBX_NEW)).toMatchObject({ storageUsedBytes: null, storageCheckedAt: null });
  });

  it("a failed batch keeps the last good value; the other batches still record", async () => {
    const { d, clock } = setup();
    await measureStorage(d, reader({ s1: { name: "kid", used: 100 }, s2: { name: "mum", used: 200 } }));
    const first = clock.now();
    clock.set(new Date(first.getTime() + 10 * 60_000));
    const r = reader(
      { s1: { name: "kid", used: 999 }, s2: { name: "mum", used: 888 }, s3: { name: "b", used: 7 } },
      { failCalls: [1] },
    );
    const run = await measureStorage(d, r, { batchSize: 2 });
    expect(run).toMatchObject({ failedBatches: 1, measured: 1 });
    const list = await listMailboxes(d, owner, ACCOUNT_A);
    // The failed batch (s1, s2) still shows the earlier values and time — never wiped to unknown.
    expect(list.find((m) => m.id === MBX)).toMatchObject({ storageUsedBytes: 100, storageCheckedAt: first });
    expect(list.find((m) => m.id === MBX_2)).toMatchObject({ storageUsedBytes: 200 });
    const b = await listMailboxes(d, ownerB, ACCOUNT_B);
    expect(b[0]).toMatchObject({ storageUsedBytes: 7, storageCheckedAt: clock.now() });
  });

  it("every batch failing writes nothing", async () => {
    const { d } = setup();
    const run = await measureStorage(d, reader({}, { failCalls: [1, 2, 3] }), { batchSize: 1 });
    expect(run).toEqual({ mailboxes: 3, measured: 0, skipped: 0, failedBatches: 3 });
    expect((await listMailboxes(d, owner, ACCOUNT_A)).every((m) => m.storageUsedBytes === null)).toBe(true);
  });

  it("skips accounts that are gone, renamed, or report nonsense", async () => {
    const { d } = setup();
    const r: MailboxUsageReader = {
      usage: async () => [
        { externalId: "s1", localPart: "someone-else", usedBytes: 5 },
        { externalId: "s3", localPart: "b", usedBytes: -1 },
        { externalId: "unasked", localPart: "x", usedBytes: 1 },
      ],
    };
    expect(await measureStorage(d, r)).toEqual({ mailboxes: 3, measured: 0, skipped: 3, failedBatches: 0 });
    expect((await listMailboxes(d, owner, ACCOUNT_A)).every((m) => m.storageUsedBytes === null)).toBe(true);
  });

  it("nothing on the mail server: no calls", async () => {
    const { d, s } = setup();
    for (const m of s.mailboxes) m.stalwartId = null;
    const r = reader({});
    expect(await measureStorage(d, r)).toEqual({ mailboxes: 0, measured: 0, skipped: 0, failedBatches: 0 });
    expect(r.calls).toHaveLength(0);
  });
});

describe("reading storage follows mailbox scope", () => {
  it("whoever can see mailboxes sees it; other accounts 404, missing permission 403", async () => {
    const { d } = setup();
    await measureStorage(d, reader({ s1: { name: "kid", used: 42 }, s3: { name: "b", used: 9 } }));
    expect(await getMailbox(d, userAdmin, ACCOUNT_A, MBX)).toMatchObject({ storageUsedBytes: 42 });
    // Another account's mailbox id through this account: not found, and its size isn't revealed.
    await expect(getMailbox(d, owner, ACCOUNT_A, MBX_B)).rejects.toBeInstanceOf(NotFoundError);
    // A member whose role doesn't include mailboxes: 403; someone outside the account: 404.
    await expect(listMailboxes(d, member, ACCOUNT_A)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMailboxes(d, outsider, ACCOUNT_A)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listMailboxes(d, ownerB, ACCOUNT_B)).map((m) => m.storageUsedBytes)).toEqual([9]);
  });
});
