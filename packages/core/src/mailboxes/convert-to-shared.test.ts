// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  actAs,
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
import type { Deps, UnitOfWork } from "../ports";
import { convertMailboxToShared } from "./convert-to-shared";
import type { Mailbox } from "./entity";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const KID = "aaaaaaaa-1111-4111-8111-000000000001";
const OWNERS = "aaaaaaaa-1111-4111-8111-000000000002";
const SHARED = "aaaaaaaa-1111-4111-8111-000000000003";
const NEW = "aaaaaaaa-1111-4111-8111-000000000004";
const GONE = "aaaaaaaa-1111-4111-8111-000000000005";
const SUSPENDED = "aaaaaaaa-1111-4111-8111-000000000006";
const IN_B = "bbbbbbbb-1111-4111-8111-000000000001";
const SESSION = "sess-1";

function setup(plan: "plus" | "free" = "plus") {
  const clock = fixedClock("2026-10-30T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["uadmin", ACCOUNT_A, "user_admin"],
    ["dadmin", ACCOUNT_A, "domain_admin"],
    ["member", ACCOUNT_A, "member"],
    ["boss", ACCOUNT_A, "member"],
    ["owner-b", ACCOUNT_B, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@family.ca`;
    s.userNames[userId] = userId;
  }
  const mailbox = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
    id,
    accountId,
    userId,
    address,
    status: "active",
    quotaBytes: 1024,
    stalwartId: `s-${id.slice(-2)}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
    mustChangePassword: true,
  });
  s.mailboxes.push(
    mailbox(KID, ACCOUNT_A, "kid@family.ca", "member"),
    mailbox(OWNERS, ACCOUNT_A, "mum@family.ca", "owner"),
    mailbox(SHARED, ACCOUNT_A, "desk@family.ca", null),
    { ...mailbox(NEW, ACCOUNT_A, "new@family.ca", "member"), status: "provisioning", stalwartId: null },
    { ...mailbox(GONE, ACCOUNT_A, "gone@family.ca", "member"), status: "deleting", purgeAfter: new Date(1e13) },
    { ...mailbox(SUSPENDED, ACCOUNT_A, "away@family.ca", "member"), status: "suspended" },
    mailbox(IN_B, ACCOUNT_B, "b@other.ca", "owner-b"),
  );
  for (const userId of ["owner", "uadmin", "dadmin", "member", "owner-b"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date(clock.now().getTime() + 60_000) });
  }
  return d;
}

const convert = (
  d: Deps,
  actor: Actor,
  input: unknown = {},
  {
    accountId = ACCOUNT_A,
    mailboxId = KID,
    sessionId = SESSION,
  }: { accountId?: string; mailboxId?: string; sessionId?: string | null } = {},
) => convertMailboxToShared(d, actor, accountId, mailboxId, input, { sessionId }, req, fakeHasher);

describe("convertMailboxToShared", () => {
  it("releases the person (new password nobody is shown, app passwords revoked) and keeps them in the account", async () => {
    const d = setup();
    const s = d.uow.state;
    s.appPasswords.push({
      id: "p1",
      accountId: ACCOUNT_A,
      mailboxId: KID,
      name: "Phone",
      protocols: ["imap"],
      credentialId: "c-1",
      credentialCreatedAt: new Date(0),
      createdAt: new Date(0),
      createdBy: "member",
      status: "active",
    });
    const out = await convert(d, userAdmin);
    expect(out.grants).toBe(0);
    expect(out.mailbox).toMatchObject({ id: KID, owner: null, status: "active" });
    const box = s.mailboxes.find((m) => m.id === KID);
    expect(box).toMatchObject({ userId: null, mustChangePassword: false });
    expect(s.memberships.some((m) => m.userId === "member")).toBe(true);
    expect(s.mailboxPasswords.find((p) => p.mailboxId === KID)).toMatchObject({
      pendingHash: expect.stringMatching(/^\$argon2id\$/) as unknown,
      grant: "grant-for-s-01",
    });
    expect(s.appPasswords.find((p) => p.id === "p1")?.status).toBe("revoking");
    expect(s.jobs.map((j) => [j.kind, j.subjectId])).toEqual([
      ["mailbox.password", KID],
      ["app_password.revoke", KID],
    ]);
    expect(s.audit.at(-1)).toMatchObject({
      action: "mailbox.converted_to_shared",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      target: { type: "mailbox", id: KID, label: "kid@family.ca" },
      meta: { formerUserId: "member", former: "m***@family.ca", appPasswordsRevoked: 1, grants: 0, status: "active" },
    });
    expect(JSON.stringify(s.audit)).not.toContain("argon2");
  });

  it("gives people read and manage, and send as, in the same step; the former person may be one of them", async () => {
    const d = setup();
    const s = d.uow.state;
    const out = await convert(d, owner, { fullAccessTo: ["boss", "member", "boss"], sendAs: true });
    expect(out.grants).toBe(4);
    expect(s.delegations.map((g) => [g.granteeUserId, g.right, g.grantedBy])).toEqual([
      ["boss", "full_access", "owner"],
      ["boss", "send_as", "owner"],
      ["member", "full_access", "owner"],
      ["member", "send_as", "owner"],
    ]);
    const entries = s.audit.filter((e) => e.action === "delegation.granted");
    expect(entries.map((e) => [e.meta.granteeUserId, e.meta.right, e.meta.reason])).toEqual([
      ["boss", "full_access", "converted_to_shared"],
      ["boss", "send_as", "converted_to_shared"],
      ["member", "full_access", "converted_to_shared"],
      ["member", "send_as", "converted_to_shared"],
    ]);
    expect(s.audit.find((e) => e.action === "mailbox.converted_to_shared")?.meta).toMatchObject({ grants: 4 });
  });

  it("a suspended mailbox converts too (its job applies the password, a resume waits for it)", async () => {
    const d = setup();
    await convert(d, owner, { fullAccessTo: ["boss"] }, { mailboxId: SUSPENDED });
    expect(d.uow.state.mailboxes.find((m) => m.id === SUSPENDED)?.userId).toBeNull();
    expect(d.uow.state.delegations.map((g) => g.right)).toEqual(["full_access"]);
  });

  it("guard rail 8: a User Admin can't convert an Owner's mailbox (403 audited); an Owner can, even their own", async () => {
    const d = setup();
    await expect(convert(d, userAdmin, {}, { mailboxId: OWNERS })).rejects.toThrow("Only an owner can convert");
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "forbidden" });
    expect(d.uow.state.mailboxes.find((m) => m.id === OWNERS)?.userId).toBe("owner");
    await convert(d, owner, { fullAccessTo: ["owner"] }, { mailboxId: OWNERS });
    expect(d.uow.state.delegations.map((g) => [g.mailboxId, g.granteeUserId])).toEqual([[OWNERS, "owner"]]);
  });

  it("needs mailbox.manage: 401 signed out, 403 for other roles, 404 across accounts and for unknown ids", async () => {
    const d = setup();
    await expect(convert(d, anonymous)).rejects.toThrow(UnauthenticatedError);
    await expect(convert(d, member)).rejects.toThrow(ForbiddenError);
    await expect(convert(d, domainAdmin)).rejects.toThrow(ForbiddenError);
    await expect(convert(d, ownerB)).rejects.toThrow(NotFoundError);
    await expect(convert(d, owner, {}, { mailboxId: IN_B })).rejects.toThrow(NotFoundError);
    await expect(convert(d, owner, {}, { mailboxId: "nope" })).rejects.toThrow(NotFoundError);
    await expect(convert(d, { kind: "system", name: "x" })).rejects.toThrow(ForbiddenError);
    expect(d.uow.state.mailboxes.find((m) => m.id === KID)?.userId).toBe("member");
    expect(d.uow.state.mailboxes.find((m) => m.id === IN_B)?.userId).toBe("owner-b");
  });

  it("is refused while acting as someone (403 act_as) and without a fresh step-up (403 step_up_required)", async () => {
    const d = setup();
    await expect(convert(d, { ...owner, actingAs: actAs(ACCOUNT_A) })).rejects.toThrow("acting as someone");
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "act_as" });
    await expect(convert(d, owner, {}, { sessionId: null })).rejects.toThrow(StepUpRequiredError);
    await expect(convert(d, owner, {}, { sessionId: "old" })).rejects.toThrow(StepUpRequiredError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "step_up_required" });
    expect(d.uow.state.mailboxes.find((m) => m.id === KID)?.userId).toBe("member");
  });

  it("refuses an already-shared, deleting or unready mailbox (409) and a malformed request (400)", async () => {
    const d = setup();
    await expect(convert(d, owner, {}, { mailboxId: SHARED })).rejects.toThrow("already a shared mailbox");
    await expect(convert(d, owner, {}, { mailboxId: GONE })).rejects.toThrow(ConflictError);
    await expect(convert(d, owner, {}, { mailboxId: NEW })).rejects.toThrow("still being set up");
    await expect(convert(d, owner, { fullAccessTo: "boss" })).rejects.toThrow(ValidationError);
    await expect(convert(d, owner, { sendAs: true, extra: 1 })).rejects.toThrow(ValidationError);
    expect(await convert(d, owner, null)).toMatchObject({ grants: 0 });
  });

  it("the grant part needs a plan with delegation and people in the account; a refusal changes nothing", async () => {
    const free = setup("free");
    await expect(convert(free, owner, { fullAccessTo: ["boss"] })).rejects.toThrow(PlanLimitError);
    expect(free.uow.state.mailboxes.find((m) => m.id === KID)?.userId).toBe("member");
    // Without people to give access to, a Free account's mailbox can still become shared.
    expect((await convert(free, owner)).grants).toBe(0);

    const d = setup();
    await expect(convert(d, owner, { fullAccessTo: ["owner-b"] })).rejects.toThrow(NotFoundError);
    expect(d.uow.state.mailboxes.find((m) => m.id === KID)?.userId).toBe("member");
    expect(d.uow.state.mailboxPasswords).toEqual([]);
    expect(d.uow.state.jobs).toEqual([]);
  });

  it("reads the mailbox under the account lock: a deletion that commits first is a 409 that writes nothing", async () => {
    const d = setup();
    const uow: UnitOfWork = {
      run: (fn) =>
        d.uow.run((r) =>
          fn({
            ...r,
            accounts: {
              ...r.accounts,
              lock: async (id) => {
                await r.accounts.lock(id);
                await r.mailboxes.transition(KID, ["active"], "deleting", new Date(1e13));
              },
            },
          }),
        ),
    };
    await expect(convert({ ...d, uow }, owner, { fullAccessTo: ["boss"] })).rejects.toThrow("being deleted");
    expect(d.uow.state.mailboxes.find((m) => m.id === KID)).toMatchObject({ userId: "member", status: "active" });
    expect(d.uow.state.delegations).toEqual([]);
    expect(d.uow.state.jobs).toEqual([]);
  });

  it("turns a lost race on the owner link into a conflict, with nothing half-done", async () => {
    const d = setup();
    const uow: UnitOfWork = {
      run: (fn) => d.uow.run((r) => fn({ ...r, mailboxes: { ...r.mailboxes, releaseOwner: async () => false } })),
    };
    const racing: Deps = { ...d, uow };
    await expect(convert(racing, owner)).rejects.toThrow("changed while you were working");
    expect(d.uow.state.jobs).toEqual([]);
  });
});
