// SPDX-License-Identifier: AGPL-3.0-only
import { ACCOUNT_DELETION_GRACE_DAYS, DATA_EXPORT } from "@anhourmail/shared/data-lifecycle";
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, actingStaff, deps, fixedClock, req, user } from "../__tests__/helpers";
import { authorize, can } from "../actor";
import { AccountDeletingError } from "../errors";
import type { Mailbox, MailboxStatus } from "../mailboxes/entity";
import { purgeDueMailboxes } from "../mailboxes/service";
import type { MailServer } from "../provisioning/ports";
import { csv, csvCell } from "./archive";
import {
  accountDeletionStatus,
  cancelAccountDeletion,
  pendingDeletions,
  requestAccountDeletion,
  runDueDeletions,
} from "./deletion-service";
import type { ExportFile } from "./entity";
import { buildNextExport, downloadExport, expireExports, listExports, requestExport } from "./export-service";
import { deleteOwnLogin, loginDeletionPlan } from "./login-service";
import { recordMailExport } from "./mail-export-service";
import type { ExportArchiver } from "./repository";

const DAY = 86_400_000;
const NOW = "2026-10-21T12:00:00Z";
const M_OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const M_MEMBER = "aaaaaaaa-0000-4000-8000-000000000002";
const M_DELETING = "aaaaaaaa-0000-4000-8000-000000000003";
const M_B = "bbbbbbbb-0000-4000-8000-000000000001";
const D_ACTIVE = "aaaaaaaa-1111-4000-8000-000000000001";
const D_PENDING = "aaaaaaaa-1111-4000-8000-000000000002";

const owner = user({ id: "owner-a", account: [[ACCOUNT_A, "owner"]] });
const member = user({ id: "member-a", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });
const SESSION = { sessionId: "s-owner" };

const mb = (id: string, accountId: string, userId: string | null, status: MailboxStatus, address: string): Mailbox => ({
  id,
  accountId,
  userId,
  address,
  status,
  quotaBytes: 1024,
  stalwartId: `st-${id}`,
  lastError: null,
  purgeAfter: status === "deleting" ? new Date("2026-11-15T00:00:00Z") : null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
});

function world(clock = fixedClock(NOW)) {
  const d = deps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "Acme Family", plan: "plus" }, { id: ACCOUNT_B, name: "Other", plan: "plus" });
  s.memberships.push(
    { userId: "owner-a", accountId: ACCOUNT_A, role: "owner" },
    { userId: "member-a", accountId: ACCOUNT_A, role: "member" },
    { userId: "owner-b", accountId: ACCOUNT_B, role: "owner" },
  );
  for (const u of ["owner-a", "member-a", "owner-b", "staff-1"]) {
    s.userEmails[u] = `${u}@example.test`;
    s.userNames[u] = u;
  }
  s.mailboxes.push(
    mb(M_OWNER, ACCOUNT_A, "owner-a", "active", "me@acme.test"),
    mb(M_MEMBER, ACCOUNT_A, "member-a", "active", "kid@acme.test"),
    mb(M_DELETING, ACCOUNT_A, null, "deleting", "old@acme.test"),
    mb(M_B, ACCOUNT_B, "owner-b", "active", "secret-b@other.test"),
  );
  s.domains.push(
    {
      id: D_ACTIVE,
      accountId: ACCOUNT_A,
      name: "acme.test",
      status: "active",
      verifyToken: "tok",
      stalwartId: "sd-1",
      lastError: null,
      createdAt: new Date("2026-10-01T00:00:00Z"),
    },
    {
      id: D_PENDING,
      accountId: ACCOUNT_A,
      name: "pending.test",
      status: "pending_dns",
      verifyToken: "tok2",
      stalwartId: null,
      lastError: null,
      createdAt: new Date("2026-10-02T00:00:00Z"),
    },
  );
  s.aliases.push({
    id: "aaaaaaaa-2222-4000-8000-000000000001",
    accountId: ACCOUNT_A,
    mailboxId: M_OWNER,
    address: "hello@acme.test",
    kind: "alias",
    enabled: true,
    adminLocked: false,
    description: '=HYPERLINK("x")',
    createdAt: new Date("2026-10-03T00:00:00Z"),
  });
  s.invites.push({
    id: "aaaaaaaa-3333-4000-8000-000000000001",
    accountId: ACCOUNT_A,
    email: "new@example.test",
    role: "member",
    status: "pending",
    expiresAt: new Date("2026-10-25T00:00:00Z"),
    createdBy: "owner-a",
    createdAt: new Date("2026-10-20T00:00:00Z"),
    tokenHash: "h",
    acceptedUserId: null,
    acceptedAt: null,
  });
  s.stepUps.push(
    { userId: "owner-a", sessionId: "s-owner", expiresAt: new Date("2026-10-21T12:05:00Z") },
    { userId: "member-a", sessionId: "s-member", expiresAt: new Date("2026-10-21T12:05:00Z") },
    { userId: "owner-b", sessionId: "s-b", expiresAt: new Date("2026-10-21T12:05:00Z") },
  );
  return d;
}

/** Stands in for ZIP + key ring: JSON of the files, bound to the export id. */
function fakeArchiver(fail = false): ExportArchiver & { packed: Map<string, ExportFile[]> } {
  const packed = new Map<string, ExportFile[]>();
  return {
    packed,
    pack: async (id, files) => {
      if (fail) throw new TypeError("disk full");
      packed.set(id, [...files]);
      return new TextEncoder().encode(JSON.stringify({ id, files }));
    },
    open: async (id, sealed) => {
      const parsed = JSON.parse(new TextDecoder().decode(sealed)) as { id: string };
      if (parsed.id !== id) throw new Error("wrong export");
      return sealed;
    },
  };
}

function fakeMail(): MailServer & { destroyed: string[] } {
  const destroyed: string[] = [];
  const unused = () => Promise.reject(new Error("not used"));
  return {
    destroyed,
    ensureDomain: unused,
    domainDkimKeys: unused,
    ensureMailbox: unused,
    removeDomain: unused,
    listDomains: unused,
    listMailboxes: unused,
    revokeAppPassword: unused,
    setMailboxPassword: unused,
    destroyMailbox: async (input) => {
      destroyed.push(input.address);
    },
  };
}

const audits = (d: ReturnType<typeof deps>, action: string) => d.uow.state.audit.filter((e) => e.action === action);
const file = (files: ExportFile[] | undefined, name: string) => files?.find((f) => f.name === name)?.data ?? "";

describe("CSV", () => {
  it("quotes when needed and neutralises formula-looking cells", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(csv(["a", "b"], [[1, "x\ny"]])).toBe('a,b\r\n1,"x\ny"\r\n');
  });
});

describe("data exports", () => {
  it("an Owner asks for an account export: queued and audited; one at a time (409)", async () => {
    const d = world();
    const v = await requestExport(d, owner, { kind: "account", accountId: ACCOUNT_A }, req);
    expect(v).toMatchObject({ kind: "account", status: "queued", readyAt: null });
    expect(audits(d, "data.export_requested")[0]).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      target: { type: "account", id: ACCOUNT_A, label: "Acme Family" },
    });
    await expect(requestExport(d, owner, { kind: "account", accountId: ACCOUNT_A }, req)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await listExports(d, owner, { kind: "account", accountId: ACCOUNT_A })).toHaveLength(1);
  });

  it("403 without the permission, 404 in another account, 403 while acting as someone (all audited)", async () => {
    const d = world();
    await expect(requestExport(d, member, { kind: "account", accountId: ACCOUNT_A }, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(requestExport(d, ownerB, { kind: "account", accountId: ACCOUNT_A }, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      requestExport(d, actingStaff(ACCOUNT_A), { kind: "account", accountId: ACCOUNT_A }, req),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A personal export is `self`, so act-as reaches the service, which refuses it.
    await expect(requestExport(d, actingStaff(ACCOUNT_A), { kind: "personal" }, req)).rejects.toThrow(/acting as/);
    const denied = audits(d, "data.export_requested").map((e) => [e.result, e.errorCode]);
    expect(denied).toEqual([
      ["denied", "forbidden"],
      ["denied", "not_found"],
      ["denied", "forbidden"],
      ["denied", "act_as"],
    ]);
    expect(d.uow.state.dataExports).toHaveLength(0);
  });

  it("the worker builds an account export: control-plane data of that account only, audit log, sealed, ready 7 days", async () => {
    const d = world();
    const archiver = fakeArchiver();
    d.uow.state.audit.length = 0;
    const v = await requestExport(d, owner, { kind: "account", accountId: ACCOUNT_A }, req);
    const built = await buildNextExport(d, archiver);
    expect(built).toMatchObject({ exportId: v.id, kind: "account", email: "owner-a@example.test" });
    const row = d.uow.state.dataExports[0];
    expect(row?.status).toBe("ready");
    expect(row?.expiresAt?.getTime()).toBe(new Date(NOW).getTime() + DATA_EXPORT.keepDays * DAY);
    const files = archiver.packed.get(v.id);
    expect(files?.map((f) => f.name)).toEqual([
      "README.txt",
      "account.json",
      "people.json",
      "people.csv",
      "domains.json",
      "mailboxes.json",
      "mailboxes.csv",
      "aliases.json",
      "aliases.csv",
      "app-passwords.json",
      "audit-log.json",
      "audit-log.csv",
    ]);
    const all = JSON.stringify(files);
    expect(all).toContain("me@acme.test");
    expect(all).toContain("kid@acme.test");
    expect(all).not.toContain("secret-b@other.test"); // another account's mailbox
    expect(file(files, "aliases.csv")).toContain("'=HYPERLINK");
    expect(file(files, "domains.json")).toContain('"purpose": "ownership"');
    expect(file(files, "audit-log.json")).toContain("data.export_requested");
    expect(file(files, "audit-log.json")).not.toContain("203.0.113.5"); // network part only
    expect(audits(d, "data.export_ready")[0]).toMatchObject({
      scope: `account:${ACCOUNT_A}`,
      result: "success",
      actor: { type: "system", email: "data-export" },
    });
    expect(await buildNextExport(d, archiver)).toBeNull();
  });

  it("a personal export holds the person's own data only and never another person's mailbox", async () => {
    const d = world();
    const archiver = fakeArchiver();
    const v = await requestExport(d, member, { kind: "personal" }, req);
    expect(audits(d, "data.export_requested")[0]?.scope).toBe("platform");
    await buildNextExport(d, archiver);
    const files = archiver.packed.get(v.id);
    expect(files?.map((f) => f.name)).toContain("activity.csv");
    const all = JSON.stringify(files);
    expect(all).toContain("kid@acme.test");
    expect(all).not.toContain("me@acme.test");
    expect(all).not.toContain("secret-b@other.test");
  });

  it("a personal export leaves out mailboxes of accounts the person no longer belongs to", async () => {
    const d = world();
    const s = d.uow.state;
    // member-a left account B, but a mailbox there still names them (until B's admins reassign it).
    s.mailboxes.push(mb("bbbbbbbb-0000-4000-8000-000000000009", ACCOUNT_B, "member-a", "active", "old-job@other.test"));
    s.aliases.push({
      id: "bbbbbbbb-2222-4000-8000-000000000009",
      accountId: ACCOUNT_B,
      mailboxId: "bbbbbbbb-0000-4000-8000-000000000009",
      address: "former-alias@other.test",
      kind: "alias",
      enabled: true,
      adminLocked: false,
      description: null,
      createdAt: new Date("2026-10-03T00:00:00Z"),
    });
    s.appPasswords.push({
      id: "bbbbbbbb-3333-4000-8000-000000000009",
      accountId: ACCOUNT_B,
      mailboxId: "bbbbbbbb-0000-4000-8000-000000000009",
      name: "Former laptop",
      protocols: ["imap"],
      credentialId: "c1",
      credentialCreatedAt: new Date(0),
      createdAt: new Date(0),
      createdBy: "member-a",
      status: "active",
    });
    const archiver = fakeArchiver();
    const v = await requestExport(d, member, { kind: "personal" }, req);
    await buildNextExport(d, archiver);
    const all = JSON.stringify(archiver.packed.get(v.id));
    expect(all).toContain("kid@acme.test");
    expect(all).not.toContain("old-job@other.test");
    expect(all).not.toContain("former-alias@other.test");
    expect(all).not.toContain("Former laptop");
  });

  it("personal export sessions carry the network part of the address only", async () => {
    const d = world();
    const at = new Date(NOW);
    d.uow.state.sessions.push({
      id: "s-m",
      userId: "member-a",
      createdAt: at,
      lastActiveAt: at,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      ip: "203.0.113.77",
      userAgent: "Firefox",
    });
    const archiver = fakeArchiver();
    const v = await requestExport(d, member, { kind: "personal" }, req);
    await buildNextExport(d, archiver);
    const security = file(archiver.packed.get(v.id), "security.json");
    expect(security).toContain("203.0.113.x");
    expect(security).not.toContain("203.0.113.77");
    expect(security).toContain("Firefox");
  });

  it("download: the requester only, after a fresh step-up, until it expires; audited", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    d.uow.state.memberships.push({ userId: "owner-2", accountId: ACCOUNT_A, role: "owner" });
    const otherOwner = user({ id: "owner-2", account: [[ACCOUNT_A, "owner"]] });
    const archiver = fakeArchiver();
    const scope = { kind: "account", accountId: ACCOUNT_A } as const;
    const v = await requestExport(d, owner, scope, req);
    // Not ready yet.
    await expect(downloadExport(d, archiver, owner, scope, v.id, SESSION, req)).rejects.toMatchObject({
      code: "conflict",
    });
    await buildNextExport(d, archiver);
    await expect(downloadExport(d, archiver, owner, scope, v.id, { sessionId: "nope" }, req)).rejects.toMatchObject({
      code: "step_up_required",
    });
    await expect(downloadExport(d, archiver, otherOwner, scope, v.id, { sessionId: "s2" }, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(downloadExport(d, archiver, owner, { kind: "personal" }, v.id, SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      downloadExport(d, archiver, ownerB, { kind: "account", accountId: ACCOUNT_A }, v.id, SESSION, req),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(downloadExport(d, archiver, owner, scope, "not-an-id", SESSION, req)).rejects.toMatchObject({
      code: "not_found",
    });
    const got = await downloadExport(d, archiver, owner, scope, v.id, SESSION, req);
    expect(got.filename).toBe("anhourmail-account-export-2026-10-21.zip");
    expect(got.bytes.byteLength).toBeGreaterThan(10);
    expect(d.uow.state.dataExports[0]?.downloadedAt).not.toBeNull();
    expect(audits(d, "data.export_downloaded").map((e) => e.result)).toEqual([
      "failed",
      "denied",
      "failed",
      "failed",
      "denied",
      "failed",
      "success",
    ]);
    clock.set(new Date(new Date(NOW).getTime() + DATA_EXPORT.keepDays * DAY + 1));
    d.uow.state.stepUps.push({ userId: "owner-a", sessionId: "s-late", expiresAt: new Date("2099-01-01") });
    await expect(downloadExport(d, archiver, owner, scope, v.id, { sessionId: "s-late" }, req)).rejects.toThrow(
      /expired/,
    );
  });

  it("expiry deletes the archive and records it (platform log and the account's); nothing due writes nothing", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    const archiver = fakeArchiver();
    await requestExport(d, owner, { kind: "account", accountId: ACCOUNT_A }, req);
    await buildNextExport(d, archiver);
    const before = d.uow.state.audit.length;
    expect(await expireExports(d)).toBe(0);
    expect(d.uow.state.audit.length).toBe(before);
    clock.set(new Date(new Date(NOW).getTime() + DATA_EXPORT.keepDays * DAY));
    expect(await expireExports(d)).toBe(1);
    expect(d.uow.state.dataExports[0]).toMatchObject({ status: "expired", archive: null });
    expect(audits(d, "data.export_expired").map((e) => e.scope)).toEqual(["platform", `account:${ACCOUNT_A}`]);
  });

  it("a failing build is retried, then marked failed and audited; a crashed build is taken over", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    await requestExport(d, owner, { kind: "account", accountId: ACCOUNT_A }, req);
    expect(await buildNextExport(d, fakeArchiver(true))).toBe("retry");
    expect(d.uow.state.dataExports[0]).toMatchObject({ status: "queued", error: "TypeError", attempts: 1 });
    expect(await buildNextExport(d, fakeArchiver(true))).toBe("retry");
    expect(await buildNextExport(d, fakeArchiver(true))).toBe("failed");
    expect(d.uow.state.dataExports[0]?.status).toBe("failed");
    expect(audits(d, "data.export_ready").at(-1)).toMatchObject({ result: "failed", errorCode: "export_failed" });
    // A new one can be asked for after a failure; a build left running is taken over after the stale window.
    await requestExport(d, owner, { kind: "account", accountId: ACCOUNT_A }, req);
    const row = d.uow.state.dataExports.find((e) => e.status === "queued");
    if (!row) throw new Error("no queued export");
    row.status = "building";
    row.startedAt = new Date(new Date(NOW).getTime() - (DATA_EXPORT.staleBuildMinutes + 1) * 60_000);
    expect(await buildNextExport(d, fakeArchiver())).toMatchObject({ exportId: row.id });
  });
});

describe("mail export record", () => {
  it("is written as the mailbox in its account's log, counts only; an unknown address records nothing", async () => {
    const d = world();
    const info = { scope: "all" as const, folders: 3, messages: 12, skipped: 0, contacts: 2, complete: true };
    await recordMailExport(d, " ME@acme.test ", info, req);
    await recordMailExport(d, "nobody@acme.test", info, req);
    expect(audits(d, "data.mail_exported")).toMatchObject([
      {
        scope: `account:${ACCOUNT_A}`,
        actor: { type: "system", email: "me@acme.test" },
        target: { type: "mailbox", id: M_OWNER, label: "me@acme.test" },
        meta: info,
      },
    ]);
  });
});

describe("account deletion", () => {
  it("needs the exact account name (400) and a fresh step-up (403); 403 for others, 404 outside, 403 acting as", async () => {
    const d = world();
    await expect(requestAccountDeletion(d, owner, ACCOUNT_A, {}, SESSION, req)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "acme family" }, SESSION, req),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "Acme Family" }, { sessionId: "x" }, req),
    ).rejects.toMatchObject({ code: "step_up_required" });
    await expect(
      requestAccountDeletion(d, member, ACCOUNT_A, { confirmName: "Acme Family" }, { sessionId: "s-member" }, req),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      requestAccountDeletion(d, ownerB, ACCOUNT_A, { confirmName: "Acme Family" }, { sessionId: "s-b" }, req),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      requestAccountDeletion(d, actingStaff(ACCOUNT_A), ACCOUNT_A, { confirmName: "Acme Family" }, SESSION, req),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(d.uow.state.accountDeletions).toEqual([]);
    expect(d.uow.state.mailboxes.find((m) => m.id === M_OWNER)?.status).toBe("active");
    expect(audits(d, "data.deletion_requested").map((e) => e.errorCode)).toEqual([
      "bad_request",
      "bad_request",
      "step_up_required",
      "forbidden",
      "not_found",
      "forbidden",
    ]);
  });

  it("schedules it: mailboxes suspended at once (held), invites revoked, everyone told, audited in both logs", async () => {
    const d = world();
    const out = await requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: " Acme Family " }, SESSION, req);
    expect(out.deleteAfter.getTime()).toBe(new Date(NOW).getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY);
    expect(out.notify.sort((a, b) => a.email.localeCompare(b.email))).toEqual([
      { email: "member-a@example.test", owner: false },
      { email: "owner-a@example.test", owner: true },
    ]);
    const s = d.uow.state;
    expect(s.mailboxes.find((m) => m.id === M_OWNER)?.status).toBe("suspended");
    expect(s.mailboxes.find((m) => m.id === M_MEMBER)?.status).toBe("suspended");
    expect(s.mailboxes.find((m) => m.id === M_DELETING)?.status).toBe("deleting");
    expect(s.mailboxes.find((m) => m.id === M_B)?.status).toBe("active");
    expect(
      s.mailboxHolds
        .filter((h) => h.kind === "deletion")
        .map((h) => h.mailboxId)
        .sort(),
    ).toEqual([M_OWNER, M_MEMBER].sort());
    expect(s.invites[0]?.status).toBe("revoked");
    expect(audits(d, "data.deletion_requested").map((e) => e.scope)).toEqual([`account:${ACCOUNT_A}`, "platform"]);
    await expect(
      requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "Acme Family" }, SESSION, req),
    ).rejects.toMatchObject({ code: "conflict" });
    // Everyone in the account sees it; outsiders get 404.
    expect(await accountDeletionStatus(d, member, ACCOUNT_A)).toMatchObject({ canCancel: false, started: false });
    expect(await accountDeletionStatus(d, owner, ACCOUNT_A)).toMatchObject({ canCancel: true });
    await expect(accountDeletionStatus(d, ownerB, ACCOUNT_A)).rejects.toMatchObject({ code: "not_found" });
    // Staff see it in the pending list.
    const ga = user({ id: "ga", platform: ["global_admin"] });
    expect(await pendingDeletions(d, ga)).toMatchObject([{ accountId: ACCOUNT_A, accountName: "Acme Family" }]);
    await expect(pendingDeletions(d, user({ id: "sa", platform: ["support_admin"] }))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("while it waits, only reads, export and cancel work in the account (403 account_deleting)", () => {
    const deleting = { ...owner, deletingAccountIds: [ACCOUNT_A] };
    expect(() => {
      authorize(deleting, "mailbox.manage", ACCOUNT_A);
    }).toThrow(AccountDeletingError);
    expect(() => {
      authorize(deleting, "domain.manage", ACCOUNT_A);
    }).toThrow(AccountDeletingError);
    expect(() => {
      authorize(deleting, "member.manage", ACCOUNT_A);
    }).toThrow(AccountDeletingError);
    expect(can(deleting, "mailbox.read", ACCOUNT_A)).toBe(true);
    expect(can(deleting, "account.delete", ACCOUNT_A)).toBe(true);
    expect(can(deleting, "account.export", ACCOUNT_A)).toBe(true);
    expect(can(deleting, "self.data.export")).toBe(true);
    expect(
      can(
        { ...deleting, memberships: [...deleting.memberships, { accountId: ACCOUNT_B, role: "owner" }] },
        "mailbox.manage",
        ACCOUNT_B,
      ),
    ).toBe(true);
  });

  it("cancel before the grace period ends resumes exactly the mailboxes it suspended", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    // Staff also hold the member's mailbox (a person suspension): it stays suspended after the cancel.
    await requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "Acme Family" }, SESSION, req);
    d.uow.state.mailboxHolds.push({ mailboxId: M_MEMBER, kind: "person" });
    await expect(cancelAccountDeletion(d, member, ACCOUNT_A, req)).rejects.toMatchObject({ code: "forbidden" });
    await expect(cancelAccountDeletion(d, actingStaff(ACCOUNT_A), ACCOUNT_A, req)).rejects.toMatchObject({
      code: "forbidden",
    });
    const out = await cancelAccountDeletion(d, owner, ACCOUNT_A, req);
    expect(out.notify).toHaveLength(2);
    const s = d.uow.state;
    expect(s.accountDeletions).toEqual([]);
    expect(s.mailboxes.find((m) => m.id === M_OWNER)?.status).toBe("provisioning");
    expect(s.mailboxes.find((m) => m.id === M_MEMBER)?.status).toBe("suspended");
    expect(s.mailboxHolds).toEqual([{ mailboxId: M_MEMBER, kind: "person" }]);
    expect(
      audits(d, "data.deletion_cancelled")
        .filter((e) => e.result === "success")
        .map((e) => e.meta),
    ).toEqual([
      { mailboxesResumed: 1, mailboxesStillHeld: 1 },
      { mailboxesResumed: 1, mailboxesStillHeld: 1 },
    ]);
    await expect(cancelAccountDeletion(d, owner, ACCOUNT_A, req)).rejects.toMatchObject({ code: "conflict" });
    // After the grace period it can't be cancelled.
    await requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "Acme Family" }, SESSION, req);
    clock.set(new Date(new Date(NOW).getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY));
    await expect(cancelAccountDeletion(d, owner, ACCOUNT_A, req)).rejects.toThrow(/can't be cancelled/);
  });

  it("the scheduler never touches it before the grace period ends, then removes it step by step; idempotent", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    const s = d.uow.state;
    await requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "Acme Family" }, SESSION, req);
    clock.set(new Date(new Date(NOW).getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY - 1));
    expect(await runDueDeletions(d)).toEqual([]);
    expect(s.mailboxes.filter((m) => m.accountId === ACCOUNT_A)).toHaveLength(3);
    const mail = fakeMail();
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 0, failed: 0, held: 0 });

    clock.set(new Date(new Date(NOW).getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY));
    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["started"]);
    const now = clock.now();
    expect(s.mailboxes.filter((m) => m.accountId === ACCOUNT_A).map((m) => [m.status, m.purgeAfter])).toEqual([
      ["deleting", now],
      ["deleting", now],
      ["deleting", now],
    ]);
    expect(audits(d, "data.deletion_started").map((e) => e.scope)).toEqual([`account:${ACCOUNT_A}`, "platform"]);
    // Cancelling is over once it started.
    await expect(cancelAccountDeletion(d, owner, ACCOUNT_A, req)).rejects.toMatchObject({ code: "conflict" });
    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["waiting_for_mailboxes"]);
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 3, failed: 0, held: 0 });
    expect(mail.destroyed.sort()).toEqual(["kid@acme.test", "me@acme.test", "old@acme.test"]);
    expect(s.mailboxes.map((m) => m.address)).toEqual(["secret-b@other.test"]);

    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["releasing_domains"]);
    expect(s.domains.map((x) => [x.name, x.status])).toEqual([["acme.test", "removing"]]);
    expect(s.jobs.some((j) => j.kind === "domain.remove" && j.subjectId === D_ACTIVE)).toBe(true);
    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["waiting_for_domains"]);
    s.domains = s.domains.filter((x) => x.id !== D_ACTIVE); // the worker's domain.remove

    const done = await runDueDeletions(d);
    expect(done).toMatchObject([{ step: "deleted", accountName: "Acme Family" }]);
    expect(done[0]?.step === "deleted" ? done[0].notify.sort() : []).toEqual([
      "member-a@example.test",
      "owner-a@example.test",
    ]);
    expect(s.accounts.map((a) => a.id)).toEqual([ACCOUNT_B]);
    expect(s.memberships.map((m) => m.accountId)).toEqual([ACCOUNT_B]);
    // Logins stay; the audit log stays.
    expect(s.userEmails["member-a"]).toBe("member-a@example.test");
    expect(audits(d, "account.deleted").map((e) => e.scope)).toEqual([`account:${ACCOUNT_A}`, "platform"]);
    expect(s.audit.filter((e) => e.scope === `account:${ACCOUNT_A}`).length).toBeGreaterThan(5);
    expect(await runDueDeletions(d)).toEqual([]);
  });

  it("an account staff suspended waits until the suspension is lifted", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    await requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "Acme Family" }, SESSION, req);
    d.uow.state.accountSuspensions[ACCOUNT_A] = { reason: "spam", note: null, at: new Date(NOW), byUserId: "ga" };
    clock.set(new Date(new Date(NOW).getTime() + 30 * DAY));
    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["held"]);
    expect(d.uow.state.accountDeletions[0]?.startedAt).toBeNull();
  });

  it("a staff hold on any mailbox (a person suspension) holds the whole deletion, audited once a day", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    const s = d.uow.state;
    await requestAccountDeletion(d, owner, ACCOUNT_A, { confirmName: "Acme Family" }, SESSION, req);
    s.personSuspensions["member-a"] = { reason: "abuse", note: null, at: new Date(NOW), byUserId: "ga" };
    clock.set(new Date(new Date(NOW).getTime() + 30 * DAY));
    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["held"]);
    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["held"]);
    const waits = audits(d, "data.deletion_started").filter((e) => e.result === "denied");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ errorCode: "staff_hold", scope: `account:${ACCOUNT_A}` });
    expect(s.mailboxes.filter((m) => m.accountId === ACCOUNT_A && m.status === "deleting")).toHaveLength(1);
    // A day later the wait is recorded again; once lifted, it proceeds.
    clock.set(new Date(clock.now().getTime() + DAY + 1));
    await runDueDeletions(d);
    expect(audits(d, "data.deletion_started").filter((e) => e.result === "denied")).toHaveLength(2);
    s.personSuspensions = {};
    expect((await runDueDeletions(d)).map((x) => x.step)).toEqual(["started"]);
  });

  it("the purge never removes a mailbox staff hold, even after its own grace period", async () => {
    const clock = fixedClock(NOW);
    const d = world(clock);
    const s = d.uow.state;
    // M_DELETING is due; its account is suspended by staff → kept; then a staff hold on it alone → kept.
    clock.set(new Date("2026-12-01T00:00:00Z"));
    s.accountSuspensions[ACCOUNT_A] = { reason: "spam", note: null, at: new Date(NOW), byUserId: "ga" };
    const mail = fakeMail();
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 0, failed: 0, held: 1 });
    s.accountSuspensions = {};
    s.mailboxHolds.push({ mailboxId: M_DELETING, kind: "account" });
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 0, failed: 0, held: 1 });
    // An account deletion's own hold doesn't count.
    s.mailboxHolds = [{ mailboxId: M_DELETING, kind: "deletion" }];
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 1, failed: 0, held: 0 });
    expect(mail.destroyed).toEqual(["old@acme.test"]);
  });
});

describe("deleting one's own login", () => {
  it("needs the typed address (400), a step-up (403), never while acting as (403 act_as)", async () => {
    const d = world();
    await expect(deleteOwnLogin(d, member, {}, { sessionId: "s-member" }, req)).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      deleteOwnLogin(d, member, { confirmEmail: "member-a@example.test" }, { sessionId: "x" }, req),
    ).rejects.toMatchObject({ code: "step_up_required" });
    await expect(
      deleteOwnLogin(d, actingStaff(ACCOUNT_A), { confirmEmail: "staff-1@anhourtec.test" }, SESSION, req),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(audits(d, "auth.login_deleted").map((e) => e.errorCode)).toEqual([
      "bad_request",
      "step_up_required",
      "act_as",
    ]);
  });

  it("refused while a mailbox is theirs, while they're the only Owner of a busy account, and for staff", async () => {
    const d = world();
    expect((await loginDeletionPlan(d, member)).blockers.map((b) => b.reason)).toEqual(["mailboxes"]);
    await expect(
      deleteOwnLogin(d, member, { confirmEmail: "MEMBER-A@example.test" }, { sessionId: "s-member" }, req),
    ).rejects.toThrow(/mailbox/);
    d.uow.state.mailboxes = d.uow.state.mailboxes.filter((m) => m.userId !== "owner-a");
    expect((await loginDeletionPlan(d, owner)).blockers.map((b) => b.reason)).toEqual(["sole_owner"]);
    d.uow.state.platformRoles.push({ userId: "owner-b", role: "reports_reader" });
    expect((await loginDeletionPlan(d, ownerB)).blockers.map((b) => b.reason)).toContain("staff");
    expect(d.uow.state.userEmails["member-a"]).toBeDefined();
  });

  it("a membership that appears while the accounts are being locked makes it ask to try again (nothing deleted)", async () => {
    const d = world();
    const s = d.uow.state;
    s.mailboxes = s.mailboxes.filter((m) => m.accountId !== ACCOUNT_B);
    let calls = 0;
    const racing = {
      ...d,
      uow: {
        run: <T>(fn: Parameters<typeof d.uow.run<T>>[0]) =>
          d.uow.run((r) =>
            fn({
              ...r,
              access: {
                ...r.access,
                memberships: async (userId: string) => {
                  calls += 1;
                  const real = await r.access.memberships(userId);
                  // The second read (after the locks) sees a new account.
                  return calls === 2 ? [...real, { accountId: ACCOUNT_A, role: "member" as const }] : real;
                },
              },
            }),
          ),
      },
    };
    await expect(
      deleteOwnLogin(racing, ownerB, { confirmEmail: "owner-b@example.test" }, { sessionId: "s-b" }, req),
    ).rejects.toThrow(/changed/);
    expect(s.userEmails["owner-b"]).toBe("owner-b@example.test");
    expect(s.accounts.map((a) => a.id)).toContain(ACCOUNT_B);
  });

  it("deletes the login, leaves shared accounts, takes empty sole-owner accounts with it; each log records it", async () => {
    const d = world();
    const s = d.uow.state;
    // owner-b also joins account A as a Member (no mailbox there), and owns only an empty account B.
    s.mailboxes = s.mailboxes.filter((m) => m.accountId !== ACCOUNT_B);
    s.memberships.push({ userId: "owner-b", accountId: ACCOUNT_A, role: "member" });
    // They could open one of account A's mailboxes (ADR-0026): the grant goes on record in A's log.
    const someBox = s.mailboxes.find((m) => m.accountId === ACCOUNT_A);
    if (!someBox) throw new Error("world has a mailbox in account A");
    s.delegations.push({
      id: "g-1",
      accountId: ACCOUNT_A,
      mailboxId: someBox.id,
      granteeUserId: "owner-b",
      right: "full_access",
      grantedBy: null,
      createdAt: new Date(0),
    });
    const actor = user({
      id: "owner-b",
      account: [
        [ACCOUNT_B, "owner"],
        [ACCOUNT_A, "member"],
      ],
    });
    const plan = await loginDeletionPlan(d, actor);
    expect(plan).toMatchObject({
      allowed: true,
      accountsDeleted: [{ accountId: ACCOUNT_B }],
      accountsLeft: [{ accountId: ACCOUNT_A }],
    });
    const out = await deleteOwnLogin(d, actor, { confirmEmail: "owner-b@example.test" }, { sessionId: "s-b" }, req);
    expect(out).toEqual({ email: "owner-b@example.test", accountsDeleted: 1, accountsLeft: 1 });
    expect(s.userEmails["owner-b"]).toBeUndefined();
    expect(s.accounts.map((a) => a.id)).toEqual([ACCOUNT_A]);
    expect(s.memberships.some((m) => m.userId === "owner-b")).toBe(false);
    expect(s.stepUps.some((x) => x.userId === "owner-b")).toBe(false);
    expect(audits(d, "auth.login_deleted").map((e) => [e.scope, e.meta])).toEqual([
      ["platform", { accountsDeleted: 1, accountsLeft: 1 }],
      [`account:${ACCOUNT_A}`, { left: true }],
      [`account:${ACCOUNT_B}`, { accountDeleted: true }],
    ]);
    expect(s.delegations).toEqual([]);
    expect(audits(d, "delegation.revoked").map((e) => [e.scope, e.target.id, e.meta.reason])).toEqual([
      [`account:${ACCOUNT_A}`, someBox.id, "member_removed"],
    ]);
  });
});
