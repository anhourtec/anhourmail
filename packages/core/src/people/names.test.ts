// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, actingStaff, deps, fakeHasher, fixedClock, req, user } from "../__tests__/helpers";
import type { Actor } from "../actor";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { releaseMailboxOwner } from "../mailboxes/release";
import {
  mailboxSenderName,
  queuePersonNameSync,
  SENDER_NAME_NOT_MEMBER,
  SENDER_NAME_OTHER_ACCOUNT,
  SENDER_NAME_SET_BY_ADMIN,
  setWebmailSenderName,
  webmailSenderName,
  webmailSendingNames,
} from "./names";
import { updateOwnProfile, updatePersonProfile } from "./profile-service";

const box = (id: string, accountId: string, userId: string | null, extra: Partial<Mailbox> = {}): Mailbox => ({
  id,
  accountId,
  userId,
  address: `${id.toLowerCase()}@a.test`,
  status: "active",
  quotaBytes: 1,
  stalwartId: `s-${id}`,
  lastError: null,
  purgeAfter: null,
  createdAt: new Date(0),
  ...extra,
});

/**
 * Ada (Member, account A only) with her own mailbox `ada` and one with a custom name `adaDesk`; Kim (Member of A and
 * B) with `kim` in A and `kimB` in B; a person-less `shared` mailbox; an Owner and a User Admin of A.
 */
function world() {
  const d = deps(fixedClock("2026-10-31T12:00:00Z"));
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  const people: [string, "owner" | "user_admin" | "member", string, string][] = [
    ["owner", "owner", ACCOUNT_A, "Olive Owner"],
    ["admin", "user_admin", ACCOUNT_A, "Adam Admin"],
    ["ada", "member", ACCOUNT_A, "Ada Lovelace"],
    ["kim", "member", ACCOUNT_A, "Kim Lee"],
    ["kim", "member", ACCOUNT_B, "Kim Lee"],
  ];
  for (const [id, role, accountId, name] of people) {
    s.userEmails[id] = `${id}@console.test`;
    s.userNames[id] = name;
    s.memberships.push({ userId: id, accountId, role });
  }
  s.mailboxes.push(
    box("ada", ACCOUNT_A, "ada"),
    box("adaDesk", ACCOUNT_A, "ada", { displayName: "Ada at the desk" }),
    box("adaGone", ACCOUNT_A, "ada", { status: "deleting" }),
    box("kim", ACCOUNT_A, "kim"),
    box("kimB", ACCOUNT_B, "kim"),
    box("shared", ACCOUNT_A, null, { displayName: "Front desk" }),
    box("nameless", ACCOUNT_A, null),
  );
  const as = (id: string): Actor => {
    const u = user({
      id,
      account: s.memberships
        .filter((m) => m.userId === id)
        .map((m) => [m.accountId, m.role] as [string, typeof m.role]),
    });
    return { ...u, email: s.userEmails[id] ?? u.email };
  };
  return { d, s, as };
}

const ensures = (s: ReturnType<typeof world>["s"]) =>
  s.jobs.filter((j) => j.kind === "mailbox.ensure").map((j) => j.subjectId);

describe("mailboxSenderName", () => {
  it("is the custom display name, else the person's name, else none", () => {
    expect(mailboxSenderName(" Front desk ", "Ada")).toEqual({ name: "Front desk", source: "custom" });
    expect(mailboxSenderName(null, " Ada Lovelace ")).toEqual({ name: "Ada Lovelace", source: "person" });
    expect(mailboxSenderName("  ", "Ada")).toEqual({ name: "Ada", source: "person" });
    expect(mailboxSenderName(undefined, null)).toEqual({ name: null, source: "none" });
    expect(mailboxSenderName(null, "   ")).toEqual({ name: null, source: "none" });
  });
});

describe("queuePersonNameSync", () => {
  it("queues the mail server for every mailbox that follows the person, in every account", async () => {
    const { d, s } = world();
    expect(await d.uow.run((r) => queuePersonNameSync(r, "kim", d.clock.now()))).toBe(2);
    expect(ensures(s).sort()).toEqual(["kim", "kimB"]);
    // A custom display name and a mailbox being deleted are left alone.
    expect(await d.uow.run((r) => queuePersonNameSync(r, "ada", d.clock.now()))).toBe(1);
    expect(ensures(s)).toContain("ada");
    expect(ensures(s)).not.toContain("adaDesk");
    expect(ensures(s)).not.toContain("adaGone");
  });
});

describe("profile name edits", () => {
  it("changes the person's own name and queues their mailboxes; the audit names the field, never the value", async () => {
    const { d, s, as } = world();
    s.profiles.ada = { jobTitle: "Engineer" };
    const out = await updateOwnProfile(d, as("ada"), { name: "  Ada  King " }, req);
    expect(out).toMatchObject({ changed: ["name"], name: "Ada King" });
    expect(s.userNames.ada).toBe("Ada King");
    // A name-only edit keeps the other details.
    expect(s.profiles.ada).toEqual({ jobTitle: "Engineer" });
    expect(ensures(s)).toEqual(["ada"]);
    const entry = s.audit.at(-1);
    expect(entry).toMatchObject({ action: "account.profile_changed", result: "success", meta: { fields: ["name"] } });
    expect(JSON.stringify(s.audit)).not.toContain("Ada King");
    // The same name again changes nothing and queues nothing.
    expect((await updateOwnProfile(d, as("ada"), { name: "Ada King" }, req)).changed).toEqual([]);
    expect(ensures(s)).toEqual(["ada"]);
  });

  it("checks the name by the name rules", async () => {
    const { d, as } = world();
    await expect(updateOwnProfile(d, as("ada"), { name: " " }, req)).rejects.toThrow(/Enter your name/);
    await expect(updateOwnProfile(d, as("ada"), { name: "visit example.com" }, req)).rejects.toThrow(ValidationError);
    await expect(updateOwnProfile(d, as("ada"), { name: "x".repeat(81) }, req)).rejects.toThrow(ValidationError);
  });

  it("lets an admin rename a Member, not an admin above them, nor someone in another account (403)", async () => {
    const { d, s, as } = world();
    await updatePersonProfile(d, as("admin"), ACCOUNT_A, "ada", { name: "Ada K" }, req);
    expect(s.userNames.ada).toBe("Ada K");
    expect(ensures(s)).toEqual(["ada"]);
    await expect(updatePersonProfile(d, as("admin"), ACCOUNT_A, "owner", { name: "X" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(updatePersonProfile(d, as("owner"), ACCOUNT_A, "kim", { name: "X" }, req)).rejects.toThrow(
      /another account/,
    );
    expect(s.userNames.kim).toBe("Kim Lee");
    expect(s.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "other_account" });
  });

  it("answers 404 for someone outside the account and refuses staff acting as someone", async () => {
    const { d, s, as } = world();
    const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });
    await expect(updatePersonProfile(d, ownerB, ACCOUNT_B, "ada", { name: "X" }, req)).rejects.toThrow(NotFoundError);
    await expect(updatePersonProfile(d, as("owner"), ACCOUNT_B, "kim", { name: "X" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(updateOwnProfile(d, actingStaff(ACCOUNT_A), { name: "X" }, req)).rejects.toThrow(ForbiddenError);
    expect(s.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "act_as" });
    expect(s.userNames.ada).toBe("Ada Lovelace");
    expect(ensures(s)).toEqual([]);
  });
});

describe("the webmail sender name", () => {
  it("follows the person and may be changed from their own mailbox: their name, everywhere", async () => {
    const { d, s } = world();
    expect(await webmailSenderName(d, "ADA@a.test")).toEqual({
      name: "Ada Lovelace",
      source: "person",
      editable: true,
    });
    const out = await setWebmailSenderName(d, "ada@a.test", { name: "Ada King" }, req);
    expect(out).toEqual({ name: "Ada King", source: "person", editable: true });
    expect(s.userNames.ada).toBe("Ada King");
    expect(ensures(s)).toEqual(["ada"]);
    expect(s.audit.at(-1)).toMatchObject({
      action: "account.profile_changed",
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      target: { type: "person", id: "ada", label: "ada@console.test" },
      meta: { fields: ["name"], self: true, via: "webmail" },
    });
    expect(JSON.stringify(s.audit)).not.toContain("Ada King");
    await expect(setWebmailSenderName(d, "ada@a.test", { name: "" }, req)).rejects.toThrow(ValidationError);
  });

  it("is read-only where an admin set it or there's no person, and when the person is in another account", async () => {
    const { d, s } = world();
    expect(await webmailSenderName(d, "adaDesk@a.test")).toEqual({
      name: "Ada at the desk",
      source: "custom",
      editable: false,
      reason: SENDER_NAME_SET_BY_ADMIN,
    });
    await expect(setWebmailSenderName(d, "adaDesk@a.test", { name: "X" }, req)).rejects.toThrow(ForbiddenError);
    expect(s.audit.at(-1)).toMatchObject({
      action: "account.profile_changed",
      result: "denied",
      errorCode: "admin_set",
    });
    expect(await webmailSenderName(d, "shared@a.test")).toMatchObject({ name: "Front desk", editable: false });
    expect(await webmailSenderName(d, "nameless@a.test")).toMatchObject({ name: null, source: "none" });
    await expect(setWebmailSenderName(d, "shared@a.test", { name: "X" }, req)).rejects.toThrow(
      SENDER_NAME_SET_BY_ADMIN,
    );
    expect(s.audit.at(-1)).toMatchObject({ action: "mailbox.renamed", result: "denied", errorCode: "admin_set" });
    expect(await webmailSenderName(d, "kim@a.test")).toMatchObject({
      editable: false,
      reason: SENDER_NAME_OTHER_ACCOUNT,
    });
    await expect(setWebmailSenderName(d, "kim@a.test", { name: "X" }, req)).rejects.toThrow(SENDER_NAME_OTHER_ACCOUNT);
    expect(s.userNames.kim).toBe("Kim Lee");
    expect(ensures(s)).toEqual([]);
  });

  it("is read-only for a person holding a platform role, even with this account as their only one", async () => {
    const { d, s } = world();
    s.platformRoles.push({ userId: "ada", role: "global_admin" });
    expect(await webmailSenderName(d, "ada@a.test")).toMatchObject({
      editable: false,
      reason: SENDER_NAME_OTHER_ACCOUNT,
    });
    await expect(setWebmailSenderName(d, "ada@a.test", { name: "X" }, req)).rejects.toThrow(SENDER_NAME_OTHER_ACCOUNT);
    expect(s.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "other_account" });
    expect(s.userNames.ada).toBe("Ada Lovelace");
    expect(ensures(s)).toEqual([]);
  });

  it("refuses a mailbox whose person left its account, and an unknown address is a 404", async () => {
    const { d, s } = world();
    s.memberships = s.memberships.filter((m) => m.userId !== "ada");
    await expect(setWebmailSenderName(d, "ada@a.test", { name: "X" }, req)).rejects.toThrow(SENDER_NAME_NOT_MEMBER);
    expect(await webmailSenderName(d, "nobody@a.test")).toBeNull();
    await expect(setWebmailSenderName(d, "nobody@a.test", { name: "X" }, req)).rejects.toThrow(NotFoundError);
  });
});

describe("webmailSendingNames", () => {
  it("gives the sender name and only this mailbox's masked aliases (which send with no name)", async () => {
    const { d, s } = world();
    const alias = (
      id: string,
      mailboxId: string,
      address: string,
      kind: "alias" | "masked",
      accountId = ACCOUNT_A,
    ) => ({
      id,
      accountId,
      mailboxId,
      address,
      kind,
      enabled: true,
      adminLocked: false,
      description: null,
      createdAt: new Date(0),
    });
    s.aliases.push(
      alias("1", "ada", "Shop7xk2mq9pz@a.test", "masked"),
      alias("2", "ada", "hello@a.test", "alias"),
      alias("3", "adaDesk", "desk7xk2mq9pz@a.test", "masked"),
      alias("4", "kimB", "kim7xk2mq9pz@b.test", "masked", ACCOUNT_B),
    );
    expect(await webmailSendingNames(d, "ADA@a.test")).toEqual({
      name: "Ada Lovelace",
      masked: ["shop7xk2mq9pz@a.test"],
    });
    expect(await webmailSendingNames(d, "adadesk@a.test")).toEqual({
      name: "Ada at the desk",
      masked: ["desk7xk2mq9pz@a.test"],
    });
    expect(await webmailSendingNames(d, "nameless@a.test")).toEqual({ name: null, masked: [] });
    expect(await webmailSendingNames(d, "nobody@a.test")).toBeNull();
    expect(await webmailSendingNames(d, `${"x".repeat(250)}@a.test`)).toBeNull();
  });
});

describe("a person's mailbox becoming shared", () => {
  it("keeps the name it sent as, as its own display name", async () => {
    const { d, s } = world();
    const m = s.mailboxes.find((x) => x.id === "ada");
    if (!m) throw new Error("no mailbox");
    await d.uow.run((r) => releaseMailboxOwner(d, r, fakeHasher, { ...m }, "ada"));
    expect(s.mailboxes.find((x) => x.id === "ada")).toMatchObject({ userId: null, displayName: "Ada Lovelace" });
    // A custom one stays as it was.
    const desk = s.mailboxes.find((x) => x.id === "adaDesk");
    if (!desk) throw new Error("no mailbox");
    await d.uow.run((r) => releaseMailboxOwner(d, r, fakeHasher, { ...desk }, "ada"));
    expect(s.mailboxes.find((x) => x.id === "adaDesk")).toMatchObject({ userId: null, displayName: "Ada at the desk" });
  });
});
