// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { APP_PASSWORDS_PER_MAILBOX, type AppPasswordProtocol } from "@anhourmail/shared/security";

import { ACCOUNT_A, ACCOUNT_B, actAs, anonymous, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";
import {
  EnrolmentRequiredError,
  ForbiddenError,
  NotFoundError,
  PlanLimitError,
  StepUpRequiredError,
  UnauthenticatedError,
  ValidationError,
} from "../errors";
import type { Mailbox } from "../mailboxes/entity";
import { removeMember } from "../people/service";
import type { Deps, UnitOfWork } from "../ports";
import type { UserActor } from "../actor";
import { reconcileManagedScripts } from "../webmail/managed-script";
import { appPasswordName, appPasswordProtocols } from "./entity";
import type { AppPasswordInventory, AppPasswordIssuer } from "./ports";
import {
  createAppPassword,
  listMailboxAppPasswords,
  listMyAppPasswords,
  reconcileAppPasswords,
  revokeAppPasswords,
} from "./service";

const MBX_MEMBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MBX_OWNER = "abababab-abab-4bab-8bab-abababababab";
const MBX_UADMIN = "efefefef-efef-4fef-8fef-efefefefefef";
const MBX_PAUSED = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const MBX_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const auditor = user({ id: "auditor", account: [[ACCOUNT_A, "auditor"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const member2 = user({ id: "member2", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const SESSION = "session-1";

function setup() {
  const clock = fixedClock("2026-10-22T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT_A, "owner"],
    ["uadmin", ACCOUNT_A, "user_admin"],
    ["dadmin", ACCOUNT_A, "domain_admin"],
    ["auditor", ACCOUNT_A, "auditor"],
    ["member", ACCOUNT_A, "member"],
    ["member2", ACCOUNT_A, "member"],
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
    mailbox(MBX_UADMIN, ACCOUNT_A, "it@family.ca", "uadmin"),
    { ...mailbox(MBX_PAUSED, ACCOUNT_A, "paused@family.ca", "member"), status: "suspended" },
    mailbox(MBX_B, ACCOUNT_B, "b@other.ca", "owner-b"),
  );
  // Every mailbox's sign-in Password is the one the control plane recorded ("p", what the fake reports).
  for (const m of s.mailboxes) s.mailboxPasswords.push({ mailboxId: m.id, pendingHash: null, credentialId: "p" });
  // Fresh step-ups for the people who create app passwords in these tests.
  for (const userId of ["member", "owner", "uadmin", "member2", "owner-b"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date(clock.now().getTime() + 60_000) });
  }
  return { d, clock };
}

type Issued = { externalId: string; name: string; protocols: readonly string[] };
type OnServer = { credentialId: string; createdAt: Date; protocols: AppPasswordProtocol[] | null };

function fakeIssuer(opts: { fail?: boolean } = {}): AppPasswordIssuer &
  AppPasswordInventory & {
    issued: Issued[];
    revoked: string[];
    server: Map<string, OnServer[]>;
    apiKeys: Map<string, number>;
    passwordCount: Map<string, number>;
    passwordIds: Map<string, string[]>;
  } {
  const issued: Issued[] = [];
  const revoked: string[] = [];
  const server = new Map<string, OnServer[]>();
  const apiKeys = new Map<string, number>();
  const passwordCount = new Map<string, number>();
  const passwordIds = new Map<string, string[]>();
  let n = 0;
  return {
    issued,
    revoked,
    server,
    apiKeys,
    passwordCount,
    passwordIds,
    list: async (externalId) => ({
      appPasswords: server.get(externalId) ?? [],
      apiKeys: apiKeys.get(externalId) ?? 0,
      // Every mailbox has exactly one sign-in Password unless a test overrides it.
      passwords: passwordCount.get(externalId) ?? 1,
      passwordIds: passwordIds.get(externalId) ?? ["p"],
    }),
    create: async (input) => {
      if (opts.fail) throw new Error("mail server unavailable");
      issued.push({ externalId: input.externalId, name: input.name, protocols: [...input.protocols] });
      n += 1;
      server.set(input.externalId, [
        ...(server.get(input.externalId) ?? []),
        { credentialId: `c${String(n)}`, createdAt: new Date(1000 * n), protocols: [...input.protocols] },
      ]);
      return {
        credentialId: `c${String(n)}`,
        createdAt: new Date(1000 * n),
        secret: `app_${"x".repeat(35)}${String(n)}`,
      };
    },
    revoke: async (input) => {
      revoked.push(input.credentialId);
    },
  };
}

const create = (
  d: Deps,
  issuer: AppPasswordIssuer,
  actor: Parameters<typeof createAppPassword>[2],
  mailboxId = MBX_MEMBER,
  input: { name?: unknown; protocols?: unknown } = { name: "Phone", protocols: ["imap", "smtp"] },
  sessionId: string | null = SESSION,
  accountId = ACCOUNT_A,
) => createAppPassword(d, issuer, actor, accountId, mailboxId, input, { sessionId }, req);

describe("app password rules", () => {
  it("names are one trimmed line of 1–40 characters", () => {
    expect(appPasswordName("  Work\nlaptop  ")).toBe("Work laptop");
    expect(() => appPasswordName("")).toThrow(ValidationError);
    expect(() => appPasswordName(42)).toThrow(ValidationError);
    expect(() => appPasswordName("x".repeat(41))).toThrow(ValidationError);
    expect(appPasswordName("Téléphone de Zoé")).toBe("Téléphone de Zoé");
  });

  it("protocols are a non-empty subset in canonical order", () => {
    expect(appPasswordProtocols(["smtp", "imap", "smtp"])).toEqual(["imap", "smtp"]);
    expect(() => appPasswordProtocols([])).toThrow(ValidationError);
    expect(() => appPasswordProtocols(["imap", "telnet"])).toThrow(ValidationError);
    expect(() => appPasswordProtocols("imap")).toThrow(ValidationError);
  });
});

describe("creating app passwords", () => {
  it("makes one on the person's own mailbox, returns the secret once, stores only metadata and audits", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    const out = await create(d, issuer, member);
    expect(out.secret).toMatch(/^app_/);
    expect(out.appPassword).toMatchObject({ name: "Phone", protocols: ["imap", "smtp"], status: "active" });
    expect(out.address).toBe("kid@family.ca");
    expect(issuer.issued).toEqual([{ externalId: "s-dddd", name: "Phone", protocols: ["imap", "smtp"] }]);
    const row = d.uow.state.appPasswords[0];
    expect(row).toMatchObject({ mailboxId: MBX_MEMBER, credentialId: "c1", createdBy: "member" });
    expect(JSON.stringify(d.uow.state.appPasswords)).not.toContain(out.secret);
    const entry = d.uow.state.audit.at(-1);
    expect(entry).toMatchObject({
      action: "auth.app_password_created",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      target: { type: "mailbox", id: MBX_MEMBER, label: "kid@family.ca" },
      meta: { name: "Phone", protocols: ["imap", "smtp"] },
    });
    expect(JSON.stringify(d.uow.state.audit)).not.toContain(out.secret);
  });

  it("needs a fresh step-up on this session", async () => {
    const { d, clock } = setup();
    const issuer = fakeIssuer();
    await expect(create(d, issuer, member, MBX_MEMBER, undefined, null)).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(create(d, issuer, member, MBX_MEMBER, undefined, "other-session")).rejects.toBeInstanceOf(
      StepUpRequiredError,
    );
    clock.set(new Date(clock.now().getTime() + 5 * 60_000));
    await expect(create(d, issuer, member)).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(issuer.issued).toEqual([]);
    expect(d.uow.state.audit.map((e) => `${e.action}:${e.result}:${e.errorCode ?? ""}`)).toEqual([
      "auth.app_password_created:denied:step_up_required",
      "auth.app_password_created:denied:step_up_required",
      "auth.app_password_created:denied:step_up_required",
    ]);
  });

  it("is only for the mailbox's own person: 403 for those who can see mailboxes, 404 for others", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    await expect(create(d, issuer, owner, MBX_MEMBER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(create(d, issuer, userAdmin, MBX_MEMBER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(create(d, issuer, member2, MBX_MEMBER)).rejects.toBeInstanceOf(NotFoundError);
    // Another account's mailbox, and another account's id under one's own: not found.
    await expect(create(d, issuer, ownerB, MBX_MEMBER, undefined, SESSION, ACCOUNT_A)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(create(d, issuer, owner, MBX_B)).rejects.toBeInstanceOf(NotFoundError);
    await expect(create(d, issuer, owner, "not-an-id")).rejects.toBeInstanceOf(NotFoundError);
    // The Auditor holds no write permission; anonymous is 401.
    await expect(create(d, issuer, auditor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(create(d, issuer, anonymous)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(issuer.issued).toEqual([]);
    const own = d.uow.state.audit.filter((e) => e.scope === `account:${ACCOUNT_A}`).map((e) => e.result);
    expect(own.every((r) => r === "denied" || r === "failed")).toBe(true);
  });

  it("is refused while staff act as the person, and while an enrolment is required", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    const actingAs: UserActor = {
      ...member,
      actingAs: actAs(ACCOUNT_A, "support_admin"),
    };
    await expect(create(d, issuer, actingAs)).rejects.toThrow(/acting as/);
    await expect(create(d, issuer, { ...member, mustEnrol: "two_factor" })).rejects.toBeInstanceOf(
      EnrolmentRequiredError,
    );
    expect(issuer.issued).toEqual([]);
    expect(d.uow.state.audit.at(-2)).toMatchObject({ result: "denied", errorCode: "act_as" });
  });

  it("re-checks under the account lock: removed meanwhile, or the mailbox given to someone else, gets nothing", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    // The request's actor still lists the membership, but it's gone from the account by the time the lock is held.
    d.uow.state.memberships = d.uow.state.memberships.filter((m) => m.userId !== "member");
    await expect(create(d, issuer, member)).rejects.toBeInstanceOf(NotFoundError);
    const d2 = setup().d;
    d2.uow.state.mailboxes.find((m) => m.id === MBX_MEMBER)!.userId = "member2";
    await expect(create(d2, issuer, member)).rejects.toBeInstanceOf(NotFoundError);
    expect(issuer.issued).toEqual([]);
  });

  it("validates the name and protocols, and needs an active mailbox", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    await expect(create(d, issuer, member, MBX_MEMBER, { name: "", protocols: ["imap"] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(create(d, issuer, member, MBX_MEMBER, { name: "Phone", protocols: [] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(create(d, issuer, member, MBX_PAUSED)).rejects.toThrow(/suspended or being deleted/);
    d.uow.state.mailboxes.find((m) => m.id === MBX_MEMBER)!.stalwartId = null;
    await expect(create(d, issuer, member)).rejects.toThrow(/isn't ready/);
    expect(issuer.issued).toEqual([]);
  });

  it("stops at the per-mailbox limit, counting ones being revoked", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    for (let i = 0; i < APP_PASSWORDS_PER_MAILBOX; i++) await create(d, issuer, member);
    await expect(create(d, issuer, member)).rejects.toBeInstanceOf(PlanLimitError);
    await revokeAppPasswords(d, member, ACCOUNT_A, MBX_MEMBER, d.uow.state.appPasswords[0]!.id, req);
    await expect(create(d, issuer, member)).rejects.toBeInstanceOf(PlanLimitError);
    d.uow.state.appPasswords.shift(); // the worker finished revoking it
    await expect(create(d, issuer, member)).resolves.toMatchObject({ address: "kid@family.ca" });
  });

  it("takes the credential off the mail server again when its record can't be saved", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    // The same deps, but saving the record fails inside the unit of work.
    const uow: UnitOfWork = {
      run: (fn) =>
        d.uow.run((r) =>
          fn({ ...r, appPasswords: { ...r.appPasswords, insert: () => Promise.reject(new Error("database down")) } }),
        ),
    };
    await expect(create({ ...d, uow }, issuer, member)).rejects.toThrow("database down");
    expect(issuer.revoked).toEqual(["c1"]);
    expect(d.uow.state.appPasswords).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "auth.app_password_created", result: "failed" });
  });

  it("reports a mail server failure without keeping anything", async () => {
    const { d } = setup();
    await expect(create(d, fakeIssuer({ fail: true }), member)).rejects.toThrow("mail server unavailable");
    expect(d.uow.state.appPasswords).toEqual([]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ result: "failed", errorCode: "server_error" });
  });
});

describe("listing app passwords", () => {
  it("lists the person's own mailboxes with theirs, and what they can do", async () => {
    const { d } = setup();
    await create(d, fakeIssuer(), member);
    const mine = await listMyAppPasswords(d, member, ACCOUNT_A);
    expect(mine.map((m) => m.address)).toEqual(["kid@family.ca", "paused@family.ca"]);
    expect(mine[0]).toMatchObject({ canCreate: true, canRevoke: true, limit: APP_PASSWORDS_PER_MAILBOX });
    expect(mine[0]?.appPasswords.map((p) => p.name)).toEqual(["Phone"]);
    expect(mine[1]).toMatchObject({ canCreate: false, mailboxStatus: "suspended" });
    expect(Object.keys(mine[0]?.appPasswords[0] ?? {}).sort()).toEqual(
      ["createdAt", "id", "name", "protocols", "status"].sort(),
    );
    expect(await listMyAppPasswords(d, owner, ACCOUNT_A)).toHaveLength(1);
    await expect(listMyAppPasswords(d, auditor, ACCOUNT_A)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMyAppPasswords(d, ownerB, ACCOUNT_A)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("shows any mailbox's to people who can see mailboxes; revoking only where they may", async () => {
    const { d } = setup();
    await create(d, fakeIssuer(), member);
    const asOwner = await listMailboxAppPasswords(d, owner, ACCOUNT_A, MBX_MEMBER);
    expect(asOwner).toMatchObject({ canRevoke: true, canCreate: false });
    expect(asOwner.appPasswords).toHaveLength(1);
    expect(await listMailboxAppPasswords(d, auditor, ACCOUNT_A, MBX_MEMBER)).toMatchObject({ canRevoke: false });
    expect(await listMailboxAppPasswords(d, domainAdmin, ACCOUNT_A, MBX_MEMBER)).toMatchObject({ canRevoke: false });
    // A User Admin can't act on an Owner's mailbox.
    expect(await listMailboxAppPasswords(d, userAdmin, ACCOUNT_A, MBX_OWNER)).toMatchObject({ canRevoke: false });
    expect(await listMailboxAppPasswords(d, userAdmin, ACCOUNT_A, MBX_UADMIN)).toMatchObject({
      canRevoke: true,
      canCreate: true,
    });
    await expect(listMailboxAppPasswords(d, member, ACCOUNT_A, MBX_MEMBER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listMailboxAppPasswords(d, owner, ACCOUNT_A, MBX_B)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("revoking app passwords", () => {
  it("lets the person revoke one; the worker is queued and it shows as revoking", async () => {
    const { d } = setup();
    const { appPassword } = await create(d, fakeIssuer(), member);
    expect(await revokeAppPasswords(d, member, ACCOUNT_A, MBX_MEMBER, appPassword.id, req)).toEqual({ revoked: 1 });
    expect(d.uow.state.appPasswords[0]?.status).toBe("revoking");
    expect(d.uow.state.jobs).toContainEqual(
      expect.objectContaining({ kind: "app_password.revoke", subjectId: MBX_MEMBER, status: "queued" }),
    );
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "auth.app_password_revoked",
      result: "success",
      meta: { name: "Phone" },
    });
    // Revoking again (say the worker gave up) queues it again.
    d.uow.state.jobs = [];
    expect(await revokeAppPasswords(d, member, ACCOUNT_A, MBX_MEMBER, appPassword.id, req)).toEqual({ revoked: 0 });
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "app_password.revoke", subjectId: MBX_MEMBER })]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ meta: { name: "Phone", retry: true } });
    d.uow.state.jobs = [];
    expect(await revokeAppPasswords(d, member, ACCOUNT_A, MBX_MEMBER, null, req)).toEqual({ revoked: 0 });
    expect(d.uow.state.jobs).toHaveLength(1);
    await expect(
      revokeAppPasswords(d, member, ACCOUNT_A, MBX_MEMBER, "ffffffff-ffff-4fff-8fff-ffffffffffff", req),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("revokes all of a mailbox's at once, and lets admins who manage it do so", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    await create(d, issuer, member);
    await create(d, issuer, member);
    expect(await revokeAppPasswords(d, userAdmin, ACCOUNT_A, MBX_MEMBER, null, req)).toEqual({ revoked: 2 });
    expect(d.uow.state.audit.at(-1)).toMatchObject({ meta: { all: true, count: 2 }, actor: { userId: "uadmin" } });
    expect(await revokeAppPasswords(d, owner, ACCOUNT_A, MBX_MEMBER, null, req)).toEqual({ revoked: 0 });
  });

  it("refuses others' mailboxes to people who don't manage them, and above a User Admin's role", async () => {
    const { d } = setup();
    await create(d, fakeIssuer(), owner, MBX_OWNER);
    await expect(revokeAppPasswords(d, userAdmin, ACCOUNT_A, MBX_OWNER, null, req)).rejects.toThrow(/Only an owner/);
    await expect(revokeAppPasswords(d, domainAdmin, ACCOUNT_A, MBX_OWNER, null, req)).rejects.toThrow(
      /only on your own/,
    );
    await expect(revokeAppPasswords(d, member2, ACCOUNT_A, MBX_MEMBER, null, req)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(revokeAppPasswords(d, auditor, ACCOUNT_A, MBX_MEMBER, null, req)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(revokeAppPasswords(d, ownerB, ACCOUNT_A, MBX_OWNER, null, req)).rejects.toBeInstanceOf(NotFoundError);
    await expect(revokeAppPasswords(d, owner, ACCOUNT_A, MBX_B, null, req)).rejects.toBeInstanceOf(NotFoundError);
    expect(d.uow.state.appPasswords.every((p) => p.status === "active")).toBe(true);
    const denied = d.uow.state.audit.filter((e) => e.action === "auth.app_password_revoked");
    // Account B's owner is refused before anything is read (logged in the platform scope, never A's log).
    expect(denied.map((e) => e.result)).toEqual(["denied", "denied", "failed", "denied", "denied", "failed"]);
    expect(denied[4]?.scope).toBe("platform");
  });

  it("revokes a person's app passwords when they're removed from the account (their mailboxes stay)", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    await create(d, issuer, member);
    await removeMember(d, owner, ACCOUNT_A, "member", req);
    expect(d.uow.state.appPasswords.map((p) => p.status)).toEqual(["revoking"]);
    expect(d.uow.state.jobs).toContainEqual(
      expect.objectContaining({ kind: "app_password.revoke", subjectId: MBX_MEMBER }),
    );
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "account.member_removed",
      meta: { mailboxesUnassigned: 2, appPasswordsRevoked: 1 },
    });
    // Their next request (roles come from the database) no longer reaches the account at all.
    await expect(listMyAppPasswords(d, user({ id: "member" }), ACCOUNT_A)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reconciling app passwords with the mail server", () => {
  it("is clean when the mail server holds exactly ours, and writes no audit", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    await create(d, issuer, member);
    const before = d.uow.state.audit.length;
    expect(await reconcileAppPasswords(d, issuer)).toMatchObject({ clean: true, requeued: 0 });
    expect(d.uow.state.audit.length).toBe(before);
    // A revocation the worker hasn't picked up yet is in flight, not drift.
    await revokeAppPasswords(d, member, ACCOUNT_A, MBX_MEMBER, d.uow.state.appPasswords[0]!.id, req);
    const auditBefore = d.uow.state.audit.length;
    expect(await reconcileAppPasswords(d, issuer)).toMatchObject({ clean: true, requeued: 0, revokingInFlight: 1 });
    expect(d.uow.state.audit.length).toBe(auditBefore);
  });

  it("reports unknown, unexpected, missing and API keys, re-queues pending revocations, and deletes nothing", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    await create(d, issuer, member);
    await create(d, issuer, member);
    const ext = "s-dddd";
    const list = issuer.server.get(ext) ?? [];
    // One changed by hand, one we never made, the other one gone; an API key on the account.
    list[0] = { ...list[0]!, protocols: null };
    issuer.server.set(ext, [list[0], { credentialId: "zz", createdAt: new Date(5), protocols: ["imap"] }]);
    issuer.apiKeys.set(ext, 1);
    // A mailbox the mail server can't answer for is counted, and the rest still checked.
    const list0 = issuer.list.bind(issuer);
    issuer.list = (id) => (id === "s-cdcd" ? Promise.reject(new Error("account not found")) : list0(id));
    // A revocation whose job gave up.
    await revokeAppPasswords(d, owner, ACCOUNT_A, MBX_UADMIN, null, req).catch(() => undefined);
    d.uow.state.appPasswords.push({
      ...d.uow.state.appPasswords[0]!,
      id: "eeeeeeee-0000-4000-8000-000000000001",
      mailboxId: MBX_OWNER,
      status: "revoking",
    });
    d.uow.state.jobs = [];
    const report = await reconcileAppPasswords(d, issuer);
    expect(report).toMatchObject({
      clean: false,
      unknownOnMailServer: 1,
      unexpectedPermissions: 1,
      missingOnMailServer: 1,
      apiKeys: 1,
      requeued: 1,
      unreachable: 1,
    });
    expect(report.addresses.sort()).toEqual(["kid@family.ca", "paused@family.ca"]);
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "app_password.revoke", subjectId: MBX_OWNER })]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.reconciler_drift",
      scope: "platform",
      meta: { unknownAppPasswords: 1, apiKeysOnMailboxes: 1, appPasswordRevocationsRequeued: 1 },
    });
    expect(JSON.stringify(d.uow.state.audit.at(-1))).not.toContain("kid@family.ca");
    expect(issuer.revoked).toEqual([]);
    expect(d.uow.state.appPasswords).toHaveLength(3);
  });

  it("flags a mailbox without exactly one sign-in Password (a password added by hand)", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    // A second Password on one mailbox (0 on another, as if one were dropped): both are drift.
    issuer.passwordCount.set("s-dddd", 2);
    issuer.passwordCount.set("s-abab", 0);
    const report = await reconcileAppPasswords(d, issuer);
    expect(report).toMatchObject({ clean: false, extraPasswords: 2 });
    expect(report.addresses.sort()).toEqual(["kid@family.ca", "mum@family.ca"]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.reconciler_drift",
      meta: { mailboxesWithExtraPasswords: 2 },
    });
  });
});

describe("reconciling mailbox passwords", () => {
  it("flags a replaced or never-recorded Password credential, skips one with a new password waiting, fixes nothing", async () => {
    const { d } = setup();
    const issuer = fakeIssuer();
    const row = (mailboxId: string) => {
      const p = d.uow.state.mailboxPasswords.find((x) => x.mailboxId === mailboxId);
      if (!p) throw new Error("no row");
      return p;
    };
    // Replaced outside the control plane: the mail server has another credential id than the one recorded.
    issuer.passwordIds.set("s-dddd", ["q"]);
    // Recorded nothing yet (a mailbox from before tracking).
    row(MBX_OWNER).credentialId = null;
    // A reset in flight: a different id is expected until the worker records the new one.
    row(MBX_UADMIN).pendingHash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
    issuer.passwordIds.set("s-efef", ["z"]);
    const report = await reconcileAppPasswords(d, issuer);
    expect(report).toMatchObject({ clean: false, passwordReplaced: 1, passwordUntracked: 1, extraPasswords: 0 });
    expect(report.addresses.sort()).toEqual(["kid@family.ca", "mum@family.ca"]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.reconciler_drift",
      meta: { mailboxPasswordsReplaced: 1, mailboxPasswordsUntracked: 1 },
    });
    expect(JSON.stringify(d.uow.state.audit.at(-1))).not.toContain("argon2id");
    // Report only: the recorded ids are untouched.
    expect(row(MBX_MEMBER).credentialId).toBe("p");
    expect(row(MBX_OWNER).credentialId).toBeNull();
  });

  it("is clean when every mailbox has the Password it was given", async () => {
    const { d } = setup();
    const report = await reconcileAppPasswords(d, fakeIssuer());
    expect(report).toMatchObject({ clean: true, passwordReplaced: 0, passwordUntracked: 0 });
  });
});

describe("reconciling managed Sieve scripts", () => {
  const ours = (forwarding: { enabled: boolean; address: string | null }) =>
    `require ["fileinto"];\n# am-settings: ${Buffer.from(JSON.stringify({ v: 1, forwarding }), "utf8").toString("base64url")}\n`;

  it("accepts our scripts with a confirmed target, reports the rest, re-queues them and changes nothing else", async () => {
    const { d, clock } = setup();
    const confirmed = (mailboxId: string, address: string, status: "confirmed" | "pending") =>
      d.uow.state.forwardingTargets.push({
        mailboxId,
        accountId: ACCOUNT_A,
        address,
        status,
        tokenHash: null,
        expiresAt: null,
        confirmedAt: clock.now(),
        requestedAt: clock.now(),
        sendsInWindow: 0,
        windowStartedAt: clock.now(),
      });
    confirmed(MBX_MEMBER, "copy@example.test", "confirmed");
    confirmed(MBX_OWNER, "copy@example.test", "pending");
    const scripts: Record<string, string | null | Error> = {
      "s-dddd": `${ours({ enabled: true, address: "copy@example.test" })}redirect :copy "Copy@Example.test";\n`,
      "s-abab": `${ours({ enabled: true, address: "copy@example.test" })}redirect "copy@example.test";\n`,
      "s-efef": 'require ["variables"];\nredirect "x@evil.test";\n',
      "s-eeee": null,
    };
    const reader = {
      read: async (id: string) => {
        const v = scripts[id] ?? null;
        if (v instanceof Error) throw v;
        // The member's script is ours and clean but switched off: reported, not re-queued (ensure can't fix it).
        return v === null ? null : { content: v, active: id !== "s-abab" };
      },
    };
    const report = await reconcileManagedScripts(d, reader);
    expect(report).toMatchObject({
      checked: 3,
      notOurs: 1,
      unconfirmedRedirects: 2,
      foreign: 1,
      inactive: 1,
      requeued: 2,
    });
    expect(d.uow.state.jobs.map((j) => `${j.kind}:${j.subjectId}`).sort()).toEqual(
      [`mailbox.ensure:${MBX_OWNER}`, `mailbox.ensure:${MBX_UADMIN}`].sort(),
    );
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.reconciler_drift",
      meta: { unconfirmedRedirects: 2, scriptsNotOurs: 1, foreignScripts: 1, scriptsInactive: 1 },
    });
    expect(JSON.stringify(d.uow.state.audit.at(-1))).not.toContain("evil.test");
  });

  it("is clean (no audit) when every script is ours, and counts a mailbox the server can't answer for", async () => {
    const { d } = setup();
    const before = d.uow.state.audit.length;
    const clean = await reconcileManagedScripts(d, {
      read: async () => ({ content: ours({ enabled: false, address: null }), active: true }),
    });
    expect(clean).toMatchObject({ clean: true, checked: 4 });
    expect(d.uow.state.audit.length).toBe(before);
    const down = await reconcileManagedScripts(d, { read: () => Promise.reject(new Error("down")) });
    expect(down).toMatchObject({ clean: false, unreachable: 4, requeued: 0 });
  });
});
