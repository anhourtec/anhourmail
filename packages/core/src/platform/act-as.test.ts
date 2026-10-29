// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACT_AS } from "@anhourmail/shared/platform";

import { ACCOUNT_A, ACCOUNT_B, deps, fixedClock, req, user } from "../__tests__/helpers";
import { authorize, can, type UserActor } from "../actor";
import { describeActor } from "../audit/labels";
import { accountAuditPage } from "../audit/service";
import { removeOwnAvatar, setOwnAvatar, setPersonAvatar } from "../avatars/service";
import { AccountSuspendedError, ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { listMailboxes, suspendMailbox } from "../mailboxes/service";
import { ACTING_PROFILE, updateOwnProfile, updatePersonProfile } from "../people/profile-service";
import { changeMemberRole, listPeople } from "../people/service";
import { setSignInPolicy } from "../security/service";
import {
  ACT_AS_ALREADY_OPEN,
  actingActor,
  actingActorFor,
  endActAs,
  expireActAsSessions,
  isCompanyAddress,
  parseActAsReason,
  renewActAs,
  startActAs,
} from "./act-as";
import { suspendAccount } from "./suspension";

const NOW = "2026-10-29T10:00:00Z";
const STAFF_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";
const MBX = "aaaaaaaa-0000-4000-8000-000000000001";
const SUPPORT = user({ id: "support", platform: ["support_admin"] });
const GA = user({ id: "ga", platform: ["global_admin"] });
const SESSION = { sessionId: "s-support" };
const REASON = "Ticket 1234: the owner asked for help with DNS";
const min = (n: number) => new Date(new Date(NOW).getTime() + n * 60_000);

function world() {
  const clock = fixedClock(NOW);
  const d = deps(clock);
  const s = d.uow.state;
  s.accounts.push(
    { id: ACCOUNT_A, name: "Acme", plan: "plus" },
    { id: ACCOUNT_B, name: "Other", plan: "plus" },
    { id: STAFF_ACCOUNT, name: "Anhourtec", plan: "plus" },
  );
  s.memberships.push(
    { userId: "owner-a", accountId: ACCOUNT_A, role: "owner" },
    { userId: "owner-a2", accountId: ACCOUNT_A, role: "owner" },
    { userId: "admin-a", accountId: ACCOUNT_A, role: "user_admin" },
    { userId: "member-a", accountId: ACCOUNT_A, role: "member" },
    { userId: "owner-b", accountId: ACCOUNT_B, role: "owner" },
    { userId: "ga", accountId: STAFF_ACCOUNT, role: "owner" },
    // Support staff are customers somewhere too: their own account stays out of reach while acting.
    { userId: "support", accountId: ACCOUNT_B, role: "member" },
  );
  for (const u of ["owner-a", "owner-a2", "admin-a", "member-a", "owner-b", "ga", "support", "tns"]) {
    s.userEmails[u] = `${u}@example.test`;
    s.userNames[u] = u;
  }
  s.userEmails.support = "support@anhourtec.test";
  s.platformRoles.push(
    { userId: "support", role: "support_admin" },
    { userId: "ga", role: "global_admin" },
    { userId: "tns", role: "trust_safety_admin" },
  );
  s.mailboxes.push({
    id: MBX,
    accountId: ACCOUNT_A,
    userId: "member-a",
    address: "member@acme.test",
    status: "active",
    quotaBytes: 1,
    stalwartId: "st-1",
    lastError: null,
    purgeAfter: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
  });
  const sessionRow = (id: string, userId: string) => ({
    id,
    userId,
    createdAt: clock.now(),
    lastActiveAt: clock.now(),
    expiresAt: min(24 * 60),
    ip: null,
    userAgent: null,
  });
  s.sessions.push(sessionRow("s-support", "support"), sessionRow("s-ga", "ga"));
  s.stepUps.push(
    { userId: "support", sessionId: "s-support", expiresAt: min(5) },
    { userId: "ga", sessionId: "s-ga", expiresAt: min(5) },
  );
  return { d, s, clock };
}

/** Starts support access to Acme and returns the actor the app would build for the next request. */
async function started(w: ReturnType<typeof world>, staff: UserActor = SUPPORT, session = SESSION) {
  const out = await startActAs(w.d, staff, ACCOUNT_A, { reason: REASON }, session, req);
  const acting = actingActor(staff, out.session, { accountSuspended: false });
  if (!acting) throw new Error("not acting");
  return { out, acting };
}

describe("act-as reason", () => {
  it("collapses whitespace and control characters, and keeps 10–500 characters", () => {
    expect(parseActAsReason("  Ticket\n\t1234 \u0000 DNS  ")).toBe("Ticket 1234 DNS");
    expect(() => parseActAsReason("short")).toThrow(/at least 10/);
    expect(() => parseActAsReason("x".repeat(ACT_AS.reasonMax + 1))).toThrow(/under 500/);
    expect(parseActAsReason("x".repeat(ACT_AS.reasonMax))).toHaveLength(ACT_AS.reasonMax);
    expect(() => parseActAsReason(undefined)).toThrow(/Say why/);
    expect(() => parseActAsReason(42)).toThrow(/Say why/);
  });
});

describe("starting support access", () => {
  it("opens the account read-only for 30 minutes, audited in its log and the platform log, owners to notify", async () => {
    const w = world();
    const { out, acting } = await started(w);
    expect(out.session).toMatchObject({
      staffUserId: "support",
      staffRole: "support_admin",
      accountId: ACCOUNT_A,
      accountName: "Acme",
      reason: REASON,
      authSessionId: "s-support",
      expiresAt: min(ACT_AS.minutes),
    });
    expect(out.notify.map((n) => n.email).sort()).toEqual(["owner-a2@example.test", "owner-a@example.test"]);
    const entries = w.s.audit.filter((e) => e.action === "staff.act_as_started");
    expect(entries.map((e) => e.scope).sort()).toEqual([`account:${ACCOUNT_A}`, "platform"]);
    for (const e of entries) {
      expect(e).toMatchObject({
        result: "success",
        actor: { type: "staff", userId: "support", role: "support_admin" },
        target: { type: "account", id: ACCOUNT_A, label: "Acme" },
        meta: { reason: REASON, minutes: 30, access: "read_only", actAsSessionId: out.session.id },
      });
    }
    // The actor: own identity, platform roles set aside, read-only in Acme only.
    expect(acting).toMatchObject({
      userId: "support",
      platformRoles: [],
      memberships: [{ accountId: ACCOUNT_A, role: "auditor" }],
      actingAs: { sessionId: out.session.id, accountId: ACCOUNT_A, staffRole: "support_admin", reason: REASON },
    });
    expect(acting.suspendedAccountIds).toBeUndefined();
  });

  it("is a Global or Support Administrator permission: everyone else 403, signed out 401", async () => {
    const w = world();
    for (const who of [
      user({ id: "tns", platform: ["trust_safety_admin"] }),
      user({ id: "billing", platform: ["billing_admin"] }),
      user({ id: "reader", platform: ["reports_reader"] }),
      user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] }),
    ]) {
      await expect(startActAs(w.d, who, ACCOUNT_A, { reason: REASON }, { sessionId: "x" }, req)).rejects.toThrow(
        ForbiddenError,
      );
    }
    await expect(
      startActAs(w.d, { kind: "anonymous" }, ACCOUNT_A, { reason: REASON }, { sessionId: null }, req),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(w.s.actAsSessions).toEqual([]);
    // Refusals before the account is known land in the platform log only.
    expect(w.s.audit.every((e) => e.scope === "platform" && e.result === "denied")).toBe(true);
    // A Global Administrator may.
    await started(w, GA, { sessionId: "s-ga" });
  });

  it("answers 404 for an unknown or malformed account, recorded in the platform log only", async () => {
    const w = world();
    for (const id of [MISSING, "not-an-id"]) {
      await expect(startActAs(w.d, SUPPORT, id, { reason: REASON }, SESSION, req)).rejects.toThrow(NotFoundError);
    }
    expect(w.s.audit.map((e) => [e.scope, e.result, e.errorCode])).toEqual([
      ["platform", "denied", "not_found"],
      ["platform", "denied", "not_found"],
    ]);
  });

  it("needs a fresh step-up of this console session (audited as denied in the account's log)", async () => {
    const w = world();
    w.s.stepUps = [];
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_A, { reason: REASON }, SESSION, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    await expect(
      startActAs(w.d, SUPPORT, ACCOUNT_A, { reason: REASON }, { sessionId: null }, req),
    ).rejects.toMatchObject({ code: "step_up_required" });
    w.s.stepUps.push({ userId: "support", sessionId: "s-support", expiresAt: min(-1) });
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_A, { reason: REASON }, SESSION, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect(w.s.actAsSessions).toEqual([]);
    expect(w.s.audit.at(-1)).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      result: "denied",
      errorCode: "step_up_required",
    });
  });

  it("refuses a bad reason before recording anything", async () => {
    const w = world();
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_A, { reason: "help" }, SESSION, req)).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(w.s.audit).toEqual([]);
  });

  it("never opens a staff account: a member with a platform role or a company sign-in address (rule 28)", async () => {
    const w = world();
    await expect(startActAs(w.d, SUPPORT, STAFF_ACCOUNT, { reason: REASON }, SESSION, req)).rejects.toThrow(
      /staff accounts/,
    );
    // No platform role, but a company address.
    w.s.memberships.push({ userId: "colleague", accountId: ACCOUNT_B, role: "member" });
    w.s.userEmails.colleague = "colleague@anhourtec.com";
    w.s.memberships = w.s.memberships.filter((m) => !(m.userId === "support" && m.accountId === ACCOUNT_B));
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_B, { reason: REASON }, SESSION, req)).rejects.toThrow(
      /staff accounts/,
    );
    expect(w.s.actAsSessions).toEqual([]);
    expect(w.s.audit.filter((e) => e.result === "denied").map((e) => e.errorCode)).toEqual([
      "staff_account",
      "staff_account",
    ]);
  });

  it("treats the company domain's subdomains as staff addresses, and nothing that only looks like it", async () => {
    expect(isCompanyAddress("a@anhourtec.com")).toBe(true);
    expect(isCompanyAddress("a@EU.Anhourtec.com")).toBe(true);
    expect(isCompanyAddress("a@x.y.anhourtec.com.")).toBe(true);
    expect(isCompanyAddress("a@notanhourtec.com")).toBe(false);
    expect(isCompanyAddress("a@anhourtec.com.evil.test")).toBe(false);
    expect(isCompanyAddress("anhourtec.com@example.test")).toBe(false);
    expect(isCompanyAddress("no-at-sign")).toBe(false);
    const w = world();
    w.s.memberships.push({ userId: "colleague", accountId: ACCOUNT_A, role: "member" });
    w.s.userEmails.colleague = "colleague@eu.anhourtec.com";
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_A, { reason: REASON }, SESSION, req)).rejects.toThrow(
      /staff accounts/,
    );
    w.s.userEmails.colleague = "colleague@notanhourtec.com";
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_A, { reason: REASON }, SESSION, req)).resolves.toBeDefined();
  });

  it("refuses a suspended account and a second open session for the same staff member (409)", async () => {
    const w = world();
    w.s.accountSuspensions[ACCOUNT_B] = { reason: "spam", note: null, at: w.clock.now(), byUserId: "ga" };
    w.s.memberships = w.s.memberships.filter((m) => m.userId !== "support");
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_B, { reason: REASON }, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    await started(w);
    Reflect.deleteProperty(w.s.accountSuspensions, ACCOUNT_B);
    await expect(startActAs(w.d, SUPPORT, ACCOUNT_B, { reason: REASON }, SESSION, req)).rejects.toThrow(
      /already have support access/,
    );
    expect(w.s.actAsSessions).toHaveLength(1);
    // Two staff members may act in the same account at once (each is recorded and notifies).
    await started(w, GA, { sessionId: "s-ga" });
    expect(w.s.actAsSessions).toHaveLength(2);
  });

  it("a session that ran out but isn't closed yet doesn't block a new start: it is closed and recorded first", async () => {
    const w = world();
    const first = await started(w);
    w.clock.set(min(ACT_AS.minutes + 1));
    w.s.stepUps.push({ userId: "support", sessionId: "s-support", expiresAt: min(ACT_AS.minutes + 5) });
    const second = await startActAs(w.d, SUPPORT, ACCOUNT_A, { reason: REASON }, SESSION, req);
    expect(second.session.id).not.toBe(first.out.session.id);
    const rows = new Map(w.s.actAsSessions.map((r) => [r.id, r]));
    expect(rows.get(first.out.session.id)).toMatchObject({ endReason: "expired", endedAt: min(ACT_AS.minutes) });
    const actions = w.s.audit.filter((e) => e.scope === `account:${ACCOUNT_A}`).map((e) => e.action);
    expect(actions.slice(-2)).toEqual(["staff.act_as_ended", "staff.act_as_started"]);
  });

  it("the store refuses a second unclosed session for the same staff member (concurrent starts)", async () => {
    const w = world();
    const { out } = await started(w);
    const row = { ...out.session, authSessionId: "s-other" };
    await expect(w.d.uow.run((r) => r.actAs.create(row))).rejects.toThrow(ConflictError);
    await expect(w.d.uow.run((r) => r.actAs.create(row))).rejects.toThrow(ACT_AS_ALREADY_OPEN);
    expect(w.s.actAsSessions).toHaveLength(1);
  });

  it("can't be started while already acting (platform roles are set aside: 403)", async () => {
    const w = world();
    const { acting } = await started(w);
    await expect(startActAs(w.d, acting, ACCOUNT_B, { reason: REASON }, SESSION, req)).rejects.toThrow(ForbiddenError);
  });
});

describe("acting in the account", () => {
  it("reads what an Auditor reads, through the same service checks", async () => {
    const w = world();
    const { acting } = await started(w);
    expect((await listPeople(w.d, acting, ACCOUNT_A)).members.length).toBeGreaterThan(0);
    expect(await listMailboxes(w.d, acting, ACCOUNT_A)).toHaveLength(1);
    expect(can(acting, "audit.read", ACCOUNT_A)).toBe(true);
    expect(can(acting, "platform.accounts.read")).toBe(false);
  });

  it("refuses changes and owner-only actions with 403, audited with on_behalf_of in the account's log", async () => {
    const w = world();
    const { out, acting } = await started(w);
    await expect(suspendMailbox(w.d, acting, ACCOUNT_A, MBX, req)).rejects.toThrow(ForbiddenError);
    await expect(changeMemberRole(w.d, acting, ACCOUNT_A, "member-a", { role: "owner" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(setSignInPolicy(w.d, acting, { accountId: ACCOUNT_A, policy: "passkey" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    for (const p of [
      "account.delete",
      "billing.manage",
      "account.admins.manage",
      "member.credentials.reset",
    ] as const) {
      expect(() => {
        authorize(acting, p, ACCOUNT_A);
      }).toThrow(ForbiddenError);
    }
    const denied = w.s.audit.filter((e) => e.result === "denied");
    expect(denied).toHaveLength(3);
    for (const e of denied) {
      expect(e.scope).toBe(`account:${ACCOUNT_A}`);
      expect(e.actor).toMatchObject({ type: "staff", userId: "support", role: "support_admin" });
      expect(e.onBehalfOf).toEqual({
        userId: "support",
        email: "support@anhourtec.test",
        accountId: ACCOUNT_A,
        sessionId: out.session.id,
      });
      expect(describeActor(e)).toMatchObject({ kind: "staff", label: "Anhourtec staff" });
    }
    expect(w.s.mailboxes[0]?.status).toBe("active");
  });

  it("answers 404 for every other account, including the staff member's own", async () => {
    const w = world();
    const { acting } = await started(w);
    await expect(listPeople(w.d, acting, ACCOUNT_B)).rejects.toThrow(NotFoundError);
    await expect(listMailboxes(w.d, acting, STAFF_ACCOUNT)).rejects.toThrow(NotFoundError);
    await expect(suspendMailbox(w.d, acting, ACCOUNT_B, MBX, req)).rejects.toThrow(NotFoundError);
  });

  it("the account's admins see the session as Anhourtec staff in their audit log", async () => {
    const w = world();
    const { acting } = await started(w);
    await expect(suspendMailbox(w.d, acting, ACCOUNT_A, MBX, req)).rejects.toThrow(ForbiddenError);
    await endActAs(w.d, acting, req);
    const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
    const page = await accountAuditPage(w.d, owner, ACCOUNT_A, { actor: "staff" });
    expect(page.entries.map((e) => e.action)).toEqual([
      "staff.act_as_ended",
      "mailbox.suspended",
      "staff.act_as_started",
    ]);
    expect(page.entries.every((e) => describeActor(e).label === "Anhourtec staff")).toBe(true);
  });

  it("a suspended account answers account_suspended while acting; losing the role drops the act-as actor", async () => {
    const w = world();
    const { out } = await started(w);
    const suspended = actingActor(SUPPORT, out.session, { accountSuspended: true });
    if (!suspended) throw new Error("not acting");
    await expect(listPeople(w.d, suspended, ACCOUNT_A)).rejects.toThrow(AccountSuspendedError);
    expect(actingActor(user({ id: "support" }), out.session, { accountSuspended: false })).toBeNull();
    expect(actingActor(GA, out.session, { accountSuspended: false })).toBeNull();
  });

  it("staff tools refuse while acting (suspension needs the platform permission it no longer has)", async () => {
    const w = world();
    const { acting } = await started(w, GA, { sessionId: "s-ga" });
    await expect(
      suspendAccount(w.d, acting, ACCOUNT_B, { reason: "spam" }, { sessionId: "s-ga" }, req),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("the acting actor on each request", () => {
  it("is built only for this console session of an act-as role holder", async () => {
    const w = world();
    const { out } = await started(w);
    expect((await actingActorFor(w.d, SUPPORT, "s-support"))?.actingAs?.sessionId).toBe(out.session.id);
    expect(await actingActorFor(w.d, SUPPORT, "s-elsewhere")).toBeNull();
    expect(await actingActorFor(w.d, user({ id: "support" }), "s-support")).toBeNull();
    const suspended = (w.s.accountSuspensions[ACCOUNT_A] = {
      reason: "spam",
      note: null,
      at: w.clock.now(),
      byUserId: "ga",
    });
    expect(suspended).toBeDefined();
    expect((await actingActorFor(w.d, SUPPORT, "s-support"))?.suspendedAccountIds).toEqual([ACCOUNT_A]);
  });

  it("is dropped at once when staff join the account meanwhile, and the scheduler closes it as staff_account", async () => {
    const w = world();
    await started(w);
    w.s.memberships.push({ userId: "tns", accountId: ACCOUNT_A, role: "member" });
    expect(await actingActorFor(w.d, SUPPORT, "s-support")).toBeNull();
    expect(await expireActAsSessions(w.d)).toEqual({ ended: 1 });
    expect(w.s.actAsSessions[0]?.endReason).toBe("staff_account");
    // A company address (a subdomain too) counts the same.
    const w2 = world();
    await started(w2);
    w2.s.memberships.push({ userId: "colleague", accountId: ACCOUNT_A, role: "member" });
    w2.s.userEmails.colleague = "colleague@eu.anhourtec.com";
    expect(await actingActorFor(w2.d, SUPPORT, "s-support")).toBeNull();
  });
});

describe("own profile and photo while acting", () => {
  const images = {
    calls: 0,
    normalise() {
      images.calls += 1;
      return Promise.reject(new Error("never decoded while acting"));
    },
  };

  it("refuses the staff member's own profile and photo changes (403, denied act_as), so none lands in the log", async () => {
    const w = world();
    const { acting } = await started(w);
    const before = w.s.audit.length;
    await expect(updateOwnProfile(w.d, acting, { profile: { jobTitle: "Support" } }, req)).rejects.toThrow(
      ACTING_PROFILE,
    );
    await expect(
      updatePersonProfile(w.d, acting, ACCOUNT_A, "support", { profile: { jobTitle: "Support" } }, req),
    ).rejects.toThrow(ForbiddenError);
    await expect(setOwnAvatar(w.d, images, acting, new Uint8Array([1, 2, 3]), req)).rejects.toThrow(ACTING_PROFILE);
    await expect(removeOwnAvatar(w.d, acting, req)).rejects.toThrow(ACTING_PROFILE);
    await expect(setPersonAvatar(w.d, images, acting, ACCOUNT_A, "member-a", new Uint8Array([1]), req)).rejects.toThrow(
      ForbiddenError,
    );
    expect(images.calls).toBe(0);
    expect(w.s.profiles.support).toBeUndefined();
    expect(w.s.avatars).toEqual([]);
    const added = w.s.audit.slice(before);
    // Someone else's photo needs member.manage, which a read-only actor lacks: the permission check answers first.
    expect(added.map((e) => [e.result, e.errorCode])).toEqual([
      ...Array<string[]>(4).fill(["denied", "act_as"]),
      ["denied", "forbidden"],
    ]);
    expect(added.every((e) => e.actor.type === "staff" && e.onBehalfOf?.sessionId !== undefined)).toBe(true);
  });

  it("the same staff member's own changes work again once support access ends", async () => {
    const w = world();
    const { acting } = await started(w);
    await endActAs(w.d, acting, req);
    await expect(updateOwnProfile(w.d, SUPPORT, { profile: { jobTitle: "Support" } }, req)).resolves.toMatchObject({
      changed: ["jobTitle"],
    });
  });
});

describe("renewing and ending", () => {
  it("renews with a new reason and a fresh step-up, never past four hours from the start", async () => {
    const w = world();
    const { out, acting } = await started(w);
    w.clock.set(min(20));
    w.s.stepUps.push({ userId: "support", sessionId: "s-support", expiresAt: min(25) });
    const renewed = await renewActAs(w.d, acting, { reason: "Ticket 1234: still checking DNS" }, SESSION, req);
    expect(renewed.expiresAt).toEqual(min(50));
    expect(w.s.actAsSessions[0]).toMatchObject({ expiresAt: min(50), reason: "Ticket 1234: still checking DNS" });
    expect(w.s.audit.filter((e) => e.action === "staff.act_as_renewed").map((e) => e.scope)).toEqual([
      `account:${ACCOUNT_A}`,
      "platform",
    ]);
    // Near the cap: the expiry stops at four hours; at the cap: 409.
    const row = w.s.actAsSessions[0];
    if (!row) throw new Error("no session");
    row.expiresAt = min(ACT_AS.maxMinutes - 10);
    w.clock.set(min(ACT_AS.maxMinutes - 15));
    w.s.stepUps.push({ userId: "support", sessionId: "s-support", expiresAt: min(ACT_AS.maxMinutes) });
    const capped = await renewActAs(w.d, acting, { reason: "Ticket 1234: last check" }, SESSION, req);
    expect(capped.expiresAt).toEqual(min(ACT_AS.maxMinutes));
    await expect(renewActAs(w.d, acting, { reason: "Ticket 1234: one more" }, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(out.session.id).toBe(row.id);
  });

  it("refuses renewal without a step-up, without the role, with a bad reason, or with nothing open", async () => {
    const w = world();
    const { acting } = await started(w);
    w.clock.set(min(10)); // the step-up from the start has lapsed
    await expect(renewActAs(w.d, acting, { reason: REASON }, SESSION, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    await expect(renewActAs(w.d, acting, { reason: "no" }, SESSION, req)).rejects.toMatchObject({
      code: "bad_request",
    });
    w.s.platformRoles = w.s.platformRoles.filter((r) => r.userId !== "support");
    await expect(renewActAs(w.d, acting, { reason: REASON }, SESSION, req)).rejects.toThrow(ForbiddenError);
    await expect(renewActAs(w.d, SUPPORT, { reason: REASON }, SESSION, req)).rejects.toThrow(NotFoundError);
    await expect(renewActAs(w.d, { kind: "anonymous" }, { reason: REASON }, SESSION, req)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("ends now (audited with the length), once; ending with nothing open is a 404", async () => {
    const w = world();
    const { acting } = await started(w);
    w.clock.set(min(12));
    expect(await endActAs(w.d, acting, req)).toEqual({ accountId: ACCOUNT_A });
    expect(w.s.actAsSessions[0]).toMatchObject({ endedAt: min(12), endReason: "staff" });
    const ended = w.s.audit.filter((e) => e.action === "staff.act_as_ended");
    expect(ended.map((e) => e.scope)).toEqual([`account:${ACCOUNT_A}`, "platform"]);
    expect(ended[0]).toMatchObject({ actor: { type: "staff" }, meta: { ended: "staff", minutes: 12 } });
    await expect(endActAs(w.d, acting, req)).rejects.toThrow(NotFoundError);
    await expect(endActAs(w.d, SUPPORT, req)).rejects.toThrow(NotFoundError);
    // An actor still carrying a session that has expired meanwhile: nothing to end.
    w.s.stepUps.push({ userId: "support", sessionId: "s-support", expiresAt: min(15) });
    const again = await started(w);
    w.clock.set(min(12 + ACT_AS.minutes + 1));
    await expect(endActAs(w.d, again.acting, req)).rejects.toThrow(NotFoundError);
  });
});

describe("expiry (scheduler)", () => {
  it("closes expired, signed-out and role-removed sessions, recorded by the system; re-runs do nothing", async () => {
    const w = world();
    const a = await started(w);
    const b = await started(w, GA, { sessionId: "s-ga" });
    expect(await expireActAsSessions(w.d)).toEqual({ ended: 0 });
    // GA signed out; then support's half hour runs out.
    w.s.sessions = w.s.sessions.filter((x) => x.id !== "s-ga");
    expect(await expireActAsSessions(w.d)).toEqual({ ended: 1 });
    w.clock.set(min(ACT_AS.minutes + 2));
    expect(await expireActAsSessions(w.d)).toEqual({ ended: 1 });
    expect(await expireActAsSessions(w.d)).toEqual({ ended: 0 });
    const rows = new Map(w.s.actAsSessions.map((r) => [r.id, r]));
    expect(rows.get(b.out.session.id)).toMatchObject({ endReason: "signed_out", endedAt: min(0) });
    expect(rows.get(a.out.session.id)).toMatchObject({ endReason: "expired", endedAt: min(ACT_AS.minutes) });
    const ended = w.s.audit.filter((e) => e.action === "staff.act_as_ended" && e.scope === `account:${ACCOUNT_A}`);
    expect(ended.map((e) => [e.actor.type, e.meta.ended])).toEqual([
      ["system", "signed_out"],
      ["system", "expired"],
    ]);
  });

  it("ends a session whose staff member no longer holds an act-as role", async () => {
    const w = world();
    await started(w);
    w.s.platformRoles = w.s.platformRoles.filter((r) => r.userId !== "support");
    expect(await expireActAsSessions(w.d)).toEqual({ ended: 1 });
    expect(w.s.actAsSessions[0]?.endReason).toBe("role_removed");
  });
});
