// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, actAs, deps, req, user } from "../__tests__/helpers";
import { authorize, can } from "../actor";
import { AccountSuspendedError } from "../errors";
import type { Mailbox, MailboxStatus } from "../mailboxes/entity";
import { resumeMailbox } from "../mailboxes/service";
import { sessionRefusalFor } from "../security/service";
import {
  accountSuspensionNotice,
  liftAccountSuspension,
  liftPersonSuspension,
  parseSuspendInput,
  staffSuspensionView,
  suspendAccount,
  suspendPerson,
} from "./suspension";

const GA = user({ id: "ga", platform: ["global_admin"] });
const SESSION = { sessionId: "s-ga" };
const MISSING_ACCOUNT = "33333333-3333-4333-8333-333333333333";

const mb = (id: string, accountId: string, userId: string | null, status: MailboxStatus): Mailbox => ({
  id,
  accountId,
  userId,
  address: `${id}@a.test`,
  status,
  quotaBytes: 1,
  stalwartId: `st-${id}`,
  lastError: null,
  purgeAfter: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
});

const M_ACTIVE = "aaaaaaaa-0000-4000-8000-000000000001";
const M_OWN_SUSP = "aaaaaaaa-0000-4000-8000-000000000002";
const M_PERSON = "aaaaaaaa-0000-4000-8000-000000000003";
const M_DELETING = "aaaaaaaa-0000-4000-8000-000000000004";
const M_OTHER = "bbbbbbbb-0000-4000-8000-000000000001";

function world() {
  const d = deps();
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme", plan: "plus" }, { id: ACCOUNT_B, name: "Other", plan: "free" });
  s.memberships.push(
    { userId: "owner-a", accountId: ACCOUNT_A, role: "owner" },
    { userId: "admin-a", accountId: ACCOUNT_A, role: "user_admin" },
    { userId: "member-a", accountId: ACCOUNT_A, role: "member" },
    { userId: "member-a", accountId: ACCOUNT_B, role: "member" },
    { userId: "owner-b", accountId: ACCOUNT_B, role: "owner" },
  );
  for (const u of ["owner-a", "admin-a", "member-a", "owner-b", "ga", "staff-x"]) {
    s.userEmails[u] = `${u}@example.test`;
    s.userNames[u] = u;
  }
  s.platformRoles.push({ userId: "ga", role: "global_admin" }, { userId: "staff-x", role: "support_admin" });
  s.mailboxes.push(
    mb(M_ACTIVE, ACCOUNT_A, "owner-a", "active"),
    mb(M_OWN_SUSP, ACCOUNT_A, null, "suspended"),
    mb(M_PERSON, ACCOUNT_A, "member-a", "active"),
    mb(M_DELETING, ACCOUNT_A, null, "deleting"),
    mb(M_OTHER, ACCOUNT_B, "owner-b", "active"),
  );
  s.stepUps.push({ userId: "ga", sessionId: "s-ga", expiresAt: new Date("2026-10-21T12:05:00Z") });
  const now = new Date("2026-10-21T11:00:00Z");
  s.sessions.push(
    { id: "s-m1", userId: "member-a", createdAt: now, lastActiveAt: now, expiresAt: now, ip: null, userAgent: null },
    { id: "s-m2", userId: "member-a", createdAt: now, lastActiveAt: now, expiresAt: now, ip: null, userAgent: null },
  );
  return d;
}

const status = (d: ReturnType<typeof deps>, id: string) => d.uow.state.mailboxes.find((m) => m.id === id)?.status;

describe("parseSuspendInput", () => {
  it("needs a known reason; trims the note; empty note is null; long notes refused", () => {
    expect(() => parseSuspendInput({})).toThrow(/reason/);
    expect(() => parseSuspendInput({ reason: "toString" })).toThrow(/reason/);
    expect(parseSuspendInput({ reason: "spam", note: "  " })).toEqual({ reason: "spam", note: null });
    expect(parseSuspendInput({ reason: "abuse", note: " x " })).toEqual({ reason: "abuse", note: "x" });
    expect(() => parseSuspendInput({ reason: "spam", note: 5 })).toThrow(/text/);
    expect(() => parseSuspendInput({ reason: "spam", note: "x".repeat(1001) })).toThrow(/under/);
  });
});

describe("suspendAccount", () => {
  it("suspends the account and its usable mailboxes, records holds, audits both logs, notifies admins", async () => {
    const d = world();
    const out = await suspendAccount(d, GA, ACCOUNT_A, { reason: "spam", note: "ticket 42" }, SESSION, req);
    expect(out.mailboxes).toBe(2);
    expect(out.notify.map((n) => n.email).sort()).toEqual(["admin-a@example.test", "owner-a@example.test"]);
    const s = d.uow.state;
    expect(s.accounts.find((a) => a.id === ACCOUNT_A)?.status).toBe("suspended");
    expect(status(d, M_ACTIVE)).toBe("suspended");
    expect(status(d, M_PERSON)).toBe("suspended");
    expect(status(d, M_OWN_SUSP)).toBe("suspended");
    expect(status(d, M_DELETING)).toBe("deleting");
    expect(status(d, M_OTHER)).toBe("active");
    expect(s.mailboxHolds.map((h) => h.mailboxId).sort()).toEqual([M_ACTIVE, M_PERSON].sort());
    expect(s.jobs.filter((j) => j.kind === "mailbox.ensure")).toHaveLength(2);
    const accountEntry = s.audit.find((e) => e.scope === `account:${ACCOUNT_A}` && e.action === "trust.suspended");
    expect(accountEntry).toMatchObject({ result: "success", actor: { type: "staff", role: "global_admin" } });
    expect(JSON.stringify(accountEntry)).not.toContain("ticket 42");
    const platformEntry = s.audit.find((e) => e.scope === "platform" && e.action === "trust.suspended");
    expect(platformEntry?.meta).toMatchObject({ internalNote: "ticket 42", reasonCategory: "spam" });
  });

  it("is 403 without the permission (platform log only) and 404 for unknown accounts", async () => {
    const d = world();
    const support = user({ id: "staff-x", platform: ["support_admin"] });
    await expect(suspendAccount(d, support, ACCOUNT_A, { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
    await expect(suspendAccount(d, owner, ACCOUNT_A, { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(suspendAccount(d, GA, MISSING_ACCOUNT, { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(suspendAccount(d, GA, "nope", { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    const s = d.uow.state;
    expect(s.audit.filter((e) => e.result === "denied").every((e) => e.scope === "platform")).toBe(true);
    expect(s.audit.filter((e) => e.result === "denied")).toHaveLength(4);
    expect(s.accounts.find((a) => a.id === ACCOUNT_A)?.status).toBeUndefined();
  });

  it("needs a fresh step-up and is refused while acting as someone (both audited as denied)", async () => {
    const d = world();
    await expect(
      suspendAccount(d, GA, ACCOUNT_A, { reason: "spam" }, { sessionId: "other" }, req),
    ).rejects.toMatchObject({ code: "step_up_required" });
    await expect(suspendAccount(d, GA, ACCOUNT_A, { reason: "spam" }, { sessionId: null }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    const actingAs = {
      ...GA,
      actingAs: actAs(ACCOUNT_A, "global_admin"),
    };
    await expect(suspendAccount(d, actingAs, ACCOUNT_A, { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    const denied = d.uow.state.audit.filter((e) => e.result === "denied").map((e) => e.errorCode);
    expect(denied).toEqual(["step_up_required", "step_up_required", "act_as"]);
    expect(status(d, M_ACTIVE)).toBe("active");
  });

  it("refuses a missing reason (400, audited as failed) and a second suspension (409)", async () => {
    const d = world();
    await expect(suspendAccount(d, GA, ACCOUNT_A, {}, SESSION, req)).rejects.toMatchObject({ code: "bad_request" });
    await suspendAccount(d, GA, ACCOUNT_A, { reason: "legal" }, SESSION, req);
    await expect(suspendAccount(d, GA, ACCOUNT_A, { reason: "legal" }, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(d.uow.state.mailboxHolds).toHaveLength(2);
  });

  it("blocks every account permission for its members with 403 account_suspended, nothing else", async () => {
    const owner = { ...user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] }), suspendedAccountIds: [ACCOUNT_A] };
    expect(can(owner, "mailbox.read", ACCOUNT_A)).toBe(false);
    expect(() => {
      authorize(owner, "mailbox.manage", ACCOUNT_A);
    }).toThrow(AccountSuspendedError);
    expect(() => {
      authorize(owner, "mailbox.manage", ACCOUNT_B);
    }).toThrow(/not found/i);
    expect(can(owner, "self.security.manage")).toBe(true);
    const d = world();
    await suspendAccount(d, GA, ACCOUNT_A, { reason: "phishing" }, SESSION, req);
    await expect(resumeMailbox(d, owner, ACCOUNT_A, M_ACTIVE, req)).rejects.toMatchObject({
      code: "account_suspended",
    });
    const denied = d.uow.state.audit.find((e) => e.errorCode === "account_suspended");
    expect(denied?.scope).toBe(`account:${ACCOUNT_A}`);
  });

  it("shows members the reason category (never the note); others get 404", async () => {
    const d = world();
    await suspendAccount(d, GA, ACCOUNT_A, { reason: "payment", note: "secret" }, SESSION, req);
    const member = user({ id: "member-a", account: [[ACCOUNT_A, "member"]] });
    const notice = await accountSuspensionNotice(d, member, ACCOUNT_A);
    expect(notice).toMatchObject({ reason: "payment", reasonLabel: "A payment problem" });
    expect(JSON.stringify(notice)).not.toContain("secret");
    const outsider = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });
    await expect(accountSuspensionNotice(d, outsider, ACCOUNT_A)).rejects.toMatchObject({ code: "not_found" });
    expect(await accountSuspensionNotice(d, outsider, ACCOUNT_B)).toBeNull();
    const view = await staffSuspensionView(d, GA, ACCOUNT_A);
    expect(view.account?.note).toBe("secret");
    await expect(staffSuspensionView(d, member, ACCOUNT_A)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("liftAccountSuspension", () => {
  it("resumes only the mailboxes it suspended and reactivates the account", async () => {
    const d = world();
    await suspendAccount(d, GA, ACCOUNT_A, { reason: "spam" }, SESSION, req);
    const out = await liftAccountSuspension(d, GA, ACCOUNT_A, SESSION, req);
    expect(out.mailboxes).toBe(2);
    expect(out.notify).toHaveLength(2);
    expect(status(d, M_ACTIVE)).toBe("provisioning");
    expect(status(d, M_PERSON)).toBe("provisioning");
    expect(status(d, M_OWN_SUSP)).toBe("suspended"); // the account's own suspension stays
    expect(d.uow.state.accounts.find((a) => a.id === ACCOUNT_A)?.status).toBe("active");
    expect(d.uow.state.mailboxHolds).toEqual([]);
    await expect(liftAccountSuspension(d, GA, ACCOUNT_A, SESSION, req)).rejects.toMatchObject({ code: "conflict" });
  });

  it("is 404 for unknown accounts and needs step-up", async () => {
    const d = world();
    await expect(liftAccountSuspension(d, GA, MISSING_ACCOUNT, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await suspendAccount(d, GA, ACCOUNT_A, { reason: "spam" }, SESSION, req);
    await expect(liftAccountSuspension(d, GA, ACCOUNT_A, { sessionId: null }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
  });
});

describe("suspendPerson", () => {
  it("refuses sign-in, ends sessions, suspends their mailboxes in every account and audits each account", async () => {
    const d = world();
    const out = await suspendPerson(d, GA, "member-a", { reason: "abuse", note: "internal" }, SESSION, req);
    expect(out).toMatchObject({ email: "member-a@example.test", mailboxes: 1, sessionsRevoked: 2 });
    expect(status(d, M_PERSON)).toBe("suspended");
    expect(status(d, M_ACTIVE)).toBe("active");
    expect(d.uow.state.suspended).toContain("member-a");
    expect(await d.uow.run((r) => sessionRefusalFor(r, "member-a", "password"))).toMatch(/support@anhourtec\.com/);
    const scopes = d.uow.state.audit.filter((e) => e.action === "trust.suspended").map((e) => e.scope);
    expect(scopes.sort()).toEqual([`account:${ACCOUNT_A}`, `account:${ACCOUNT_B}`, "platform"].sort());
    const accountEntries = d.uow.state.audit.filter((e) => e.scope !== "platform");
    expect(JSON.stringify(accountEntries)).not.toContain("internal");
    expect(JSON.stringify(d.uow.state.audit)).not.toContain("member-a@example.test");
  });

  it("refuses staff, yourself, unknown people and missing step-up", async () => {
    const d = world();
    await expect(suspendPerson(d, GA, "staff-x", { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(suspendPerson(d, GA, "ga", { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(suspendPerson(d, GA, "nobody", { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(suspendPerson(d, GA, "member-a", { reason: "spam" }, { sessionId: null }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    const support = user({ id: "staff-x", platform: ["support_admin"] });
    await expect(suspendPerson(d, support, "member-a", { reason: "spam" }, SESSION, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(d.uow.state.suspended).toEqual([]);
    const codes = d.uow.state.audit.filter((e) => e.result === "denied").map((e) => e.errorCode);
    expect(codes).toEqual(["staff", "self", "not_found", "step_up_required", "forbidden"]);
  });

  it("a mailbox held by both suspensions resumes only when both are lifted; customers can't resume it", async () => {
    const d = world();
    await suspendPerson(d, GA, "member-a", { reason: "spam" }, SESSION, req);
    await suspendAccount(d, GA, ACCOUNT_A, { reason: "spam" }, SESSION, req);
    expect(d.uow.state.mailboxHolds.filter((h) => h.mailboxId === M_PERSON).map((h) => h.kind)).toEqual([
      "person",
      "account",
    ]);
    await liftAccountSuspension(d, GA, ACCOUNT_A, SESSION, req);
    expect(status(d, M_PERSON)).toBe("suspended");
    expect(status(d, M_ACTIVE)).toBe("provisioning");
    const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
    await expect(resumeMailbox(d, owner, ACCOUNT_A, M_PERSON, req)).rejects.toThrow(/Anhourtec suspended/);
    const lifted = await liftPersonSuspension(d, GA, "member-a", SESSION, req);
    expect(lifted.mailboxes).toBe(1);
    expect(status(d, M_PERSON)).toBe("provisioning");
    expect(d.uow.state.suspended).toEqual([]);
    expect(await d.uow.run((r) => sessionRefusalFor(r, "member-a", "password"))).toBeNull();
    await expect(liftPersonSuspension(d, GA, "member-a", SESSION, req)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a mailbox the account suspended itself can't be resumed while its person is suspended", async () => {
    const d = world();
    const own = d.uow.state.mailboxes.find((m) => m.id === M_PERSON);
    if (!own) throw new Error("fixture");
    own.status = "suspended";
    await suspendPerson(d, GA, "member-a", { reason: "spam" }, SESSION, req);
    expect(d.uow.state.mailboxHolds.filter((h) => h.mailboxId === M_PERSON)).toEqual([]);
    const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
    await expect(resumeMailbox(d, owner, ACCOUNT_A, M_PERSON, req)).rejects.toThrow(/Anhourtec suspended/);
    await liftPersonSuspension(d, GA, "member-a", SESSION, req);
    expect(status(d, M_PERSON)).toBe("suspended");
    await resumeMailbox(d, owner, ACCOUNT_A, M_PERSON, req);
    expect(status(d, M_PERSON)).toBe("provisioning");
  });

  it("lifting a person's suspension doesn't resume a mailbox the account deleted meanwhile", async () => {
    const d = world();
    await suspendPerson(d, GA, "member-a", { reason: "spam" }, SESSION, req);
    const m = d.uow.state.mailboxes.find((x) => x.id === M_PERSON);
    if (m) m.status = "deleting";
    const out = await liftPersonSuspension(d, GA, "member-a", SESSION, req);
    expect(out.mailboxes).toBe(0);
    expect(status(d, M_PERSON)).toBe("deleting");
  });
});
