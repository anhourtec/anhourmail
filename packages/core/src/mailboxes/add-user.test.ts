// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { MAX_PEOPLE } from "@anhourmail/shared/plans";
import { GENERATED_MAILBOX_PASSWORD } from "@anhourmail/shared/security";

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
import type { Actor } from "../actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import type { Deps } from "../ports";
import { BreachedPasswordError } from "../security/breached-passwords";
import { addUser, type AddUserInput } from "./add-user";
import { renameMailbox } from "./service";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const DOMAIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOMAIN_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const loginHashes: string[] = [];
const hashLogin = async (pw: string) => {
  loginHashes.push(pw);
  return `$argon2id$console$${String(pw.length)}`;
};

function setup(plan: "plus" | "free" = "plus") {
  const d = makeDeps(fixedClock("2026-10-24T12:00:00Z"));
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
  for (const [id, accountId, name] of [
    [DOMAIN_A, ACCOUNT_A, "family.ca"],
    [DOMAIN_B, ACCOUNT_B, "other.ca"],
  ] as const) {
    s.domains.push({
      id,
      accountId,
      name,
      status: "active",
      verifyToken: "t",
      stalwartId: null,
      lastError: null,
      createdAt: new Date(0),
    });
  }
  return d;
}

const base: AddUserInput = {
  firstName: "Jane",
  lastName: "Doe",
  displayName: "Jane Doe",
  localPart: "Jane",
  domainId: DOMAIN_A,
};

const add = (d: Deps, actor: Actor, input: AddUserInput = {}, accountId = ACCOUNT_A) =>
  addUser(d, actor, accountId, { ...base, ...input }, req, fakeHasher, hashLogin);

describe("addUser", () => {
  it("creates the mailbox, the person, the Member membership and the owner link in one audited step", async () => {
    const d = setup();
    const s = d.uow.state;
    const out = await add(d, owner, { profile: { jobTitle: "Editor", country: "CA" } });

    expect(out.role).toBe("member");
    expect(out.requirePasswordChange).toBe(true);
    expect(out.password).toHaveLength(GENERATED_MAILBOX_PASSWORD.length);
    expect(out.mailbox).toMatchObject({ address: "jane@family.ca", status: "provisioning" });
    expect(out.mailbox.owner).toEqual({ userId: out.userId, email: "jane@family.ca", name: "Jane Doe" });
    // The mailbox follows the person's name (no custom display name): one source (rule 61).
    expect(out.mailbox).toMatchObject({ displayName: null, senderName: "Jane Doe", nameSource: "person" });

    expect(s.userEmails[out.userId]).toBe("jane@family.ca");
    expect(s.userNames[out.userId]).toBe("Jane Doe");
    expect(s.memberships).toContainEqual(
      expect.objectContaining({ userId: out.userId, accountId: ACCOUNT_A, role: "member" }),
    );
    expect(s.mustChangePassword).toContain(out.userId);
    expect(s.profiles[out.userId]).toEqual({ jobTitle: "Editor", country: "CA" });
    const box = s.mailboxes.find((m) => m.address === "jane@family.ca");
    expect(box).toMatchObject({ userId: out.userId, displayName: null, mustChangePassword: true });
    // Only hashes are kept: the console's (identity adapter) and the mailbox's (for the worker).
    expect(s.logins.find((l) => l.userId === out.userId)?.passwordHash).toMatch(/^\$argon2id\$console\$/);
    expect(s.mailboxPasswords.find((p) => p.mailboxId === box?.id)?.pendingHash).toMatch(/^\$argon2id\$/);
    expect(s.jobs.at(-1)).toMatchObject({ kind: "mailbox.ensure", subjectId: box?.id });

    const entry = s.audit.at(-1);
    expect(entry).toMatchObject({
      action: "account.user_added",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      target: { type: "mailbox", id: box?.id, label: "jane@family.ca" },
      meta: {
        role: "member",
        passwordGenerated: true,
        requirePasswordChange: true,
        profileFields: ["jobTitle", "country"],
      },
    });
    // Neither the password nor the profile values reach the audit log.
    const json = JSON.stringify(s.audit);
    expect(json).not.toContain(out.password ?? "-");
    expect(json).not.toContain("Editor");
  });

  it("takes the admin's own password, without the first-sign-in change when asked", async () => {
    const d = setup();
    const out = await add(d, userAdmin, {
      generatePassword: false,
      password: MAILBOX_PW,
      requirePasswordChange: false,
      quotaGb: 2,
    });
    expect(out.password).toBeNull();
    expect(out.requirePasswordChange).toBe(false);
    expect(out.mailbox.quotaBytes).toBe(2 * 1024 ** 3);
    expect(d.uow.state.mustChangePassword).not.toContain(out.userId);
    expect(loginHashes.at(-1)).toBe(MAILBOX_PW);
  });

  it("refuses a weak, breached or address-like chosen password", async () => {
    const d = setup();
    await expect(add(d, owner, { generatePassword: false, password: "short" })).rejects.toThrow(ValidationError);
    await expect(add(d, owner, { generatePassword: false, password: "jane@family.ca" })).rejects.toThrow(
      ValidationError,
    );
    const breachDeps = { ...fakeHasher, breaches: fakeBreaches([BREACHED_PW]) };
    await expect(
      addUser(
        d,
        owner,
        ACCOUNT_A,
        { ...base, generatePassword: false, password: BREACHED_PW },
        req,
        breachDeps,
        hashLogin,
      ),
    ).rejects.toThrow(BreachedPasswordError);
    expect(d.uow.state.mailboxes).toEqual([]);
  });

  it("lets an Owner grant any role, a User Administrator only Member (403, audited as denied)", async () => {
    const d = setup();
    expect((await add(d, owner, { role: "user_admin" })).role).toBe("user_admin");
    await expect(add(d, userAdmin, { localPart: "kim", role: "owner" })).rejects.toThrow(ForbiddenError);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "account.user_added", result: "denied" });
    expect(d.uow.state.mailboxes.map((m) => m.address)).toEqual(["jane@family.ca"]);
    await expect(add(d, owner, { localPart: "kim", role: "emperor" })).rejects.toThrow(ValidationError);
  });

  it("needs mailbox.manage: 401 signed out, 403 for other roles, 404 for another account", async () => {
    const d = setup();
    await expect(add(d, anonymous)).rejects.toThrow(UnauthenticatedError);
    await expect(add(d, member)).rejects.toThrow(ForbiddenError);
    await expect(add(d, domainAdmin)).rejects.toThrow(ForbiddenError);
    await expect(add(d, ownerB)).rejects.toThrow(NotFoundError);
    // Another account's domain is not one of yours.
    await expect(add(d, owner, { domainId: DOMAIN_B })).rejects.toThrow(ValidationError);
    expect(d.uow.state.mailboxes).toEqual([]);
    expect(d.uow.state.audit.filter((e) => e.result === "denied").length).toBeGreaterThanOrEqual(3);
  });

  it("refuses names, a taken address, an existing login, act-as and plans without people", async () => {
    const d = setup();
    await expect(add(d, owner, { firstName: "" })).rejects.toThrow(ValidationError);
    await expect(add(d, owner, { displayName: "" })).rejects.toThrow(ValidationError);
    await expect(add(d, owner, { displayName: "see example.com" })).rejects.toThrow(ValidationError);
    await expect(add(d, owner, { profile: { country: "Nowhere" } })).rejects.toThrow(ValidationError);
    await add(d, owner);
    await expect(add(d, owner)).rejects.toThrow(ConflictError);
    d.uow.state.userEmails.someone = "kim@family.ca";
    await expect(add(d, owner, { localPart: "kim" })).rejects.toThrow(/already has a console login/);
    // Whatever the case of the login's email, or of the address typed.
    d.uow.state.userEmails.other = "Lou@Family.CA";
    await expect(add(d, owner, { localPart: "lou" })).rejects.toThrow(/already has a console login/);
    await expect(add(d, owner, { localPart: "KIM" })).rejects.toThrow(/already has a console login/);
    const acting = {
      ...owner,
      actingAs: actAs(ACCOUNT_A, "support_admin"),
    };
    await expect(add(d, acting, { localPart: "lee" })).rejects.toThrow(ForbiddenError);

    const free = setup("free");
    await expect(add(free, owner)).rejects.toThrow(PlanLimitError);
  });

  it("stops at the people ceiling", async () => {
    const d = setup();
    for (let i = d.uow.state.memberships.filter((m) => m.accountId === ACCOUNT_A).length; i < MAX_PEOPLE; i++) {
      d.uow.state.memberships.push({ userId: `p${String(i)}`, accountId: ACCOUNT_A, role: "member" });
      d.uow.state.userEmails[`p${String(i)}`] = `p${String(i)}@example.ca`;
    }
    await expect(add(d, owner)).rejects.toThrow(PlanLimitError);
  });

  it("Edit name: sets and clears the display name, queues the mail server, audits without the name", async () => {
    const d = setup();
    const { mailbox } = await add(d, owner);
    const renamed = await renameMailbox(d, userAdmin, ACCOUNT_A, mailbox.id, { displayName: " Jane  Q. Doe " }, req);
    expect(renamed).toMatchObject({ displayName: "Jane Q. Doe", senderName: "Jane Q. Doe", nameSource: "custom" });
    expect(d.uow.state.jobs.at(-1)).toMatchObject({ kind: "mailbox.ensure", subjectId: mailbox.id });
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "mailbox.renamed", result: "success" });
    expect(JSON.stringify(d.uow.state.audit.at(-1))).not.toContain("Jane Q.");
    // Cleared: "Use the person's name" — the mailbox follows its person again.
    expect(await renameMailbox(d, owner, ACCOUNT_A, mailbox.id, { displayName: "" }, req)).toMatchObject({
      displayName: null,
      senderName: "Jane Doe",
      nameSource: "person",
    });
    await expect(
      renameMailbox(d, owner, ACCOUNT_A, mailbox.id, { displayName: "visit example.com" }, req),
    ).rejects.toThrow(ValidationError);
    await expect(renameMailbox(d, member, ACCOUNT_A, mailbox.id, { displayName: "X" }, req)).rejects.toThrow(
      ForbiddenError,
    );
    // An admin's mailbox: a User Administrator may not rename it (audited as denied); an Owner may.
    const admin = await add(d, owner, { localPart: "boss", role: "user_admin" });
    const adminActor = user({ id: admin.userId, account: [[ACCOUNT_A, "user_admin"]] });
    await expect(
      renameMailbox(d, userAdmin, ACCOUNT_A, admin.mailbox.id, { displayName: "Someone Else" }, req),
    ).rejects.toThrow(/Only an owner/);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "mailbox.renamed", result: "denied" });
    expect(
      (await renameMailbox(d, adminActor, ACCOUNT_A, admin.mailbox.id, { displayName: "Boss" }, req)).displayName,
    ).toBe("Boss");
    expect(
      (await renameMailbox(d, owner, ACCOUNT_A, admin.mailbox.id, { displayName: "Big Boss" }, req)).displayName,
    ).toBe("Big Boss");
    await expect(renameMailbox(d, ownerB, ACCOUNT_A, mailbox.id, { displayName: "X" }, req)).rejects.toThrow(
      NotFoundError,
    );
    await expect(renameMailbox(d, ownerB, ACCOUNT_B, mailbox.id, { displayName: "X" }, req)).rejects.toThrow(
      NotFoundError,
    );
  });
});
