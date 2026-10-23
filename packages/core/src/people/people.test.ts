// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { INVITE_EMAILS_PER_DAY, MAX_PEOPLE } from "@anhourmail/shared/plans";

import { ACCOUNT_A, ACCOUNT_B, BREACHED_PW, deps, fakeBreaches, fixedClock, req, user } from "../__tests__/helpers";
import type { Actor } from "../actor";
import { ConflictError, ForbiddenError, NotFoundError, PlanLimitError, ValidationError } from "../errors";
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

describe("removeMember", () => {
  it("a User Admin removes a Member; their mailboxes stay, unassigned", async () => {
    const { d, s, as } = world();
    s.mailboxes.push({
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      accountId: ACCOUNT_A,
      userId: "kid",
      address: "kid@family.test",
      status: "active",
      quotaBytes: 1,
      stalwartId: null,
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(),
    });
    expect(await removeMember(d, as("admin"), ACCOUNT_A, "kid", req)).toEqual({ userId: "kid" });
    expect(s.memberships.some((m) => m.userId === "kid")).toBe(false);
    expect(s.mailboxes).toHaveLength(1);
    expect(audits(s, "account.member_removed")[0]).toMatchObject({
      result: "success",
      meta: { role: "member", mailboxesUnassigned: 1 },
    });
  });

  it("only an Owner removes an Owner or an admin (403 audited); never yourself; never the last Owner", async () => {
    const { d, s, as } = world();
    await expect(removeMember(d, as("admin"), ACCOUNT_A, "owner", req)).rejects.toThrow(ForbiddenError);
    await expect(removeMember(d, as("admin"), ACCOUNT_A, "auditor", req)).rejects.toThrow(ForbiddenError);
    expect(audits(s, "account.member_removed").map((e) => e.result)).toEqual(["denied", "denied"]);
    await expect(removeMember(d, as("admin"), ACCOUNT_A, "admin", req)).rejects.toThrow(ForbiddenError);
    await expect(removeMember(d, as("owner"), ACCOUNT_A, "owner", req)).rejects.toThrow("remove yourself");
    await removeMember(d, as("owner"), ACCOUNT_A, "admin", req);
    // The last Owner is never removed, even by a session that still thinks it's an Owner (a race).
    s.memberships.push({ userId: "ghost", accountId: ACCOUNT_A, role: "member" });
    const ghost = user({ id: "ghost", account: [[ACCOUNT_A, "owner"]] });
    await expect(removeMember(d, ghost, ACCOUNT_A, "owner", req)).rejects.toThrow("at least one owner");
  });

  it("is 403 for Members, 404 across accounts and for strangers", async () => {
    const { d, as } = world();
    await expect(removeMember(d, as("kid"), ACCOUNT_A, "kid", req)).rejects.toThrow(ForbiddenError);
    await expect(removeMember(d, as("owner-b"), ACCOUNT_A, "kid", req)).rejects.toThrow(NotFoundError);
    await expect(removeMember(d, as("owner"), ACCOUNT_A, "owner-b", req)).rejects.toThrow(NotFoundError);
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
