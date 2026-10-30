// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { DELEGATED_MAILBOXES_PER_PERSON, DELEGATES_PER_MAILBOX } from "@anhourmail/shared/plans";

import { ACCOUNT_A, ACCOUNT_B, actAs, deps, fixedClock, req, user } from "../__tests__/helpers";
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
import type { Mailbox, MailboxStatus } from "../mailboxes/entity";
import type { Deps, UnitOfWork } from "../ports";
import { dropOwnGrants, dropPersonGrants } from "./cascade";
import {
  delegationAvailability,
  getMailboxDelegation,
  listPersonDelegations,
  updateMailboxDelegation,
} from "./service";

const SHARED = "aaaaaaaa-0000-4000-8000-000000000001";
const KIM_BOX = "aaaaaaaa-0000-4000-8000-000000000002";
const OWNER_BOX = "aaaaaaaa-0000-4000-8000-000000000003";
const UADMIN_BOX = "aaaaaaaa-0000-4000-8000-000000000004";
const DELETING = "aaaaaaaa-0000-4000-8000-000000000005";
const B_BOX = "bbbbbbbb-0000-4000-8000-000000000001";
const UNKNOWN = "cccccccc-0000-4000-8000-000000000001";
const SESSION: { sessionId: string | null } = { sessionId: "sess-1" };

type Role = "owner" | "user_admin" | "domain_admin" | "auditor" | "member";

/** Account A (Plus): two Owners, a User Admin, a Domain Admin, an Auditor and two Members; account B with its Owner. */
function world(plan: "plus" | "free" = "plus") {
  const clock = fixedClock("2026-10-30T12:00:00Z");
  const d = deps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Family A", plan }, { id: ACCOUNT_B, name: "Family B", plan: "plus" });
  const people: [string, string, Role, string][] = [
    ["owner", "Olive Owner", "owner", ACCOUNT_A],
    ["owner2", "Otto Owner", "owner", ACCOUNT_A],
    ["uadmin", "Uma Admin", "user_admin", ACCOUNT_A],
    ["dadmin", "Dan Admin", "domain_admin", ACCOUNT_A],
    ["auditor", "Ada Auditor", "auditor", ACCOUNT_A],
    ["kim", "Kim Member", "member", ACCOUNT_A],
    ["lee", "Lee Member", "member", ACCOUNT_A],
    ["owner-b", "Bea Owner", "owner", ACCOUNT_B],
  ];
  for (const [id, name, role, accountId] of people) {
    s.userEmails[id] = `${id}@family.test`;
    s.userNames[id] = name;
    s.memberships.push({ userId: id, accountId, role });
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
    box(SHARED, ACCOUNT_A, "desk@family.test", null, "active"),
    box(KIM_BOX, ACCOUNT_A, "kim@family.test", "kim", "active"),
    box(OWNER_BOX, ACCOUNT_A, "owner@family.test", "owner", "active"),
    box(UADMIN_BOX, ACCOUNT_A, "uadmin@family.test", "uadmin", "suspended"),
    box(DELETING, ACCOUNT_A, "old@family.test", null, "deleting"),
    box(B_BOX, ACCOUNT_B, "bea@b.test", "owner-b", "active"),
  );
  for (const id of ["owner", "owner2", "uadmin", "dadmin", "auditor", "kim", "owner-b"]) {
    s.stepUps.push({ userId: id, sessionId: "sess-1", expiresAt: new Date("2026-10-30T12:05:00Z") });
  }
  const as = (id: string): Actor => {
    const u = user({
      id,
      account: s.memberships.filter((m) => m.userId === id).map((m) => [m.accountId, m.role] as [string, Role]),
    });
    return { ...u, email: s.userEmails[id] ?? u.email };
  };
  const update = (actor: Actor, mailboxId: string, input: unknown, session = SESSION, accountId = ACCOUNT_A) =>
    updateMailboxDelegation(d, actor, accountId, mailboxId, input, session, req);
  const audits = (action?: string, accountId = ACCOUNT_A) =>
    s.audit.filter((e) => e.scope === `account:${accountId}` && (action === undefined || e.action === action));
  return { d, s, clock, as, update, audits };
}

const add = (userId: string, right: "full_access" | "send_as" | "send_on_behalf") => ({ userId, right });

describe("getMailboxDelegation", () => {
  it("lists the three lists with names and addresses, and whether the viewer may change them", async () => {
    const { d, as, update } = world();
    await update(as("owner"), SHARED, {
      add: [add("kim", "full_access"), add("kim", "send_as"), add("lee", "send_on_behalf")],
    });
    const view = await getMailboxDelegation(d, as("owner"), ACCOUNT_A, SHARED);
    expect(view).toEqual({
      mailboxId: SHARED,
      address: "desk@family.test",
      fullAccess: [{ userId: "kim", name: "Kim Member", email: "kim@family.test" }],
      sendAs: [{ userId: "kim", name: "Kim Member", email: "kim@family.test" }],
      sendOnBehalf: [{ userId: "lee", name: "Lee Member", email: "lee@family.test" }],
      canManage: true,
    });
    // The Auditor and the User Admin read it; the Auditor can't change it, nor the User Admin on an Owner's mailbox.
    expect((await getMailboxDelegation(d, as("auditor"), ACCOUNT_A, SHARED)).canManage).toBe(false);
    expect((await getMailboxDelegation(d, as("uadmin"), ACCOUNT_A, SHARED)).canManage).toBe(true);
    expect((await getMailboxDelegation(d, as("uadmin"), ACCOUNT_A, OWNER_BOX)).canManage).toBe(false);
    expect((await getMailboxDelegation(d, as("uadmin"), ACCOUNT_A, UADMIN_BOX)).canManage).toBe(true);
  });

  it("is 403 without delegation.read, 404 across accounts and for unknown ids, 401 signed out", async () => {
    const { d, as } = world();
    await expect(getMailboxDelegation(d, as("kim"), ACCOUNT_A, SHARED)).rejects.toThrow(ForbiddenError);
    await expect(getMailboxDelegation(d, as("dadmin"), ACCOUNT_A, SHARED)).rejects.toThrow(ForbiddenError);
    await expect(getMailboxDelegation(d, as("owner-b"), ACCOUNT_A, SHARED)).rejects.toThrow(NotFoundError);
    await expect(getMailboxDelegation(d, as("owner"), ACCOUNT_A, B_BOX)).rejects.toThrow(NotFoundError);
    await expect(getMailboxDelegation(d, as("owner"), ACCOUNT_A, UNKNOWN)).rejects.toThrow(NotFoundError);
    await expect(getMailboxDelegation(d, as("owner"), ACCOUNT_A, "not-an-id")).rejects.toThrow(NotFoundError);
    await expect(getMailboxDelegation(d, { kind: "anonymous" }, ACCOUNT_A, SHARED)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it("leaves out a grant whose person is no longer listed (a backstop; removals drop them)", async () => {
    const { d, s, as, update } = world();
    await update(as("owner"), SHARED, { add: [add("kim", "full_access")] });
    s.memberships = s.memberships.filter((m) => m.userId !== "kim");
    expect((await getMailboxDelegation(d, as("owner"), ACCOUNT_A, SHARED)).fullAccess).toEqual([]);
  });
});

describe("updateMailboxDelegation", () => {
  it("adds people in one unit of work, one audit entry per change, the mailbox's person never named in content", async () => {
    const { s, as, update, audits } = world();
    const view = await update(as("owner"), SHARED, {
      add: [add("kim", "full_access"), add("kim", "send_as"), add("lee", "send_on_behalf")],
    });
    expect(view.fullAccess.map((p) => p.userId)).toEqual(["kim"]);
    expect(view.sendOnBehalf.map((p) => p.userId)).toEqual(["lee"]);
    expect(s.delegations.map((g) => [g.granteeUserId, g.right, g.grantedBy, g.accountId])).toEqual([
      ["kim", "full_access", "owner", ACCOUNT_A],
      ["kim", "send_as", "owner", ACCOUNT_A],
      ["lee", "send_on_behalf", "owner", ACCOUNT_A],
    ]);
    const entries = audits("delegation.granted");
    expect(entries.map((e) => [e.result, e.target.id, e.target.label, e.meta.granteeUserId, e.meta.right])).toEqual([
      ["success", SHARED, "desk@family.test", "kim", "full_access"],
      ["success", SHARED, "desk@family.test", "kim", "send_as"],
      ["success", SHARED, "desk@family.test", "lee", "send_on_behalf"],
    ]);
    expect(entries[0]?.meta).toMatchObject({
      mailboxId: SHARED,
      grantee: "k***@family.test",
      reason: "admin",
      changes: 3,
    });
    expect(entries.every((e) => e.requestId === req.requestId && e.actor.userId === "owner")).toBe(true);
  });

  it("removes people; a remove-only batch is recorded as revocations; repeats change nothing", async () => {
    const { s, as, update, audits } = world();
    await update(as("owner"), SHARED, { add: [add("kim", "full_access"), add("lee", "full_access")] });
    await update(as("owner"), SHARED, { remove: [add("kim", "full_access"), add("lee", "send_as")] });
    expect(s.delegations.map((g) => g.granteeUserId)).toEqual(["lee"]);
    expect(audits("delegation.revoked").map((e) => [e.meta.granteeUserId, e.meta.reason])).toEqual([["kim", "admin"]]);
    // Nothing to change: one entry with the counts.
    await update(as("owner"), SHARED, { add: [add("lee", "full_access")] });
    expect(audits("delegation.granted").at(-1)?.meta).toEqual({ mailboxId: SHARED, granted: 0, revoked: 0 });
    // Adds already held while a remove happens: the counts on the main entry, the revoke as its own entry.
    await update(as("owner"), SHARED, { add: [add("kim", "send_as")] });
    await update(as("owner"), SHARED, { add: [add("lee", "full_access")], remove: [add("kim", "send_as")] });
    expect(s.delegations.map((g) => g.granteeUserId)).toEqual(["lee"]);
    const last = s.audit.slice(-2);
    expect(last.map((e) => [e.action, e.meta.granted, e.meta.revoked])).toEqual([
      ["delegation.granted", 0, 1],
      ["delegation.revoked", undefined, undefined],
    ]);
  });

  it("applies removes before adds, so a batch can move someone between lists", async () => {
    const { s, as, update } = world();
    await update(as("owner"), SHARED, { add: [add("kim", "send_on_behalf")] });
    const view = await update(as("owner"), SHARED, {
      add: [add("kim", "send_as")],
      remove: [add("kim", "send_on_behalf")],
    });
    expect(view.sendAs.map((p) => p.userId)).toEqual(["kim"]);
    expect(view.sendOnBehalf).toEqual([]);
    expect(s.delegations.map((g) => g.right)).toEqual(["send_as"]);
  });

  it("guard rail 8: a User Admin manages Members', person-less and their own mailboxes, never an Owner's (403 audited)", async () => {
    const { s, as, update, audits } = world();
    await update(as("uadmin"), KIM_BOX, { add: [add("lee", "full_access")] });
    await update(as("uadmin"), SHARED, { add: [add("kim", "full_access")] });
    await update(as("uadmin"), UADMIN_BOX, { add: [add("kim", "send_as")] });
    await expect(update(as("uadmin"), OWNER_BOX, { add: [add("kim", "full_access")] })).rejects.toThrow(
      "Only an owner can give access",
    );
    expect(s.delegations.some((g) => g.mailboxId === OWNER_BOX)).toBe(false);
    expect(audits("delegation.granted").at(-1)).toMatchObject({
      result: "denied",
      errorCode: "forbidden",
      target: { id: OWNER_BOX, label: "owner@family.test" },
    });
    // Another Owner's mailbox is fine for an Owner.
    await update(as("owner2"), OWNER_BOX, { add: [add("kim", "full_access")] });
    expect(s.delegations.filter((g) => g.mailboxId === OWNER_BOX)).toHaveLength(1);
  });

  it("is 403 without delegation.manage.any (audited in the account), 404 across accounts and for unknown mailboxes", async () => {
    const { s, as, update, audits } = world();
    for (const who of ["kim", "auditor", "dadmin"]) {
      await expect(update(as(who), SHARED, { add: [add("lee", "full_access")] })).rejects.toThrow(ForbiddenError);
    }
    expect(audits("delegation.granted").map((e) => e.result)).toEqual(["denied", "denied", "denied"]);
    await expect(update(as("owner-b"), SHARED, { add: [add("lee", "full_access")] })).rejects.toThrow(NotFoundError);
    // A probe from outside never lands in the account's log.
    expect(audits("delegation.granted")).toHaveLength(3);
    await expect(update(as("owner"), B_BOX, { add: [add("lee", "full_access")] })).rejects.toThrow(NotFoundError);
    await expect(update(as("owner"), UNKNOWN, { add: [add("lee", "full_access")] })).rejects.toThrow(NotFoundError);
    await expect(update(as("owner"), "x", { add: [add("lee", "full_access")] })).rejects.toThrow(NotFoundError);
    await expect(update({ kind: "system", name: "job" }, SHARED, { add: [add("lee", "full_access")] })).rejects.toThrow(
      ForbiddenError,
    );
    expect(s.delegations).toEqual([]);
  });

  it("is refused while acting as someone, before anything is looked up (403 act_as)", async () => {
    const { s, as, update, audits } = world();
    const acting = { ...(as("owner") as Extract<Actor, { kind: "user" }>), actingAs: actAs(ACCOUNT_A) };
    await expect(update(acting, UNKNOWN, { add: [add("kim", "full_access")] })).rejects.toThrow("acting as someone");
    expect(audits("delegation.granted").at(-1)).toMatchObject({ result: "denied", errorCode: "act_as" });
    expect(s.delegations).toEqual([]);
  });

  it("needs a fresh step-up on this console session (403 step_up_required, audited)", async () => {
    const { s, clock, as, update, audits } = world();
    await expect(
      update(as("owner"), SHARED, { add: [add("kim", "full_access")] }, { sessionId: null }),
    ).rejects.toThrow(StepUpRequiredError);
    await expect(
      update(as("owner"), SHARED, { add: [add("kim", "full_access")] }, { sessionId: "other" }),
    ).rejects.toThrow(StepUpRequiredError);
    clock.set(new Date("2026-10-30T12:06:00Z"));
    await expect(update(as("owner"), SHARED, { remove: [add("kim", "full_access")] })).rejects.toThrow(
      StepUpRequiredError,
    );
    expect(audits().map((e) => [e.action, e.errorCode])).toEqual([
      ["delegation.granted", "step_up_required"],
      ["delegation.granted", "step_up_required"],
      ["delegation.revoked", "step_up_required"],
    ]);
    expect(s.delegations).toEqual([]);
  });

  it("reads the mailbox under the account lock: a deletion that commits first makes the batch a 409 that writes nothing", async () => {
    const { d, s, as } = world();
    // Stands in for a deletion that commits while this batch waits for the account lock.
    const uow: UnitOfWork = {
      run: (fn) =>
        d.uow.run((r) =>
          fn({
            ...r,
            accounts: {
              ...r.accounts,
              lock: async (id) => {
                await r.accounts.lock(id);
                await r.mailboxes.transition(SHARED, ["active"], "deleting", new Date("2026-11-30T00:00:00Z"));
              },
            },
          }),
        ),
    };
    const racing: Deps = { ...d, uow };
    await expect(
      updateMailboxDelegation(
        racing,
        as("owner"),
        ACCOUNT_A,
        SHARED,
        { add: [add("kim", "full_access")] },
        SESSION,
        req,
      ),
    ).rejects.toThrow("being deleted");
    expect(s.delegations).toEqual([]);
    expect(s.audit.filter((e) => e.action === "delegation.granted").map((e) => e.result)).toEqual(["failed"]);
  });

  it("needs a plan with delegation to add people (403 plan_limit); removing access works on any plan", async () => {
    const { s, as, update } = world();
    await update(as("owner"), SHARED, { add: [add("kim", "full_access")] });
    const account = s.accounts.find((a) => a.id === ACCOUNT_A);
    if (account) account.plan = "free"; // a downgrade after the grant
    await expect(update(as("owner"), SHARED, { add: [add("kim", "send_as")] })).rejects.toThrow(PlanLimitError);
    const after = await update(as("owner"), SHARED, { add: [], remove: [add("kim", "full_access")] });
    expect(after.fullAccess).toEqual([]);
  });

  it("refuses a mailbox being deleted, a malformed batch, someone outside the account and the mailbox's own person", async () => {
    const { s, as, update, audits } = world();
    await expect(update(as("owner"), DELETING, { add: [add("kim", "full_access")] })).rejects.toThrow(ConflictError);
    for (const bad of [{}, { add: [] }, { add: [{ userId: "kim", right: "owner" }] }, "everyone", null]) {
      await expect(update(as("owner"), SHARED, bad)).rejects.toThrow(ValidationError);
    }
    expect(audits().at(-1)).toMatchObject({ result: "failed", errorCode: "bad_request" });
    await expect(update(as("owner"), SHARED, { add: [add("owner-b", "full_access")] })).rejects.toThrow(
      "isn't in this account",
    );
    await expect(update(as("owner"), SHARED, { remove: [add("nobody", "send_as")] })).rejects.toThrow(NotFoundError);
    await expect(update(as("owner"), KIM_BOX, { add: [add("kim", "full_access")] })).rejects.toThrow(
      "Kim Member already owns this mailbox",
    );
    // A refusal part-way through rolls the whole batch back.
    await expect(
      update(as("owner"), SHARED, { add: [add("lee", "full_access"), add("owner-b", "send_as")] }),
    ).rejects.toThrow(NotFoundError);
    expect(s.delegations).toEqual([]);
  });

  it(`holds a mailbox to ${String(DELEGATES_PER_MAILBOX)} people and a person to ${String(DELEGATED_MAILBOXES_PER_PERSON)} mailboxes (409)`, async () => {
    const { s, as, update } = world();
    const now = new Date("2026-10-30T11:00:00Z");
    for (let i = 0; i < DELEGATES_PER_MAILBOX; i++) {
      const id = `extra-${String(i)}`;
      s.memberships.push({ userId: id, accountId: ACCOUNT_A, role: "member" });
      s.delegations.push({
        id: `g-${id}`,
        accountId: ACCOUNT_A,
        mailboxId: SHARED,
        granteeUserId: id,
        right: "full_access",
        grantedBy: null,
        createdAt: now,
      });
    }
    // Another right for someone already on it is fine; a new person isn't.
    await update(as("owner"), SHARED, { add: [add("extra-0", "send_as")] });
    await expect(update(as("owner"), SHARED, { add: [add("kim", "full_access")] })).rejects.toThrow(
      `up to ${String(DELEGATES_PER_MAILBOX)} people`,
    );
    // Removing someone makes room in the same batch.
    await update(as("owner"), SHARED, { add: [add("kim", "full_access")], remove: [add("extra-1", "full_access")] });

    for (let i = 0; i < DELEGATED_MAILBOXES_PER_PERSON; i++) {
      const id = `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`;
      s.mailboxes.push({
        id,
        accountId: ACCOUNT_A,
        userId: null,
        address: `box${String(i)}@family.test`,
        status: "active",
        quotaBytes: 1,
        stalwartId: null,
        lastError: null,
        purgeAfter: null,
        createdAt: now,
      });
      if (i > 0) await update(as("owner"), id, { add: [add("lee", "send_as")] });
    }
    // Lee holds rights on 19 mailboxes: one more is the twentieth, then the ceiling.
    await update(as("owner"), "ffffffff-0000-4000-8000-000000000000", { add: [add("lee", "send_as")] });
    await expect(update(as("owner"), KIM_BOX, { add: [add("lee", "send_as")] })).rejects.toThrow(
      `Lee Member can already open or send from ${String(DELEGATED_MAILBOXES_PER_PERSON)} mailboxes`,
    );
  });
});

describe("listPersonDelegations", () => {
  it("lists the mailboxes a person can open or send from, by address, rights in order", async () => {
    const { d, as, update } = world();
    await update(as("owner"), SHARED, { add: [add("kim", "send_on_behalf"), add("kim", "full_access")] });
    await update(as("owner"), OWNER_BOX, { add: [add("kim", "send_as")] });
    expect(await listPersonDelegations(d, as("auditor"), ACCOUNT_A, "kim")).toEqual([
      { mailboxId: SHARED, address: "desk@family.test", rights: ["full_access", "send_on_behalf"] },
      { mailboxId: OWNER_BOX, address: "owner@family.test", rights: ["send_as"] },
    ]);
    expect(await listPersonDelegations(d, as("uadmin"), ACCOUNT_A, "lee")).toEqual([]);
  });

  it("is 403 without delegation.read, 404 for someone outside the account or across accounts", async () => {
    const { d, as } = world();
    await expect(listPersonDelegations(d, as("kim"), ACCOUNT_A, "kim")).rejects.toThrow(ForbiddenError);
    await expect(listPersonDelegations(d, as("owner"), ACCOUNT_A, "owner-b")).rejects.toThrow(NotFoundError);
    await expect(listPersonDelegations(d, as("owner"), ACCOUNT_A, "x".repeat(201))).rejects.toThrow(NotFoundError);
    await expect(listPersonDelegations(d, as("owner-b"), ACCOUNT_A, "kim")).rejects.toThrow(NotFoundError);
  });

  it("skips a grant whose mailbox is gone (a backstop; deletions drop them)", async () => {
    const { d, s, as, update } = world();
    await update(as("owner"), SHARED, { add: [add("kim", "full_access")] });
    s.mailboxes = s.mailboxes.filter((m) => m.id !== SHARED);
    expect(await listPersonDelegations(d, as("owner"), ACCOUNT_A, "kim")).toEqual([]);
  });
});

describe("delegationAvailability", () => {
  it("says whether the plan includes delegation and whether the viewer may change grants", async () => {
    const { d, as } = world();
    expect(await delegationAvailability(d, as("owner"), ACCOUNT_A)).toEqual({
      plan: true,
      planName: "Plus",
      canManage: true,
    });
    expect((await delegationAvailability(d, as("uadmin"), ACCOUNT_A)).canManage).toBe(true);
    expect((await delegationAvailability(d, as("auditor"), ACCOUNT_A)).canManage).toBe(false);
    const free = world("free");
    expect(await delegationAvailability(free.d, free.as("owner"), ACCOUNT_A)).toMatchObject({
      plan: false,
      planName: "Free",
    });
  });

  it("never offers changes while acting as someone; 403 without delegation.read, 404 across accounts", async () => {
    const { d, as } = world();
    const acting = { ...(as("owner") as Extract<Actor, { kind: "user" }>), actingAs: actAs(ACCOUNT_A) };
    expect((await delegationAvailability(d, acting, ACCOUNT_A)).canManage).toBe(false);
    await expect(delegationAvailability(d, as("kim"), ACCOUNT_A)).rejects.toThrow(ForbiddenError);
    await expect(delegationAvailability(d, as("owner-b"), ACCOUNT_A)).rejects.toThrow(NotFoundError);
    await expect(delegationAvailability(d, { kind: "anonymous" }, ACCOUNT_A)).rejects.toThrow(UnauthenticatedError);
  });
});

describe("cascade helpers", () => {
  it("dropOwnGrants removes only the new owner's own rights on the mailbox, one entry each", async () => {
    const { d, s, as, update } = world();
    await update(as("owner"), SHARED, {
      add: [add("kim", "full_access"), add("kim", "send_as"), add("lee", "full_access")],
    });
    const also = await d.uow.run((r) =>
      dropOwnGrants(r, ACCOUNT_A, { id: SHARED, address: "desk@family.test" }, "kim"),
    );
    expect(also.map((e) => [e.action, e.target.id, e.meta.right, e.meta.reason, e.meta.grantee])).toEqual([
      ["delegation.revoked", SHARED, "full_access", "became_owner", "k***@family.test"],
      ["delegation.revoked", SHARED, "send_as", "became_owner", "k***@family.test"],
    ]);
    expect(s.delegations.map((g) => g.granteeUserId)).toEqual(["lee"]);
    expect(await d.uow.run((r) => dropOwnGrants(r, ACCOUNT_A, { id: SHARED, address: "desk" }, "kim"))).toEqual([]);
  });

  it("dropPersonGrants can record in the account it happened in, and names a mailbox that is gone by blank", async () => {
    const { d, s, as, update } = world();
    await update(as("owner"), SHARED, { add: [add("kim", "full_access")] });
    s.mailboxes = s.mailboxes.filter((m) => m.id !== SHARED);
    const also = await d.uow.run((r) => dropPersonGrants(r, ACCOUNT_A, "kim", { accountScoped: true }));
    expect(also).toEqual([
      expect.objectContaining({ accountId: ACCOUNT_A, target: { type: "mailbox", id: SHARED, label: "" } }),
    ]);
    expect(await d.uow.run((r) => dropPersonGrants(r, ACCOUNT_A, "kim"))).toEqual([]);
  });
});
