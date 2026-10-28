// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { MAX_PEOPLE } from "@anhourmail/shared/plans";
import { GENERATED_MAILBOX_PASSWORD } from "@anhourmail/shared/security";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  anonymous,
  deps as makeDeps,
  fakeHasher,
  fixedClock,
  req,
  user,
} from "../__tests__/helpers";
import type { Actor } from "../actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  StepUpRequiredError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import type { Mailbox } from "./entity";
import { makeMailboxUser, type MakeUserInput } from "./make-user";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const SESSION = "sess-1";
const SHARED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNED = "abababab-abab-4bab-8bab-abababababab";
const NEW = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const GONE = "efefefef-efef-4fef-8fef-efefefefefef";
const IN_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const consoleHashes: string[] = [];
const hashLogin = async (pw: string) => {
  consoleHashes.push(pw);
  return `$argon2id$console$${String(pw.length)}`;
};

function setup(plan: "plus" | "free" = "plus") {
  const clock = fixedClock("2026-10-28T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["uadmin", ACCOUNT_A, "user_admin"],
    ["dadmin", ACCOUNT_A, "domain_admin"],
    ["member", ACCOUNT_A, "member"],
    ["owner-b", ACCOUNT_B, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@example.ca`;
  }
  const mailbox = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
    id,
    accountId,
    userId,
    address,
    status: "active",
    quotaBytes: 1024,
    stalwartId: `s-${id.slice(0, 4)}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
    displayName: "Support desk",
  });
  s.mailboxes.push(
    mailbox(SHARED, ACCOUNT_A, "support@family.ca", null),
    mailbox(OWNED, ACCOUNT_A, "kid@family.ca", "member"),
    { ...mailbox(NEW, ACCOUNT_A, "new@family.ca", null), status: "provisioning", stalwartId: null },
    { ...mailbox(GONE, ACCOUNT_A, "gone@family.ca", null), status: "deleting", purgeAfter: new Date(1e13) },
    mailbox(IN_B, ACCOUNT_B, "help@other.ca", null),
  );
  for (const userId of ["owner", "uadmin", "dadmin", "member", "owner-b"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date(clock.now().getTime() + 60_000) });
  }
  return d;
}

const base: MakeUserInput = { firstName: "Sam", lastName: "Lee" };

const make = (
  d: ReturnType<typeof setup>,
  actor: Actor,
  input: MakeUserInput = {},
  {
    accountId = ACCOUNT_A,
    mailboxId = SHARED,
    sessionId = SESSION,
  }: { accountId?: string; mailboxId?: string; sessionId?: string | null } = {},
) => makeMailboxUser(d, actor, accountId, mailboxId, { ...base, ...input }, { sessionId }, req, fakeHasher, hashLogin);

describe("makeMailboxUser", () => {
  it("creates the person, Member membership, owner link and a new password in one audited step", async () => {
    const d = setup();
    const s = d.uow.state;
    const out = await make(d, owner, { profile: { department: "Help", country: "CA" } });

    expect(out.role).toBe("member");
    expect(out.password).toHaveLength(GENERATED_MAILBOX_PASSWORD.length);
    expect(out.mailbox.owner).toEqual({ userId: out.userId, email: "support@family.ca" });
    expect(s.userEmails[out.userId]).toBe("support@family.ca");
    // A blank display name keeps the mailbox's own.
    expect(s.userNames[out.userId]).toBe("Support desk");
    expect(s.memberships).toContainEqual(
      expect.objectContaining({ userId: out.userId, accountId: ACCOUNT_A, role: "member" }),
    );
    expect(s.mustChangePassword).toContain(out.userId);
    expect(s.profiles[out.userId]).toEqual({ department: "Help", country: "CA" });
    const box = s.mailboxes.find((m) => m.id === SHARED);
    expect(box).toMatchObject({ userId: out.userId, displayName: "Support desk", mustChangePassword: true });
    // The console and the mailbox both get the same new password, as hashes only.
    expect(consoleHashes.at(-1)).toBe(out.password);
    expect(s.logins.find((l) => l.userId === out.userId)?.passwordHash).toMatch(/^\$argon2id\$console\$/);
    expect(s.mailboxPasswords.find((p) => p.mailboxId === SHARED)).toMatchObject({
      pendingHash: expect.stringMatching(/^\$argon2id\$/) as unknown,
      grant: "grant-for-s-dddd",
    });
    expect(s.jobs.slice(-2).map((j) => [j.kind, j.subjectId])).toEqual([
      ["mailbox.password", SHARED],
      ["mailbox.ensure", SHARED],
    ]);

    expect(s.audit.at(-1)).toMatchObject({
      action: "mailbox.made_user",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      target: { type: "mailbox", id: SHARED, label: "support@family.ca" },
      meta: { userId: out.userId, role: "member", profileFields: ["department", "country"] },
    });
    const json = JSON.stringify(s.audit);
    expect(json).not.toContain(out.password);
    expect(json).not.toContain("Help");
  });

  it("takes a given display name and lets an Owner grant an admin role", async () => {
    const d = setup();
    const out = await make(d, owner, { displayName: "Sam Lee", role: "user_admin" });
    expect(out.role).toBe("user_admin");
    expect(d.uow.state.userNames[out.userId]).toBe("Sam Lee");
    expect(d.uow.state.mailboxes.find((m) => m.id === SHARED)?.displayName).toBe("Sam Lee");
  });

  it("lets a User Administrator grant Member only (403, audited as denied, nothing written)", async () => {
    const d = setup();
    await expect(make(d, userAdmin, { role: "owner" })).rejects.toThrow(ForbiddenError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "mailbox.made_user",
      result: "denied",
      errorCode: "forbidden",
      meta: { role: "owner" },
    });
    expect(d.uow.state.mailboxes.find((m) => m.id === SHARED)?.userId).toBeNull();
    expect(Object.values(d.uow.state.userEmails)).not.toContain("support@family.ca");
    expect((await make(d, userAdmin)).role).toBe("member");
    await expect(make(setup(), owner, { role: "emperor" })).rejects.toThrow(ValidationError);
  });

  it("needs mailbox.manage: 401 signed out, 403 for other roles, 404 for another account's ids", async () => {
    const d = setup();
    await expect(make(d, anonymous)).rejects.toThrow(UnauthenticatedError);
    await expect(make(d, member)).rejects.toThrow(ForbiddenError);
    await expect(make(d, domainAdmin)).rejects.toThrow(ForbiddenError);
    // Another account, and another account's mailbox through your own account: both 404.
    await expect(make(d, ownerB)).rejects.toThrow(NotFoundError);
    await expect(make(d, owner, {}, { mailboxId: IN_B })).rejects.toThrow(NotFoundError);
    await expect(make(d, ownerB, {}, { accountId: ACCOUNT_B, mailboxId: SHARED })).rejects.toThrow(NotFoundError);
    await expect(make(d, owner, {}, { mailboxId: "not-an-id" })).rejects.toThrow(NotFoundError);
    expect(d.uow.state.mailboxes.find((m) => m.id === IN_B)?.userId).toBeNull();
    expect(d.uow.state.audit.filter((e) => e.result === "denied").length).toBeGreaterThanOrEqual(3);
  });

  it("needs a recent step-up (403 step_up_required, audited as denied)", async () => {
    const d = setup();
    await expect(make(d, owner, {}, { sessionId: null })).rejects.toThrow(StepUpRequiredError);
    await expect(make(d, owner, {}, { sessionId: "other-session" })).rejects.toThrow(StepUpRequiredError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "step_up_required" });
    expect(d.uow.state.mailboxes.find((m) => m.id === SHARED)?.userId).toBeNull();
  });

  it("asks for the step-up before saying whether the address already has a console login", async () => {
    const d = setup();
    d.uow.state.userEmails.someone = "support@family.ca";
    await expect(make(d, owner, {}, { sessionId: null })).rejects.toThrow(StepUpRequiredError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "step_up_required" });
    await expect(make(d, owner)).rejects.toThrow(/already has a console login/);
  });

  it("finds an existing console login whatever the case of its email", async () => {
    const d = setup();
    d.uow.state.userEmails.someone = "Support@Family.CA";
    await expect(make(d, owner)).rejects.toThrow(/already has a console login/);
    expect(d.uow.state.mailboxes.find((m) => m.id === SHARED)?.userId).toBeNull();
  });

  it("refuses an owned, unready or deleting mailbox, an existing login, bad names, act-as and plans without people", async () => {
    const d = setup();
    await expect(make(d, owner, {}, { mailboxId: OWNED })).rejects.toThrow(/already belongs/);
    await expect(make(d, owner, {}, { mailboxId: NEW })).rejects.toThrow(/isn't active/);
    await expect(make(d, owner, {}, { mailboxId: GONE })).rejects.toThrow(/being deleted/);
    await expect(make(d, owner, { firstName: "" })).rejects.toThrow(ValidationError);
    await expect(make(d, owner, { displayName: "see example.com" })).rejects.toThrow(ValidationError);
    await expect(make(d, owner, { profile: { country: "Nowhere" } })).rejects.toThrow(ValidationError);
    const acting = {
      ...owner,
      actingAs: { staffUserId: "s", staffEmail: "s@x", staffRole: "support_admin" as const, reason: "r" },
    };
    await expect(make(d, acting)).rejects.toThrow(ForbiddenError);
    d.uow.state.userEmails.someone = "support@family.ca";
    await expect(make(d, owner)).rejects.toThrow(/already has a console login/);
    expect(d.uow.state.mailboxes.find((m) => m.id === SHARED)?.userId).toBeNull();

    await expect(make(setup("free"), owner)).rejects.toThrow(PlanLimitError);
    // Made once, the mailbox belongs to someone.
    const again = setup();
    await make(again, owner);
    await expect(make(again, owner)).rejects.toThrow(ConflictError);
  });

  it("stops at the people ceiling", async () => {
    const d = setup();
    for (let i = d.uow.state.memberships.filter((m) => m.accountId === ACCOUNT_A).length; i < MAX_PEOPLE; i++) {
      d.uow.state.memberships.push({ userId: `p${String(i)}`, accountId: ACCOUNT_A, role: "member" });
      d.uow.state.userEmails[`p${String(i)}`] = `p${String(i)}@example.ca`;
    }
    await expect(make(d, owner)).rejects.toThrow(PlanLimitError);
  });
});
