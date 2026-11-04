// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_SAFE_SENDERS } from "@anhourmail/shared/senders";

import { ACCOUNT_A, ACCOUNT_B, actingStaff, deps, fixedClock, req, user } from "../__tests__/helpers";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import {
  accountSafeSenderEntries,
  accountSafeSendersForMailbox,
  addAccountSafeSenders,
  listAccountSafeSenders,
  MAX_SAFE_SENDERS_PER_ADD,
  removeAccountSafeSender,
} from "./account-safe-senders";

function setup() {
  const clock = fixedClock();
  const d = deps(clock);
  const mailbox = (id: string, accountId: string, address: string): Mailbox => ({
    id,
    accountId,
    userId: null,
    address,
    status: "active",
    quotaBytes: 1024,
    stalwartId: null,
    lastError: null,
    purgeAfter: null,
    createdAt: clock.now(),
  });
  d.uow.state.accounts.push(
    { id: ACCOUNT_A, name: "Acme", plan: "plus", createdAt: clock.now() },
    { id: ACCOUNT_B, name: "Other", plan: "plus", createdAt: clock.now() },
  );
  d.uow.state.mailboxes.push(
    mailbox("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ACCOUNT_A, "sam@a.test"),
    mailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ACCOUNT_B, "lee@b.test"),
  );
  return { d };
}

const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "ua-a", account: [[ACCOUNT_A, "user_admin"]] });
const auditor = user({ id: "aud-a", account: [[ACCOUNT_A, "auditor"]] });
const member = user({ id: "mem-a", account: [[ACCOUNT_A, "member"]] });
const domainAdmin = user({ id: "da-a", account: [[ACCOUNT_A, "domain_admin"]] });
const outsider = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

describe("account safe senders", () => {
  it("adds entries in their one form, skips ones already there, and audits counts only", async () => {
    const { d } = setup();
    const out = await addAccountSafeSenders(
      d,
      owner,
      {
        accountId: ACCOUNT_A,
        entries: ["Partner.Example", "@news.example", "Jane@Partner.Example", "partner.example"],
      },
      req,
    );
    expect(out.added).toBe(3);
    expect(out.entries.map((e) => [e.entry, e.kind])).toEqual([
      // One batch shares a time: then by entry.
      ["jane@partner.example", "address"],
      ["news.example", "domain"],
      ["partner.example", "domain"],
    ]);
    expect(out.limits).toMatchObject({ maxEntries: ACCOUNT_SAFE_SENDERS.maxEntries, usedChars: 50 });
    const again = await addAccountSafeSenders(
      d,
      userAdmin,
      { accountId: ACCOUNT_A, entries: ["partner.example"] },
      req,
    );
    expect(again.added).toBe(0);
    expect(again.entries).toHaveLength(3);
    const entry = d.uow.state.audit.find((a) => a.action === "junk_rules.account_safe_added");
    expect(entry).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      target: { type: "account", id: ACCOUNT_A, label: "Acme" },
      meta: { added: 3, addresses: 1, domains: 2, total: 3 },
    });
    // Never an entry, a domain or a local part in the log (rule 48).
    expect(JSON.stringify(d.uow.state.audit)).not.toMatch(/partner|news\.example|jane/i);
  });

  it("refuses what isn't an address or a domain, empty lists, too many at once and a full list", async () => {
    const { d } = setup();
    const add = (entries: unknown) => addAccountSafeSenders(d, owner, { accountId: ACCOUNT_A, entries }, req);
    await expect(add([])).rejects.toBeInstanceOf(ValidationError);
    await expect(add("partner.example")).rejects.toBeInstanceOf(ValidationError);
    await expect(add(["not an address"])).rejects.toThrow(/isn't an address or a domain/);
    await expect(add(["localhost"])).rejects.toBeInstanceOf(ValidationError);
    await expect(add([42])).rejects.toThrow("One entry is empty.");
    await expect(
      add(Array.from({ length: MAX_SAFE_SENDERS_PER_ADD + 1 }, (_, i) => `d${String(i)}.example`)),
    ).rejects.toThrow(/at a time/);
    for (let i = 0; i < 3; i++) {
      await add(Array.from({ length: 100 }, (_, j) => `d${String(i * 100 + j)}.example`));
    }
    await expect(add(["one-more.example"])).rejects.toThrow(/up to 300 entries/);
    expect((await listAccountSafeSenders(d, owner, { accountId: ACCOUNT_A })).entries).toHaveLength(300);
  });

  it("refuses a list over the character budget", async () => {
    const { d } = setup();
    const long = (i: number) => `${"x".repeat(60)}${String(i).padStart(3, "0")}.${"y".repeat(60)}.example`;
    await addAccountSafeSenders(
      d,
      owner,
      { accountId: ACCOUNT_A, entries: Array.from({ length: 90 }, (_, i) => long(i)) },
      req,
    );
    await expect(
      addAccountSafeSenders(d, owner, { accountId: ACCOUNT_A, entries: [long(90), long(91), long(92)] }, req),
    ).rejects.toThrow(/too long/);
  });

  it("removes one entry by id; another account's id is a 404; audits the kind only", async () => {
    const { d } = setup();
    const a = await addAccountSafeSenders(d, owner, { accountId: ACCOUNT_A, entries: ["jane@partner.example"] }, req);
    const b = await addAccountSafeSenders(d, outsider, { accountId: ACCOUNT_B, entries: ["other.example"] }, req);
    const theirs = b.entries[0]?.id ?? "";
    await expect(removeAccountSafeSender(d, owner, { accountId: ACCOUNT_A, id: theirs }, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      removeAccountSafeSender(d, owner, { accountId: ACCOUNT_A, id: "not-a-uuid" }, req),
    ).rejects.toBeInstanceOf(NotFoundError);
    const left = await removeAccountSafeSender(d, userAdmin, { accountId: ACCOUNT_A, id: a.entries[0]?.id ?? "" }, req);
    expect(left.entries).toEqual([]);
    expect(d.uow.state.audit.filter((x) => x.action === "junk_rules.account_safe_removed").at(-1)).toMatchObject({
      result: "success",
      meta: { kind: "address", total: 0 },
    });
    expect((await listAccountSafeSenders(d, outsider, { accountId: ACCOUNT_B })).entries).toHaveLength(1);
  });

  it("lets Owners and User Administrators change it; Read-only reads; others are refused, outsiders get 404", async () => {
    const { d } = setup();
    await addAccountSafeSenders(d, owner, { accountId: ACCOUNT_A, entries: ["partner.example"] }, req);
    expect((await listAccountSafeSenders(d, owner, { accountId: ACCOUNT_A })).canManage).toBe(true);
    expect((await listAccountSafeSenders(d, userAdmin, { accountId: ACCOUNT_A })).canManage).toBe(true);
    const read = await listAccountSafeSenders(d, auditor, { accountId: ACCOUNT_A });
    expect(read.canManage).toBe(false);
    expect(read.entries).toHaveLength(1);
    await expect(listAccountSafeSenders(d, member, { accountId: ACCOUNT_A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAccountSafeSenders(d, domainAdmin, { accountId: ACCOUNT_A })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listAccountSafeSenders(d, outsider, { accountId: ACCOUNT_A })).rejects.toBeInstanceOf(NotFoundError);
    for (const who of [auditor, member, domainAdmin, actingStaff(ACCOUNT_A)]) {
      await expect(
        addAccountSafeSenders(d, who, { accountId: ACCOUNT_A, entries: ["x.example"] }, req),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(
      addAccountSafeSenders(d, outsider, { accountId: ACCOUNT_A, entries: ["x.example"] }, req),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Denied attempts are audited in the account's log; outsiders' probes in the platform log.
    expect(d.uow.state.audit.filter((x) => x.result === "denied" && x.scope === `account:${ACCOUNT_A}`)).toHaveLength(
      4,
    );
    expect((await listAccountSafeSenders(d, owner, { accountId: ACCOUNT_A })).entries).toHaveLength(1);
  });

  it("answers the list for a mailbox by its address, and an account's entries", async () => {
    const { d } = setup();
    await addAccountSafeSenders(d, owner, { accountId: ACCOUNT_A, entries: ["partner.example"] }, req);
    expect(await accountSafeSendersForMailbox(d, " Sam@A.test ")).toEqual({
      accountId: ACCOUNT_A,
      entries: ["partner.example"],
    });
    expect(await accountSafeSendersForMailbox(d, "lee@b.test")).toEqual({ accountId: ACCOUNT_B, entries: [] });
    expect(await accountSafeSendersForMailbox(d, "nobody@x.test")).toBeNull();
    expect(await accountSafeSenderEntries(d, ACCOUNT_A)).toEqual(["partner.example"]);
  });
});
