// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { INVITE_EMAILS_PER_DAY, MAX_PEOPLE } from "@anhourmail/shared/plans";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  actAs,
  BREACHED_PW,
  deps,
  fakeBreaches,
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
  ValidationError,
} from "../errors";
import { hashToken } from "../tokens";
import { checkPassword, loginNames, normaliseEmail } from "./entity";
import {
  acceptInvite,
  changeMemberRole,
  grantableRoles,
  INVITE_TTL_MS,
  invitePerson,
  listPeople,
  lookupInvite,
  removeMember,
  resendInvite,
  revokeInvite,
} from "./service";

const fakeHash = async (pw: string) => `hashed:${String(pw.length)}`;

/** Account A (Plus) with an Owner, a User Admin, an Auditor and a Member; account B (Plus) with its own Owner. */
function world(clock = fixedClock()) {
  const d = deps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Family A", plan: "plus" }, { id: ACCOUNT_B, name: "Family B", plan: "plus" });
  const people: [string, string, "owner" | "user_admin" | "auditor" | "member", string][] = [
    ["owner", "owner@a.test", "owner", ACCOUNT_A],
    ["admin", "admin@a.test", "user_admin", ACCOUNT_A],
    ["auditor", "auditor@a.test", "auditor", ACCOUNT_A],
    ["kid", "kid@a.test", "member", ACCOUNT_A],
    ["owner-b", "owner@b.test", "owner", ACCOUNT_B],
  ];
  for (const [id, email, role, accountId] of people) {
    s.userEmails[id] = email;
    s.memberships.push({ userId: id, accountId, role, joinedAt: new Date("2026-10-01T00:00:00Z") });
  }
  const as = (id: string): Actor => {
    const u = user({
      id,
      account: s.memberships
        .filter((m) => m.userId === id)
        .map((m) => [m.accountId, m.role] as [string, typeof m.role]),
    });
    return { ...u, email: s.userEmails[id] ?? u.email };
  };
  return { d, s, clock, as };
}

const audits = (s: ReturnType<typeof world>["s"], action: string) => s.audit.filter((e) => e.action === action);

describe("entity rules", () => {
  it("normalises emails and refuses junk", () => {
    expect(normaliseEmail("  Kid@Example.TEST ")).toBe("kid@example.test");
    for (const bad of ["", "no-at", "a@b", "a b@c.test", 42, `${"x".repeat(250)}@a.test`]) {
      expect(() => normaliseEmail(bad)).toThrow(ValidationError);
    }
  });

  it("builds login names and checks passwords", () => {
    expect(loginNames({ firstName: "  Ada ", lastName: " Lovelace " })).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      name: "Ada Lovelace",
    });
    expect(loginNames({ firstName: "Ada" }).lastName).toBeNull();
    expect(() => loginNames({ firstName: " " })).toThrow("first name");
    expect(() => loginNames({ firstName: "A\u0007" })).toThrow("control");
    // The shared name rules: text-direction controls, @ and web addresses too (invite emails show these names).
    expect(() => loginNames({ firstName: "Kim\u202e" })).toThrow("control");
    expect(() => loginNames({ firstName: "Kim", lastName: "x@y" })).toThrow("@");
    expect(() => loginNames({ firstName: "Visit evil.example" })).toThrow("web addresses");
    expect(() => checkPassword("short")).toThrow("at least 12");
    expect(() => checkPassword("x".repeat(129))).toThrow("at most 128");
    expect(checkPassword("long-enough-pass")).toBe("long-enough-pass");
  });
});

describe("listPeople", () => {
  it("shows members, invites and what the viewer may do", async () => {
    const { d, as } = world();
    await invitePerson(d, as("owner"), ACCOUNT_A, { email: "new@a.test", role: "auditor" }, req);
    const forOwner = await listPeople(d, as("owner"), ACCOUNT_A);
    expect(forOwner.members.map((m) => m.email)).toEqual([
      "admin@a.test",
      "auditor@a.test",
      "kid@a.test",
      "owner@a.test",
    ]);
    const me = forOwner.members.find((m) => m.isYou);
    expect(me).toMatchObject({ role: "owner", canChangeRole: false, canRemove: false, status: "active" });
    expect(forOwner.members.find((m) => m.email === "admin@a.test")).toMatchObject({
      canChangeRole: true,
      canRemove: true,
    });
    expect(forOwner.grantableRoles).toContain("owner");
    expect(forOwner.invites).toEqual([
      expect.objectContaining({ email: "new@a.test", role: "auditor", expired: false, canManage: true }),
    ]);
    expect(forOwner.limits).toEqual({ used: 5, max: MAX_PEOPLE, addPeople: true, planName: "Plus" });

    const forAdmin = await listPeople(d, as("admin"), ACCOUNT_A);
    expect(forAdmin.grantableRoles).toEqual(["member"]);
    expect(forAdmin.members.find((m) => m.email === "kid@a.test")).toMatchObject({
      canChangeRole: false,
      canRemove: true,
    });
    expect(forAdmin.members.find((m) => m.email === "owner@a.test")).toMatchObject({ canRemove: false });
    expect(forAdmin.invites[0]?.canManage).toBe(false);

    const forAuditor = await listPeople(d, as("auditor"), ACCOUNT_A);
    expect(forAuditor.grantableRoles).toEqual([]);
    expect(forAuditor.members.every((m) => !m.canRemove && !m.canChangeRole)).toBe(true);
  });

  it("is 403 for a Member and 404 for another account", async () => {
    const { d, as } = world();
    await expect(listPeople(d, as("kid"), ACCOUNT_A)).rejects.toThrow(ForbiddenError);
    await expect(listPeople(d, as("owner-b"), ACCOUNT_A)).rejects.toThrow(NotFoundError);
  });

  it("offers no invites on a plan for one person", async () => {
    const { d, s, as } = world();
    const a = s.accounts.find((x) => x.id === ACCOUNT_A);
    if (a) a.plan = "free";
    const out = await listPeople(d, as("owner"), ACCOUNT_A);
    expect(out.grantableRoles).toEqual([]);
    expect(out.limits.addPeople).toBe(false);
  });

  it("knows a missing account", async () => {
    const { d, s, as } = world();
    s.accounts = s.accounts.filter((x) => x.id !== ACCOUNT_A);
    await expect(listPeople(d, as("owner"), ACCOUNT_A)).rejects.toThrow(NotFoundError);
  });
});

describe("invitePerson", () => {
  it("creates a pending 7-day invite, returns the token once, stores only its hash, and audits", async () => {
    const { d, s, as, clock } = world();
    const out = await invitePerson(d, as("admin"), ACCOUNT_A, { email: " New@A.test " }, req);
    expect(out.invite).toMatchObject({ email: "new@a.test", role: "member", expired: false });
    expect(out.invite.expiresAt.getTime() - clock.now().getTime()).toBe(INVITE_TTL_MS);
    expect(out.accountName).toBe("Family A");
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.invites[0]?.tokenHash).toBe(hashToken(out.token));
    const [entry] = audits(s, "account.invite_sent");
    expect(entry).toMatchObject({ result: "success", target: { label: "new@a.test" }, meta: { role: "member" } });
    expect(JSON.stringify(s.audit)).not.toContain(out.token);
  });

  it("lets only an Owner invite with a role other than Member (403, audited as denied)", async () => {
    const { d, s, as } = world();
    await expect(
      invitePerson(d, as("admin"), ACCOUNT_A, { email: "x@a.test", role: "user_admin" }, req),
    ).rejects.toThrow(ForbiddenError);
    expect(audits(s, "account.invite_sent")).toEqual([
      expect.objectContaining({ result: "denied", errorCode: "forbidden" }),
    ]);
    expect(s.invites).toEqual([]);
    const ok = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "x@a.test", role: "owner" }, req);
    expect(ok.invite.role).toBe("owner");
  });

  it("is 403 for Members and Auditors, 404 across accounts", async () => {
    const { d, s, as } = world();
    await expect(invitePerson(d, as("kid"), ACCOUNT_A, { email: "x@a.test" }, req)).rejects.toThrow(ForbiddenError);
    await expect(invitePerson(d, as("auditor"), ACCOUNT_A, { email: "x@a.test" }, req)).rejects.toThrow(ForbiddenError);
    await expect(invitePerson(d, as("owner-b"), ACCOUNT_A, { email: "x@a.test" }, req)).rejects.toThrow(NotFoundError);
    expect(s.invites).toEqual([]);
  });

  it("refuses bad input, existing members, duplicate invites and full or one-person accounts", async () => {
    const { d, s, as } = world();
    const owner = as("owner");
    await expect(invitePerson(d, owner, ACCOUNT_A, { email: "x@a.test", role: "boss" }, req)).rejects.toThrow(
      "Choose a role",
    );
    await expect(invitePerson(d, owner, ACCOUNT_A, { email: "nope" }, req)).rejects.toThrow(ValidationError);
    await expect(invitePerson(d, owner, ACCOUNT_A, { email: "KID@a.test" }, req)).rejects.toThrow(
      "already in this account",
    );
    await invitePerson(d, owner, ACCOUNT_A, { email: "x@a.test", role: "" }, req);
    await expect(invitePerson(d, owner, ACCOUNT_A, { email: "x@a.test" }, req)).rejects.toThrow("Resend it instead");
    for (let i = s.memberships.filter((m) => m.accountId === ACCOUNT_A).length + 1; i < MAX_PEOPLE; i++) {
      await invitePerson(d, owner, ACCOUNT_A, { email: `p${String(i)}@a.test` }, req);
    }
    await expect(invitePerson(d, owner, ACCOUNT_A, { email: "last@a.test" }, req)).rejects.toThrow(PlanLimitError);

    const a = s.accounts.find((x) => x.id === ACCOUNT_A);
    if (a) a.plan = "free";
    await expect(invitePerson(d, owner, ACCOUNT_A, { email: "y@a.test" }, req)).rejects.toThrow("one person");
  });

  it("doesn't count expired invites against the ceiling", async () => {
    const { d, s, as, clock } = world();
    for (let i = 5; i < MAX_PEOPLE + 1; i++)
      await invitePerson(d, as("owner"), ACCOUNT_A, { email: `p${String(i)}@a.test` }, req);
    clock.set(new Date(clock.now().getTime() + INVITE_TTL_MS + 1));
    await invitePerson(d, as("owner"), ACCOUNT_A, { email: "after@a.test" }, req);
    expect(s.invites.filter((i) => i.status === "pending")).toHaveLength(MAX_PEOPLE - 3);
  });
});

describe("resendInvite and revokeInvite", () => {
  it("resends with a new link after a minute; the old link stops working", async () => {
    const { d, s, as, clock } = world();
    const first = await invitePerson(d, as("admin"), ACCOUNT_A, { email: "new@a.test" }, req);
    await expect(resendInvite(d, as("admin"), ACCOUNT_A, first.invite.id, req)).rejects.toThrow("Wait a minute");
    clock.set(new Date(clock.now().getTime() + 61_000));
    const again = await resendInvite(d, as("admin"), ACCOUNT_A, first.invite.id, req);
    expect(again.token).not.toBe(first.token);
    expect(await lookupInvite(d, first.token)).toBeNull();
    expect(await lookupInvite(d, again.token)).toMatchObject({ email: "new@a.test", accountName: "Family A" });
    expect(audits(s, "account.invite_resent")).toEqual([
      expect.objectContaining({ result: "failed", errorCode: "conflict" }),
      expect.objectContaining({ result: "success", meta: { role: "member", wasExpired: false } }),
    ]);
  });

  it("re-checks the ceiling when an expired invite is resent", async () => {
    const { d, as, clock } = world();
    const old = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "old@a.test" }, req);
    clock.set(new Date(clock.now().getTime() + INVITE_TTL_MS + 1));
    for (let i = 4; i < MAX_PEOPLE; i++)
      await invitePerson(d, as("owner"), ACCOUNT_A, { email: `p${String(i)}@a.test` }, req);
    await expect(resendInvite(d, as("owner"), ACCOUNT_A, old.invite.id, req)).rejects.toThrow(PlanLimitError);
  });

  it("revokes; a revoked invite can't be resent, revoked again or used", async () => {
    const { d, s, as } = world();
    const sent = await invitePerson(d, as("admin"), ACCOUNT_A, { email: "new@a.test" }, req);
    expect(await revokeInvite(d, as("admin"), ACCOUNT_A, sent.invite.id, req)).toEqual({ id: sent.invite.id });
    await expect(revokeInvite(d, as("admin"), ACCOUNT_A, sent.invite.id, req)).rejects.toThrow(ConflictError);
    await expect(resendInvite(d, as("admin"), ACCOUNT_A, sent.invite.id, req)).rejects.toThrow(ConflictError);
    expect(await lookupInvite(d, sent.token)).toBeNull();
    expect(audits(s, "account.invite_revoked")[0]).toMatchObject({
      result: "success",
      target: { label: "new@a.test" },
    });
  });

  it("a User Admin can't resend or revoke an invite for an admin role (403, audited)", async () => {
    const { d, s, as, clock } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "boss@a.test", role: "owner" }, req);
    clock.set(new Date(clock.now().getTime() + 61_000));
    await expect(resendInvite(d, as("admin"), ACCOUNT_A, sent.invite.id, req)).rejects.toThrow(ForbiddenError);
    await expect(revokeInvite(d, as("admin"), ACCOUNT_A, sent.invite.id, req)).rejects.toThrow(ForbiddenError);
    expect(audits(s, "account.invite_revoked")[0]?.result).toBe("denied");
    expect(audits(s, "account.invite_resent")[0]?.result).toBe("denied");
  });

  it("404s on unknown, malformed and other accounts' invite ids", async () => {
    const { d, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "new@a.test" }, req);
    await expect(revokeInvite(d, as("owner-b"), ACCOUNT_B, sent.invite.id, req)).rejects.toThrow(NotFoundError);
    await expect(revokeInvite(d, as("owner"), ACCOUNT_A, "not-an-id", req)).rejects.toThrow(NotFoundError);
    await expect(resendInvite(d, as("owner-b"), ACCOUNT_A, sent.invite.id, req)).rejects.toThrow(NotFoundError);
  });
});

describe("changeMemberRole", () => {
  it("an Owner changes someone's role, audited with before and after", async () => {
    const { d, s, as } = world();
    const out = await changeMemberRole(d, as("owner"), ACCOUNT_A, "kid", { role: "user_admin" }, req);
    expect(out).toMatchObject({ userId: "kid", role: "user_admin" });
    expect(s.memberships.find((m) => m.userId === "kid")?.role).toBe("user_admin");
    expect(audits(s, "account.role_changed")[0]).toMatchObject({
      result: "success",
      target: { id: "kid", label: "kid@a.test" },
      meta: { previousRole: "member", newRole: "user_admin" },
    });
  });

  it("is Owner-only: a User Admin gets 403 (audited), another account 404", async () => {
    const { d, s, as } = world();
    await expect(changeMemberRole(d, as("admin"), ACCOUNT_A, "kid", { role: "user_admin" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    expect(audits(s, "account.role_changed")[0]).toMatchObject({ result: "denied", scope: `account:${ACCOUNT_A}` });
    await expect(changeMemberRole(d, as("owner-b"), ACCOUNT_A, "kid", { role: "member" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(changeMemberRole(d, as("owner"), ACCOUNT_A, "owner-b", { role: "member" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(changeMemberRole(d, as("owner"), ACCOUNT_A, "x".repeat(300), { role: "member" }, req)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("refuses your own role, a no-op, junk roles and demoting the last Owner", async () => {
    const { d, s, as } = world();
    await expect(changeMemberRole(d, as("owner"), ACCOUNT_A, "owner", { role: "member" }, req)).rejects.toThrow(
      "your own role",
    );
    await expect(changeMemberRole(d, as("owner"), ACCOUNT_A, "kid", { role: "member" }, req)).rejects.toThrow(
      "already have",
    );
    await expect(changeMemberRole(d, as("owner"), ACCOUNT_A, "kid", { role: "god" }, req)).rejects.toThrow(
      ValidationError,
    );
    // Two owners: one may demote the other.
    await changeMemberRole(d, as("owner"), ACCOUNT_A, "admin", { role: "owner" }, req);
    await changeMemberRole(d, as("admin"), ACCOUNT_A, "owner", { role: "member" }, req);
    expect(s.memberships.find((m) => m.userId === "owner")?.role).toBe("member");
    // The last Owner is never demoted, even by a session that still thinks it's an Owner (a race).
    s.memberships.push({ userId: "ghost", accountId: ACCOUNT_A, role: "member" });
    const ghost = user({ id: "ghost", account: [[ACCOUNT_A, "owner"]] });
    await expect(changeMemberRole(d, ghost, ACCOUNT_A, "admin", { role: "member" }, req)).rejects.toThrow(
      "at least one owner",
    );
  });
});

describe("changeMemberRole and delegation grants (guard rail 8 survives a promotion)", () => {
  const KID_BOX = "55555555-aaaa-4aaa-8aaa-555555555555";
  const AUDITOR_BOX = "66666666-aaaa-4aaa-8aaa-666666666666";
  function promoWorld() {
    const w = world();
    for (const [id, address, userId] of [
      [KID_BOX, "kid@family.test", "kid"],
      [AUDITOR_BOX, "auditor@family.test", "auditor"],
    ] as const) {
      w.s.mailboxes.push({
        id,
        accountId: ACCOUNT_A,
        userId,
        address,
        status: "active",
        quotaBytes: 1,
        stalwartId: "s",
        lastError: null,
        purgeAfter: null,
        createdAt: new Date(0),
      });
    }
    const grant = (mailboxId: string, granteeUserId: string, grantedBy: string | null) =>
      w.s.delegations.push({
        id: `${mailboxId}-${granteeUserId}`,
        accountId: ACCOUNT_A,
        mailboxId,
        granteeUserId,
        right: "full_access",
        grantedBy,
        createdAt: new Date(0),
      });
    return { ...w, grant };
  }

  it("a Member made an admin keeps only the grants an Owner made on their mailboxes, each drop audited", async () => {
    const { d, s, as, grant } = promoWorld();
    grant(KID_BOX, "admin", "admin"); // a User Admin's grant on a Member's mailbox
    grant(KID_BOX, "auditor", "owner"); // an Owner's
    grant(KID_BOX, "owner", null); // written by the system
    await changeMemberRole(d, as("owner"), ACCOUNT_A, "kid", { role: "user_admin" }, req);
    expect(s.delegations.map((g) => g.granteeUserId)).toEqual(["auditor"]);
    expect(
      audits(s, "delegation.revoked").map((e) => [e.target.id, e.meta.granteeUserId, e.meta.reason, e.requestId]),
    ).toEqual([
      [KID_BOX, "admin", "role_changed", req.requestId],
      [KID_BOX, "owner", "role_changed", req.requestId],
    ]);
    expect(audits(s, "account.role_changed")[0]?.meta).toMatchObject({ grantsRevoked: 2 });
  });

  it("anyone made an Owner too; a move between admin roles or down keeps the grants", async () => {
    const { d, s, as, grant } = promoWorld();
    grant(AUDITOR_BOX, "kid", "admin");
    await changeMemberRole(d, as("owner"), ACCOUNT_A, "auditor", { role: "domain_admin" }, req);
    await changeMemberRole(d, as("owner"), ACCOUNT_A, "auditor", { role: "member" }, req);
    expect(s.delegations).toHaveLength(1);
    await changeMemberRole(d, as("owner"), ACCOUNT_A, "auditor", { role: "owner" }, req);
    expect(s.delegations).toEqual([]);
    expect(audits(s, "delegation.revoked").map((e) => e.meta.reason)).toEqual(["role_changed"]);
  });
});

describe("removeMember", () => {
  it("a User Admin removes a Member; their mailboxes stay, person-less, with sign-in off", async () => {
    const { d, s, as } = world();
    const base = {
      accountId: ACCOUNT_A,
      displayName: null,
      quotaBytes: 1,
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(),
    };
    s.mailboxes.push(
      // On the mail server: a new password is queued for the worker, with the proxy's grant.
      {
        ...base,
        id: "11111111-aaaa-4aaa-8aaa-111111111111",
        userId: "kid",
        address: "kid@family.test",
        status: "active",
        stalwartId: "s1",
        mustChangePassword: true,
      },
      // Suspended: the job applies it, and a resume waits for it.
      {
        ...base,
        id: "22222222-aaaa-4aaa-8aaa-222222222222",
        userId: "kid",
        address: "kid2@family.test",
        status: "suspended",
        stalwartId: "s2",
      },
      // Being deleted: the new password waits for a restore.
      {
        ...base,
        id: "33333333-aaaa-4aaa-8aaa-333333333333",
        userId: "kid",
        address: "kid3@family.test",
        status: "deleting",
        stalwartId: "s3",
      },
      // Someone else's: untouched.
      {
        ...base,
        id: "44444444-aaaa-4aaa-8aaa-444444444444",
        userId: "admin",
        address: "admin@family.test",
        status: "active",
        stalwartId: "s4",
      },
    );
    expect(await removeMember(d, as("admin"), ACCOUNT_A, "kid", req, fakeHasher)).toEqual({
      userId: "kid",
      delegated: 0,
    });
    expect(s.memberships.some((m) => m.userId === "kid")).toBe(false);
    expect(s.mailboxes).toHaveLength(4);
    expect(s.mailboxes.filter((m) => m.userId === "kid")).toEqual([]);
    expect(s.mailboxes.find((m) => m.address === "admin@family.test")?.userId).toBe("admin");
    expect(s.mailboxes.find((m) => m.address === "kid@family.test")?.mustChangePassword).toBe(false);
    const pending = Object.fromEntries(s.mailboxPasswords.map((p) => [p.mailboxId, p]));
    expect(Object.keys(pending).sort()).toEqual([
      "11111111-aaaa-4aaa-8aaa-111111111111",
      "22222222-aaaa-4aaa-8aaa-222222222222",
      "33333333-aaaa-4aaa-8aaa-333333333333",
    ]);
    expect(pending["11111111-aaaa-4aaa-8aaa-111111111111"]).toMatchObject({ grant: "grant-for-s1" });
    expect(pending["22222222-aaaa-4aaa-8aaa-222222222222"]).toMatchObject({ grant: "grant-for-s2" });
    expect(pending["11111111-aaaa-4aaa-8aaa-111111111111"]?.pendingHash).toMatch(/^\$argon2id\$/);
    expect(s.jobs.filter((j) => j.kind === "mailbox.password").map((j) => j.subjectId)).toEqual([
      "11111111-aaaa-4aaa-8aaa-111111111111",
      "22222222-aaaa-4aaa-8aaa-222222222222",
    ]);
    const entry = audits(s, "account.member_removed")[0];
    expect(entry).toMatchObject({
      result: "success",
      meta: { role: "member", mailboxesUnassigned: 3, mailboxesSignedOut: 3, appPasswordsRevoked: 0 },
    });
    // The generated password is never in the audit entry.
    expect(JSON.stringify(entry)).not.toContain("argon2");
  });

  it("waits while one of their mailboxes is still being created (it could get the password they were given)", async () => {
    const { d, s, as } = world();
    s.mailboxes.push({
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      accountId: ACCOUNT_A,
      userId: "kid",
      address: "kid@family.test",
      status: "provisioning",
      quotaBytes: 1,
      stalwartId: null,
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(),
    });
    await expect(removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher)).rejects.toThrow("still being set up");
    expect(s.memberships.some((m) => m.userId === "kid")).toBe(true);
    expect(s.mailboxes[0]?.userId).toBe("kid");
    expect(s.mailboxPasswords).toEqual([]);
  });

  it("a denied removal changes no mailbox", async () => {
    const { d, s, as } = world();
    s.mailboxes.push({
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      accountId: ACCOUNT_A,
      userId: "owner",
      address: "owner@family.test",
      status: "active",
      quotaBytes: 1,
      stalwartId: "s1",
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(),
    });
    await expect(removeMember(d, as("admin"), ACCOUNT_A, "owner", req, fakeHasher)).rejects.toThrow(ForbiddenError);
    expect(s.mailboxes[0]?.userId).toBe("owner");
    expect(s.mailboxPasswords).toEqual([]);
    expect(s.jobs).toEqual([]);
  });

  it("only an Owner removes an Owner or an admin (403 audited); never yourself; never the last Owner", async () => {
    const { d, s, as } = world();
    await expect(removeMember(d, as("admin"), ACCOUNT_A, "owner", req, fakeHasher)).rejects.toThrow(ForbiddenError);
    await expect(removeMember(d, as("admin"), ACCOUNT_A, "auditor", req, fakeHasher)).rejects.toThrow(ForbiddenError);
    expect(audits(s, "account.member_removed").map((e) => e.result)).toEqual(["denied", "denied"]);
    await expect(removeMember(d, as("admin"), ACCOUNT_A, "admin", req, fakeHasher)).rejects.toThrow(ForbiddenError);
    await expect(removeMember(d, as("owner"), ACCOUNT_A, "owner", req, fakeHasher)).rejects.toThrow("remove yourself");
    await removeMember(d, as("owner"), ACCOUNT_A, "admin", req, fakeHasher);
    // The last Owner is never removed, even by a session that still thinks it's an Owner (a race).
    s.memberships.push({ userId: "ghost", accountId: ACCOUNT_A, role: "member" });
    const ghost = user({ id: "ghost", account: [[ACCOUNT_A, "owner"]] });
    await expect(removeMember(d, ghost, ACCOUNT_A, "owner", req, fakeHasher)).rejects.toThrow("at least one owner");
  });

  it("is 403 for Members, 404 across accounts and for strangers", async () => {
    const { d, as } = world();
    await expect(removeMember(d, as("kid"), ACCOUNT_A, "kid", req, fakeHasher)).rejects.toThrow(ForbiddenError);
    await expect(removeMember(d, as("owner-b"), ACCOUNT_A, "kid", req, fakeHasher)).rejects.toThrow(NotFoundError);
    await expect(removeMember(d, as("owner"), ACCOUNT_A, "owner-b", req, fakeHasher)).rejects.toThrow(NotFoundError);
  });
});

describe("removeMember and delegation (ADR-0026)", () => {
  const KID_BOX = "11111111-aaaa-4aaa-8aaa-111111111111";
  const KID_OLD = "22222222-aaaa-4aaa-8aaa-222222222222";
  const DESK = "33333333-aaaa-4aaa-8aaa-333333333333";
  const OWNER_BOX = "44444444-aaaa-4aaa-8aaa-444444444444";
  const session = { sessionId: "sess-1" };

  function leaverWorld() {
    const w = world();
    const box = (id: string, address: string, userId: string | null, status: "active" | "deleting" = "active") => ({
      id,
      accountId: ACCOUNT_A,
      userId,
      address,
      status,
      quotaBytes: 1,
      stalwartId: `s-${id.slice(0, 2)}`,
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(),
    });
    w.s.mailboxes.push(
      box(KID_BOX, "kid@family.test", "kid"),
      box(KID_OLD, "kid-old@family.test", "kid", "deleting"),
      box(DESK, "desk@family.test", null),
      box(OWNER_BOX, "owner@family.test", "owner"),
    );
    for (const id of ["owner", "admin"]) {
      w.s.stepUps.push({ userId: id, sessionId: "sess-1", expiresAt: new Date("2099-01-01T00:00:00Z") });
    }
    const grant = (mailboxId: string, granteeUserId: string, right: "full_access" | "send_as") =>
      w.s.delegations.push({
        id: `${mailboxId}-${granteeUserId}-${right}`,
        accountId: ACCOUNT_A,
        mailboxId,
        granteeUserId,
        right,
        grantedBy: "owner",
        createdAt: new Date(0),
      });
    return { ...w, grant };
  }

  it("revokes the grants the leaver held, keeps others' grants on their mailboxes, one entry each", async () => {
    const { d, s, as, grant } = leaverWorld();
    grant(DESK, "kid", "full_access");
    grant(OWNER_BOX, "kid", "send_as");
    grant(KID_BOX, "admin", "full_access");
    await removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher);
    expect(s.delegations.map((g) => [g.mailboxId, g.granteeUserId])).toEqual([[KID_BOX, "admin"]]);
    const revoked = audits(s, "delegation.revoked");
    expect(revoked.map((e) => [e.target.label, e.meta.right, e.meta.reason, e.meta.grantee])).toEqual([
      ["desk@family.test", "full_access", "member_removed", "k***@a.test"],
      ["owner@family.test", "send_as", "member_removed", "k***@a.test"],
    ]);
    expect(audits(s, "account.member_removed")[0]?.meta).toMatchObject({ grantsRevoked: 2, delegated: 0 });
  });

  it("gives one person staying full access (and send as) to each mailbox the leaver had, not one being deleted", async () => {
    const { d, s, as } = leaverWorld();
    const out = await removeMember(d, as("admin"), ACCOUNT_A, "kid", req, fakeHasher, {
      delegateTo: { userId: "auditor", sendAs: true },
      session,
    });
    expect(out).toEqual({ userId: "kid", delegated: 2 });
    expect(s.mailboxes.find((m) => m.id === KID_BOX)?.userId).toBeNull();
    expect(s.delegations.map((g) => [g.mailboxId, g.granteeUserId, g.right, g.grantedBy])).toEqual([
      [KID_BOX, "auditor", "full_access", "admin"],
      [KID_BOX, "auditor", "send_as", "admin"],
    ]);
    // The new password for the released mailbox is still queued, as without a hand-over.
    expect(s.jobs.filter((j) => j.kind === "mailbox.password").map((j) => j.subjectId)).toEqual([KID_BOX]);
    const granted = audits(s, "delegation.granted");
    expect(granted.map((e) => [e.result, e.target.id, e.meta.right, e.meta.reason])).toEqual([
      ["success", KID_BOX, "full_access", "member_removed"],
      ["success", KID_BOX, "send_as", "member_removed"],
    ]);
    expect(audits(s, "account.member_removed")[0]?.meta).toMatchObject({ delegated: 2, mailboxesSignedOut: 2 });
  });

  it("without send as, only full access", async () => {
    const { d, s, as } = leaverWorld();
    await removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher, { delegateTo: { userId: "admin" }, session });
    expect(s.delegations.map((g) => g.right)).toEqual(["full_access"]);
  });

  it("refuses the hand-over without delegation rights, a step-up, a plan with it, or a person staying (nothing removed)", async () => {
    const { d, s, as } = leaverWorld();
    const kidStays = () => {
      expect(s.memberships.some((m) => m.userId === "kid")).toBe(true);
    };
    // No console session to check a step-up against, then a stale one.
    await expect(
      removeMember(d, as("admin"), ACCOUNT_A, "kid", req, fakeHasher, { delegateTo: { userId: "admin" } }),
    ).rejects.toThrow(StepUpRequiredError);
    kidStays();
    await expect(
      removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher, {
        delegateTo: { userId: "admin" },
        session: { sessionId: "stale" },
      }),
    ).rejects.toThrow(StepUpRequiredError);
    await expect(
      removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher, { delegateTo: { userId: "kid" }, session }),
    ).rejects.toThrow("someone who is staying");
    await expect(
      removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher, { delegateTo: { userId: "owner-b" }, session }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher, { delegateTo: "admin", session }),
    ).rejects.toThrow(ValidationError);
    kidStays();
    expect(s.delegations).toEqual([]);
    expect(audits(s, "account.member_removed").map((e) => [e.result, e.errorCode])).toEqual([
      ["denied", "step_up_required"],
      ["denied", "step_up_required"],
      ["failed", "conflict"],
      ["failed", "not_found"],
      ["failed", "bad_request"],
    ]);
    s.accounts[0] = { id: ACCOUNT_A, name: "Family A", plan: "free" };
    await expect(
      removeMember(d, as("owner"), ACCOUNT_A, "kid", req, fakeHasher, { delegateTo: { userId: "admin" }, session }),
    ).rejects.toThrow(PlanLimitError);
    kidStays();
  });

  it("refuses the hand-over (403, nothing removed) when the actor can't delegate; the plain removal still works", async () => {
    const { d, s, as } = leaverWorld();
    // Only reachable defensively today: every role that removes people also delegates, so use a session that is
    // acting as someone (which never delegates) while still holding member.manage.
    const acting = { ...as("admin"), actingAs: actAs(ACCOUNT_A) };
    await expect(
      removeMember(d, acting, ACCOUNT_A, "kid", req, fakeHasher, { delegateTo: { userId: "owner" }, session }),
    ).rejects.toThrow("can't give access to their mailboxes");
    expect(s.memberships.some((m) => m.userId === "kid")).toBe(true);
    expect(audits(s, "account.member_removed")[0]).toMatchObject({ result: "denied", errorCode: "forbidden" });
    expect(await removeMember(d, as("admin"), ACCOUNT_A, "kid", req, fakeHasher)).toEqual({
      userId: "kid",
      delegated: 0,
    });
  });
});

describe("lookupInvite and acceptInvite", () => {
  it("looks up a link without auditing; junk and unknown tokens are null; expired is flagged", async () => {
    const { d, s, as, clock } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "new@a.test", role: "auditor" }, req);
    const before = s.audit.length;
    expect(await lookupInvite(d, sent.token)).toEqual({
      accountName: "Family A",
      role: "auditor",
      email: "new@a.test",
      expired: false,
      hasLogin: false,
    });
    expect(s.audit).toHaveLength(before);
    expect(await lookupInvite(d, "short")).toBeNull();
    expect(await lookupInvite(d, "A".repeat(43))).toBeNull();
    clock.set(new Date(clock.now().getTime() + INVITE_TTL_MS));
    expect((await lookupInvite(d, sent.token))?.expired).toBe(true);
    s.accounts = s.accounts.filter((a) => a.id !== ACCOUNT_A);
    expect(await lookupInvite(d, sent.token)).toBeNull();
  });

  it("signed out: creates a login for the invited address, joins with the role, and the link is used up", async () => {
    const { d, s, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "new@a.test", role: "auditor" }, req);
    const out = await acceptInvite(
      d,
      { kind: "anonymous" },
      { token: sent.token, firstName: "New", lastName: "Person", password: "correct horse battery" },
      req,
      fakeHash,
    );
    expect(out).toEqual({ accountId: ACCOUNT_A, email: "new@a.test", newLogin: true });
    const login = s.logins[0];
    expect(login?.passwordHash).toBe("hashed:21");
    expect(s.userNames[login?.userId ?? ""]).toBe("New Person");
    expect(s.memberships).toContainEqual(
      expect.objectContaining({ userId: login?.userId, accountId: ACCOUNT_A, role: "auditor" }),
    );
    const [entry] = audits(s, "account.invite_accepted");
    expect(entry).toMatchObject({
      result: "success",
      actor: { type: "system" },
      meta: { role: "auditor", newLogin: true },
    });
    expect(JSON.stringify(entry)).not.toContain("correct horse");
    await expect(
      acceptInvite(
        d,
        { kind: "anonymous" },
        { token: sent.token, firstName: "X", password: "another long one" },
        req,
        fakeHash,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("signed out: a breached password is refused before anything is written; the link still works", async () => {
    const { d, s, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "new@a.test", role: "member" }, req);
    const breaches = fakeBreaches([BREACHED_PW]);
    const accept = (password: string) =>
      acceptInvite(
        d,
        { kind: "anonymous" },
        { token: sent.token, firstName: "New", password },
        req,
        fakeHash,
        breaches,
      );
    await expect(accept(BREACHED_PW)).rejects.toMatchObject({ code: "password_breached" });
    expect(s.logins).toHaveLength(0);
    expect(JSON.stringify(s.audit)).not.toContain(BREACHED_PW);
    await expect(accept("correct horse battery")).resolves.toMatchObject({ newLogin: true });
  });

  it("signed out with an existing login for the address: sign in instead (409)", async () => {
    const { d, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "owner@b.test" }, req);
    expect((await lookupInvite(d, sent.token))?.hasLogin).toBe(true);
    await expect(
      acceptInvite(
        d,
        { kind: "anonymous" },
        { token: sent.token, firstName: "B", password: "long enough pass" },
        req,
        fakeHash,
      ),
    ).rejects.toThrow("Sign in");
  });

  it("signed in as the invited address joins; another address is refused (403, audited)", async () => {
    const { d, s, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "owner@b.test", role: "member" }, req);
    await expect(acceptInvite(d, as("kid"), { token: sent.token }, req, fakeHash)).rejects.toThrow("different address");
    expect(audits(s, "account.invite_accepted")[0]).toMatchObject({ result: "denied" });
    const out = await acceptInvite(d, as("owner-b"), { token: sent.token }, req, fakeHash);
    expect(out).toEqual({ accountId: ACCOUNT_A, email: "owner@b.test", newLogin: false });
    expect(s.memberships).toContainEqual(
      expect.objectContaining({ userId: "owner-b", accountId: ACCOUNT_A, role: "member" }),
    );
    expect(s.logins).toEqual([]);
  });

  it("refuses someone already in the account, bad tokens, expired links and weak input", async () => {
    const { d, s, as, clock } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "late@a.test" }, req);
    await expect(acceptInvite(d, { kind: "anonymous" }, {}, req, fakeHash)).rejects.toThrow(ValidationError);
    await expect(
      acceptInvite(d, { kind: "anonymous" }, { token: sent.token, firstName: "L", password: "short" }, req, fakeHash),
    ).rejects.toThrow("at least 12");
    await expect(
      acceptInvite(d, { kind: "anonymous" }, { token: sent.token, password: "long enough pass" }, req, fakeHash),
    ).rejects.toThrow("first name");
    // Already a member: the address belongs to someone in the account.
    s.userEmails.kid = "late@a.test";
    await expect(acceptInvite(d, as("kid"), { token: sent.token }, req, fakeHash)).rejects.toThrow(
      "already in this account",
    );
    clock.set(new Date(clock.now().getTime() + INVITE_TTL_MS));
    await expect(acceptInvite(d, as("kid"), { token: sent.token }, req, fakeHash)).rejects.toThrow(NotFoundError);
  });

  it("a link used between the look-up and the unit of work is refused, and nothing is created", async () => {
    const { d, s, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "race@a.test" }, req);
    const useItMeanwhile = async (p: string) => {
      const inv = s.invites[0];
      if (inv) inv.status = "accepted";
      return p;
    };
    await expect(
      acceptInvite(
        d,
        { kind: "anonymous" },
        { token: sent.token, firstName: "R", password: "long enough pass" },
        req,
        useItMeanwhile,
      ),
    ).rejects.toThrow(NotFoundError);
    expect(s.logins).toEqual([]);
    expect(s.memberships.filter((m) => m.accountId === ACCOUNT_A)).toHaveLength(4);
  });

  it("the conditional accept refuses a link used inside the same race window", async () => {
    const { d, s, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "owner@b.test" }, req);
    const original = d.uow.run.bind(d.uow);
    let calls = 0;
    d.uow.run = (fn) =>
      original(async (r) => {
        calls += 1;
        // Second unit of work = the accept: someone else used the link just before it.
        if (calls === 2) {
          const inv = s.invites[0];
          if (inv) inv.status = "accepted";
        }
        return fn(r);
      });
    await expect(acceptInvite(d, as("owner-b"), { token: sent.token }, req, fakeHash)).rejects.toThrow(NotFoundError);
  });
});

describe("security review fixes", () => {
  it("caps invite emails per account per day, counting resends and revoked invites (invite → revoke loops)", async () => {
    const { d, s, as, clock } = world();
    for (let i = 0; i < INVITE_EMAILS_PER_DAY; i++) {
      const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: `loop${String(i)}@a.test` }, req);
      await revokeInvite(d, as("owner"), ACCOUNT_A, sent.invite.id, req);
    }
    expect(s.inviteSends.filter((x) => x.accountId === ACCOUNT_A)).toHaveLength(INVITE_EMAILS_PER_DAY);
    await expect(invitePerson(d, as("owner"), ACCOUNT_A, { email: "one-more@a.test" }, req)).rejects.toThrow(
      "the most it can",
    );
    expect(s.invites.some((i) => i.email === "one-more@a.test")).toBe(false);
    // Another account is unaffected; a day later this one can send again.
    s.memberships.push({ userId: "owner-b", accountId: ACCOUNT_B, role: "owner" });
    await invitePerson(d, as("owner-b"), ACCOUNT_B, { email: "b-guest@b.test" }, req);
    clock.set(new Date(clock.now().getTime() + 24 * 3600_000 + 1));
    await invitePerson(d, as("owner"), ACCOUNT_A, { email: "next-day@a.test" }, req);
  });

  it("counts resends against the daily cap", async () => {
    const { d, s, as, clock } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "again@a.test" }, req);
    for (let i = 1; i < INVITE_EMAILS_PER_DAY; i++) {
      clock.set(new Date(clock.now().getTime() + 61_000));
      await resendInvite(d, as("owner"), ACCOUNT_A, sent.invite.id, req);
    }
    clock.set(new Date(clock.now().getTime() + 61_000));
    await expect(resendInvite(d, as("owner"), ACCOUNT_A, sent.invite.id, req)).rejects.toThrow(ConflictError);
    expect(s.inviteSends).toHaveLength(INVITE_EMAILS_PER_DAY);
  });

  it("a wrong-address accept is logged in the platform scope with the invite masked, not in the account's log", async () => {
    const { d, s, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "owner@b.test" }, req);
    await expect(acceptInvite(d, as("kid"), { token: sent.token }, req, fakeHash)).rejects.toThrow(ForbiddenError);
    const denied = audits(s, "account.invite_accepted");
    expect(denied).toEqual([
      expect.objectContaining({
        scope: "platform",
        result: "denied",
        target: expect.objectContaining({ label: "o***@b.test" }) as unknown,
      }),
    ]);
    expect(s.audit.filter((e) => e.scope === `account:${ACCOUNT_A}` && e.action === "account.invite_accepted")).toEqual(
      [],
    );
  });

  it("re-checks the plan and the people ceiling when an invite is accepted", async () => {
    const { d, as } = world();
    const sent = await invitePerson(d, as("owner"), ACCOUNT_A, { email: "late@a.test" }, req);
    const setPlan = (plan: "free" | "plus") => {
      // A failed unit of work restores a snapshot, so look the account up again each time.
      const a = d.uow.state.accounts.find((x) => x.id === ACCOUNT_A);
      if (a) a.plan = plan;
    };
    setPlan("free");
    const body = { token: sent.token, firstName: "L", password: "long enough pass" };
    await expect(acceptInvite(d, { kind: "anonymous" }, body, req, fakeHash)).rejects.toThrow("no longer includes");
    setPlan("plus");
    // Fill the account behind the invite's back (e.g. people added while it was pending).
    for (let i = 0; i < MAX_PEOPLE - 4; i++) {
      d.uow.state.userEmails[`extra${String(i)}`] = `extra${String(i)}@a.test`;
      d.uow.state.memberships.push({ userId: `extra${String(i)}`, accountId: ACCOUNT_A, role: "member" });
    }
    await expect(acceptInvite(d, { kind: "anonymous" }, body, req, fakeHash)).rejects.toThrow("as many people");
    expect(d.uow.state.logins).toEqual([]);
    d.uow.state.memberships.pop();
    await expect(acceptInvite(d, { kind: "anonymous" }, body, req, fakeHash)).resolves.toMatchObject({
      newLogin: true,
    });
  });
});

describe("grantableRoles", () => {
  it("follows the matrix", () => {
    expect(grantableRoles(user({ account: [[ACCOUNT_A, "owner"]] }), ACCOUNT_A)).toHaveLength(6);
    expect(grantableRoles(user({ account: [[ACCOUNT_A, "user_admin"]] }), ACCOUNT_A)).toEqual(["member"]);
    expect(grantableRoles(user({ account: [[ACCOUNT_A, "domain_admin"]] }), ACCOUNT_A)).toEqual([]);
    expect(grantableRoles(user({ account: [[ACCOUNT_A, "owner"]] }), ACCOUNT_B)).toEqual([]);
  });
});
