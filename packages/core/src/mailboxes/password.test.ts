// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_A,
  ACCOUNT_B,
  actAs,
  anonymous,
  BREACHED_PW,
  deps as makeDeps,
  fakeBreaches,
  fakeHasher,
  fixedClock,
  MAILBOX_PW,
  req,
  user,
} from "../__tests__/helpers";
import type { UserActor } from "../actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PasswordChangePendingError,
  StepUpRequiredError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import type { Mailbox } from "./entity";
import {
  changeOwnMailboxPassword,
  consoleResetHeld,
  lastPasswordChangeFailed,
  passwordJobState,
  resetMailboxPassword,
} from "./password";
import { hashMailboxPassword, mailboxPassword } from "./password-hash";
import { getMailbox } from "./service";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const auditor = user({ id: "auditor", account: [[ACCOUNT_A, "auditor"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const SESSION = "sess-1";
const MBX_MEMBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MBX_OWNER = "abababab-abab-4bab-8bab-abababababab";
const MBX_NEW = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const MBX_GONE = "efefefef-efef-4fef-8fef-efefefefefef";
const MBX_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** The job's worker gave up on it (as `runNextJob` does after the last attempt): claimed, then given up. */
async function giveUpJob(d: ReturnType<typeof setup>["d"], jobId: string): Promise<void> {
  const job = d.uow.state.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error("job expected");
  Object.assign(job, { status: "running", lockToken: "claim-1", lockedAt: d.clock.now() });
  expect(
    await d.uow.run((r) =>
      r.provisioning.giveUp({ id: jobId, lockToken: "claim-1" }, "mail server unavailable", new Date()),
    ),
  ).toBe(true);
}

function setup() {
  const clock = fixedClock("2026-10-23T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["uadmin", ACCOUNT_A, "user_admin"],
    ["dadmin", ACCOUNT_A, "domain_admin"],
    ["member", ACCOUNT_A, "member"],
    ["auditor", ACCOUNT_A, "auditor"],
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
  });
  s.mailboxes.push(
    mailbox(MBX_MEMBER, ACCOUNT_A, "kid@family.ca", "member"),
    mailbox(MBX_OWNER, ACCOUNT_A, "mum@family.ca", "owner"),
    { ...mailbox(MBX_NEW, ACCOUNT_A, "new@family.ca", null), status: "provisioning", stalwartId: null },
    { ...mailbox(MBX_GONE, ACCOUNT_A, "gone@family.ca", null), status: "deleting", purgeAfter: new Date(1e13) },
    mailbox(MBX_B, ACCOUNT_B, "b@other.ca", "owner-b"),
  );
  for (const userId of ["owner", "uadmin", "dadmin", "member", "owner-b"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date(clock.now().getTime() + 60_000) });
  }
  return { d, clock };
}

const reset = (
  d: ReturnType<typeof setup>["d"],
  actor: Parameters<typeof resetMailboxPassword>[2],
  accountId: string,
  mailboxId: string,
  password: unknown = MAILBOX_PW,
  sessionId: string | null = SESSION,
) => resetMailboxPassword(d, fakeHasher, actor, accountId, mailboxId, { password }, { sessionId }, req);

describe("mailbox password rules", () => {
  it("accepts a good password and refuses the ones that would break sign-in", () => {
    expect(mailboxPassword(MAILBOX_PW, "kid@family.ca")).toBe(MAILBOX_PW);
    for (const bad of [
      null,
      42,
      "",
      "elevenchars",
      "x".repeat(129),
      " padded-password ",
      "APP_lookalike-pass",
      "kid",
    ]) {
      expect(() => mailboxPassword(bad, "kid@family.ca")).toThrow(ValidationError);
    }
    expect(() => mailboxPassword("KID@family.ca", "kid@family.ca")).toThrow(ValidationError);
    expect(() => mailboxPassword(`bell\u0007-password-x`, "kid@family.ca")).toThrow(ValidationError);
  });

  it("only ever hands on an argon2id PHC string", async () => {
    await expect(hashMailboxPassword({ hash: async () => "$2b$10$bcrypt" }, MAILBOX_PW)).rejects.toThrow(/argon2id/);
    expect(await hashMailboxPassword(fakeHasher, MAILBOX_PW)).toMatch(/^\$argon2id\$/);
  });
});

describe("resetting a mailbox password (admins)", () => {
  it("lets an Owner set a member's password: hash queued for the worker, owner returned to notify, audited", async () => {
    const { d } = setup();
    const out = await reset(d, owner, ACCOUNT_A, MBX_MEMBER);
    expect(out).toMatchObject({ address: "kid@family.ca", owner: { userId: "member", email: "member@example.ca" } });
    expect(d.uow.state.jobs).toEqual([
      expect.objectContaining({ id: out.jobId, kind: "mailbox.password", subjectId: MBX_MEMBER }),
    ]);
    expect(d.uow.state.mailboxPasswords).toEqual([
      {
        mailboxId: MBX_MEMBER,
        pendingHash: await fakeHasher.hash(MAILBOX_PW),
        credentialId: null,
        // Bound to this account by the web app's key (the worker can't make one).
        grant: "grant-for-s-dddd",
      },
    ]);
    const entry = d.uow.state.audit.at(-1);
    expect(entry).toMatchObject({
      action: "mailbox.password_reset",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      target: { type: "mailbox", id: MBX_MEMBER, label: "kid@family.ca" },
      meta: { ownMailbox: false, owner: "m***@example.ca", status: "active" },
    });
    expect(JSON.stringify(d.uow.state.audit)).not.toContain(MAILBOX_PW);
    expect(JSON.stringify(d.uow.state.audit)).not.toContain("argon2id");
    expect(JSON.stringify(d.uow.state)).not.toContain(MAILBOX_PW);
    expect((await getMailbox(d, owner, ACCOUNT_A, MBX_MEMBER)).passwordPending).toBe(true);
  });

  it("lets a User Admin reset a member's or an unassigned mailbox, but not an Owner's (403, audited)", async () => {
    const { d } = setup();
    await expect(reset(d, userAdmin, ACCOUNT_A, MBX_MEMBER)).resolves.toMatchObject({ address: "kid@family.ca" });
    await expect(reset(d, userAdmin, ACCOUNT_A, MBX_OWNER)).rejects.toThrow(ForbiddenError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "mailbox.password_reset",
      result: "denied",
      errorCode: "forbidden",
    });
    expect(d.uow.state.mailboxPasswords.some((p) => p.mailboxId === MBX_OWNER)).toBe(false);
    expect((await getMailbox(d, userAdmin, ACCOUNT_A, MBX_OWNER)).canSetPassword).toBe(false);
    expect((await getMailbox(d, userAdmin, ACCOUNT_A, MBX_MEMBER)).canSetPassword).toBe(true);
  });

  it("refuses roles without the permission (403) and other accounts' mailboxes (404), audited", async () => {
    const { d } = setup();
    for (const actor of [domainAdmin, member, auditor]) {
      await expect(reset(d, actor, ACCOUNT_A, MBX_MEMBER)).rejects.toThrow(ForbiddenError);
    }
    await expect(reset(d, ownerB, ACCOUNT_A, MBX_MEMBER)).rejects.toThrow(NotFoundError);
    await expect(reset(d, owner, ACCOUNT_A, MBX_B)).rejects.toThrow(NotFoundError);
    await expect(reset(d, owner, ACCOUNT_A, "not-an-id")).rejects.toThrow(NotFoundError);
    await expect(reset(d, anonymous, ACCOUNT_A, MBX_MEMBER)).rejects.toThrow(UnauthenticatedError);
    await expect(reset(d, { kind: "system", name: "x" }, ACCOUNT_A, MBX_MEMBER)).rejects.toThrow(ForbiddenError);
    expect(d.uow.state.jobs).toHaveLength(0);
    expect(d.uow.state.mailboxPasswords).toHaveLength(0);
    const denied = d.uow.state.audit.filter((e) => e.action === "mailbox.password_reset" && e.result === "denied");
    expect(denied).toHaveLength(5);
    expect(denied.some((e) => e.scope === "platform")).toBe(true); // the cross-account probe
    expect((await getMailbox(d, domainAdmin, ACCOUNT_A, MBX_MEMBER)).canSetPassword).toBe(false);
  });

  it("needs a fresh step-up on this console session", async () => {
    const { d, clock } = setup();
    await expect(reset(d, owner, ACCOUNT_A, MBX_MEMBER, MAILBOX_PW, null)).rejects.toThrow(StepUpRequiredError);
    await expect(reset(d, owner, ACCOUNT_A, MBX_MEMBER, MAILBOX_PW, "other-session")).rejects.toThrow(
      StepUpRequiredError,
    );
    clock.set(new Date(clock.now().getTime() + 120_000));
    await expect(reset(d, owner, ACCOUNT_A, MBX_MEMBER)).rejects.toThrow(StepUpRequiredError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "step_up_required" });
    expect(d.uow.state.jobs).toHaveLength(0);
  });

  it("checks the password before asking for a step-up, and refuses a weak one", async () => {
    const { d } = setup();
    await expect(reset(d, owner, ACCOUNT_A, MBX_MEMBER, "short", null)).rejects.toThrow(ValidationError);
    await expect(reset(d, owner, ACCOUNT_A, MBX_MEMBER, "kid@family.ca")).rejects.toThrow(ValidationError);
    expect(d.uow.state.jobs).toHaveLength(0);
  });

  it("is refused while staff act as the person (audited as denied)", async () => {
    const { d } = setup();
    const actingAs: UserActor = {
      ...owner,
      actingAs: actAs(ACCOUNT_A, "support_admin"),
    };
    await expect(reset(d, actingAs, ACCOUNT_A, MBX_MEMBER)).rejects.toThrow(ForbiddenError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "denied", errorCode: "act_as" });
    expect((await getMailbox(d, actingAs, ACCOUNT_A, MBX_MEMBER)).canSetPassword).toBe(false);
  });

  it("refuses a mailbox that isn't on the mail server yet or is being deleted (409)", async () => {
    const { d } = setup();
    await expect(reset(d, owner, ACCOUNT_A, MBX_NEW)).rejects.toThrow(ConflictError);
    await expect(reset(d, owner, ACCOUNT_A, MBX_GONE)).rejects.toThrow(ConflictError);
  });

  it("works on a suspended mailbox (it stays suspended) and replaces a password still waiting", async () => {
    const { d } = setup();
    d.uow.state.mailboxes.find((m) => m.id === MBX_MEMBER)!.status = "suspended";
    await reset(d, owner, ACCOUNT_A, MBX_MEMBER, "first password here");
    await reset(d, owner, ACCOUNT_A, MBX_MEMBER, "second password here");
    expect(d.uow.state.mailboxPasswords).toEqual([
      {
        mailboxId: MBX_MEMBER,
        pendingHash: await fakeHasher.hash("second password here"),
        credentialId: null,
        grant: "grant-for-s-dddd",
      },
    ]);
    expect(d.uow.state.jobs.filter((j) => j.kind === "mailbox.password")).toHaveLength(1); // queued job reused
    expect(d.uow.state.mailboxes.find((m) => m.id === MBX_MEMBER)?.status).toBe("suspended");
  });

  it("shows the console when the password it set never reached the mail server, until it is set again", async () => {
    const { d } = setup();
    const view = () => getMailbox(d, owner, ACCOUNT_A, MBX_MEMBER);
    expect(await view()).toMatchObject({ passwordPending: false, passwordApplyFailed: false });
    const { jobId } = await reset(d, owner, ACCOUNT_A, MBX_MEMBER);
    expect(await view()).toMatchObject({ passwordPending: true, passwordApplyFailed: false });
    await giveUpJob(d, jobId); // hash kept
    expect(await view()).toMatchObject({ passwordPending: false, passwordApplyFailed: true });
    await reset(d, owner, ACCOUNT_A, MBX_MEMBER, "another new password");
    expect(await view()).toMatchObject({ passwordPending: true, passwordApplyFailed: false });
  });

  it("an owner may set their own mailbox's password (recorded as their own)", async () => {
    const { d } = setup();
    const out = await reset(d, owner, ACCOUNT_A, MBX_OWNER);
    expect(out.owner?.userId).toBe("owner");
    expect(d.uow.state.audit.at(-1)).toMatchObject({ meta: { ownMailbox: true } });
  });
});

describe("changing one's own mailbox password (webmail)", () => {
  it("queues the new hash as the mailbox itself and audits it in the account's log", async () => {
    const { d } = setup();
    const out = await changeOwnMailboxPassword(d, fakeHasher, " KID@family.ca ", { password: MAILBOX_PW }, req);
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ id: out.jobId, kind: "mailbox.password" })]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "mailbox.password_changed",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      actor: { type: "system", email: "kid@family.ca" },
      target: { id: MBX_MEMBER },
    });
    expect(JSON.stringify(d.uow.state.audit)).not.toContain(MAILBOX_PW);
    expect(await passwordJobState(d, out.jobId)).toBe("pending");
  });

  it("leaves the first-sign-in password step in force until the worker has applied the new password", async () => {
    const { d } = setup();
    const box = d.uow.state.mailboxes.find((m) => m.id === MBX_MEMBER);
    if (box) box.mustChangePassword = true;
    await changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req);
    expect((await d.uow.run((r) => r.webmailSettings.mailboxByAddress("kid@family.ca")))?.mustChangePassword).toBe(
      true,
    );
    // Marked as the person's own, so the worker's success ends the step (provisioning.test.ts).
    expect(await d.uow.run((r) => r.directory.getMailbox(MBX_MEMBER))).toMatchObject({ pendingPasswordByOwner: true });
  });

  it("tells the first-sign-in step when the last password job gave up", async () => {
    const { d } = setup();
    expect(await lastPasswordChangeFailed(d, "kid@family.ca")).toBe(false); // none yet
    const { jobId } = await changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req);
    expect(await lastPasswordChangeFailed(d, " Kid@Family.ca ")).toBe(false); // waiting
    await giveUpJob(d, jobId);
    expect(await lastPasswordChangeFailed(d, "kid@family.ca")).toBe(true);
    expect(await passwordJobState(d, jobId)).toBe("failed");
    // A new attempt replaces the answer; other mailboxes and unknown addresses are unaffected.
    await changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req);
    expect(await lastPasswordChangeFailed(d, "kid@family.ca")).toBe(false);
    expect(await lastPasswordChangeFailed(d, "mum@family.ca")).toBe(false);
    expect(await lastPasswordChangeFailed(d, "nobody@family.ca")).toBe(false);
  });

  it("is refused (409, audited as denied) while an administrator's password is waiting or never applied", async () => {
    const { d } = setup();
    const { jobId } = await reset(d, owner, ACCOUNT_A, MBX_MEMBER, "the admin's new one");
    const before = d.uow.state.audit.length;
    const attempt = changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req);
    await expect(attempt).rejects.toThrow(PasswordChangePendingError);
    await expect(
      changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req),
    ).rejects.toMatchObject({ code: "password_change_pending" });
    expect(d.uow.state.audit.slice(before)[0]).toMatchObject({
      action: "mailbox.password_changed",
      result: "denied",
      target: { id: MBX_MEMBER },
    });
    // The administrator's password is untouched (not overwritten, not marked as the person's own).
    expect(await d.uow.run((r) => r.directory.getMailbox(MBX_MEMBER))).toMatchObject({
      pendingPasswordHash: await fakeHasher.hash("the admin's new one"),
      pendingPasswordByOwner: false,
    });
    // Gave up: still refused (the hash is kept), and the first-sign-in step doesn't blame the person's change.
    await giveUpJob(d, jobId);
    await expect(
      changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req),
    ).rejects.toThrow(PasswordChangePendingError);
    expect(await lastPasswordChangeFailed(d, "kid@family.ca")).toBe(false);
    // Once it is on the mail server, the person may change it.
    await d.uow.run((r) => r.directory.passwordApplied(MBX_MEMBER, null, "cred"));
    await d.uow.run((r) => r.directory.clearPendingPassword(MBX_MEMBER));
    await expect(
      changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req),
    ).resolves.toMatchObject({ ownerEmail: "member@example.ca" });
  });

  it("refuses unknown addresses, inactive mailboxes and weak passwords", async () => {
    const { d } = setup();
    await expect(
      changeOwnMailboxPassword(d, fakeHasher, "nobody@family.ca", { password: MAILBOX_PW }, req),
    ).rejects.toThrow(NotFoundError);
    await expect(
      changeOwnMailboxPassword(d, fakeHasher, "new@family.ca", { password: MAILBOX_PW }, req),
    ).rejects.toThrow(ConflictError);
    await expect(changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: "kid" }, req)).rejects.toThrow(
      ValidationError,
    );
    expect(d.uow.state.jobs).toHaveLength(0);
  });
});

describe("breached mailbox passwords", () => {
  const screened = (breaches: ReturnType<typeof fakeBreaches>) => ({ ...fakeHasher, breaches });

  it("an admin reset refuses a breached password (400 password_breached, audited as failed) and queues nothing", async () => {
    const { d } = setup();
    const breaches = fakeBreaches([BREACHED_PW]);
    const call = (password: string) =>
      resetMailboxPassword(
        d,
        screened(breaches),
        owner,
        ACCOUNT_A,
        MBX_MEMBER,
        { password },
        { sessionId: SESSION },
        req,
      );
    await expect(call(BREACHED_PW)).rejects.toMatchObject({
      code: "password_breached",
      message: "This password has appeared in a data breach. Choose a different one.",
    });
    expect(d.uow.state.jobs).toHaveLength(0);
    expect(d.uow.state.mailboxPasswords).toHaveLength(0);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "failed", errorCode: "password_breached" });
    expect(JSON.stringify(d.uow.state.audit)).not.toContain(BREACHED_PW);
    await expect(call(MAILBOX_PW)).resolves.toMatchObject({ address: "kid@family.ca" });
  });

  it("the rules come first: a short password gets the length message even if it is breached", async () => {
    const { d } = setup();
    const breaches = fakeBreaches(["short"]);
    await expect(
      resetMailboxPassword(
        d,
        screened(breaches),
        owner,
        ACCOUNT_A,
        MBX_MEMBER,
        { password: "short" },
        { sessionId: SESSION },
        req,
      ),
    ).rejects.toThrow(/at least 12/);
  });

  it("never asks the check for someone without the permission (403) and still answers 404 out of scope", async () => {
    const { d } = setup();
    const breaches = fakeBreaches([BREACHED_PW]);
    const call = (actor: UserActor, mailboxId: string) =>
      resetMailboxPassword(
        d,
        screened(breaches),
        actor,
        ACCOUNT_A,
        mailboxId,
        { password: BREACHED_PW },
        { sessionId: SESSION },
        req,
      );
    await expect(call(member, MBX_MEMBER)).rejects.toThrow(ForbiddenError);
    await expect(call(ownerB, MBX_MEMBER)).rejects.toThrow(NotFoundError);
    expect(breaches.asked).toEqual([]);
  });

  it("fails open: the check unavailable (unknown) lets the password through", async () => {
    const { d } = setup();
    const breaches = fakeBreaches([BREACHED_PW], "unknown");
    await expect(
      resetMailboxPassword(
        d,
        screened(breaches),
        owner,
        ACCOUNT_A,
        MBX_MEMBER,
        { password: BREACHED_PW },
        { sessionId: SESSION },
        req,
      ),
    ).resolves.toMatchObject({ address: "kid@family.ca" });
    expect(breaches.asked).toEqual([BREACHED_PW]);
  });

  it("the webmail's own change refuses a breached password and accepts a clean one", async () => {
    const { d } = setup();
    const hasher = screened(fakeBreaches([BREACHED_PW]));
    await expect(
      changeOwnMailboxPassword(d, hasher, "kid@family.ca", { password: BREACHED_PW }, req),
    ).rejects.toMatchObject({ code: "password_breached" });
    expect(d.uow.state.jobs).toHaveLength(0);
    await expect(
      changeOwnMailboxPassword(d, hasher, "kid@family.ca", { password: MAILBOX_PW }, req),
    ).resolves.toBeTruthy();
  });
});

describe("console password reset for a mailbox's login", () => {
  it("is held while the mailbox's first-sign-in change is required or an administrator's password is waiting", async () => {
    const { d } = setup();
    expect(await consoleResetHeld(d, "kid@family.ca")).toBe(false);
    expect(await consoleResetHeld(d, "someone@elsewhere.ca")).toBe(false); // not a mailbox here
    d.uow.state.mailboxes.find((m) => m.id === MBX_MEMBER)!.mustChangePassword = true;
    expect(await consoleResetHeld(d, " KID@family.ca ")).toBe(true);
    d.uow.state.mailboxes.find((m) => m.id === MBX_MEMBER)!.mustChangePassword = false;
    await reset(d, owner, ACCOUNT_A, MBX_MEMBER);
    expect(await consoleResetHeld(d, "kid@family.ca")).toBe(true);
    // The person's own change waiting is not a reason (it is their password).
    await d.uow.run((r) => r.directory.clearPendingPassword(MBX_MEMBER));
    await changeOwnMailboxPassword(d, fakeHasher, "kid@family.ca", { password: MAILBOX_PW }, req);
    expect(await consoleResetHeld(d, "kid@family.ca")).toBe(false);
  });
});

describe("password job state", () => {
  it("reports pending, applied and failed, and treats unknown or other jobs as failed", async () => {
    const { d } = setup();
    const { jobId } = await reset(d, owner, ACCOUNT_A, MBX_MEMBER);
    expect(await passwordJobState(d, jobId)).toBe("pending");
    d.uow.state.jobs[0]!.status = "succeeded";
    expect(await passwordJobState(d, jobId)).toBe("applied");
    d.uow.state.jobs[0]!.status = "failed";
    expect(await passwordJobState(d, jobId)).toBe("failed");
    expect(await passwordJobState(d, "nope")).toBe("failed");
    d.uow.state.jobs[0]!.kind = "mailbox.ensure";
    expect(await passwordJobState(d, jobId)).toBe("failed");
  });
});
