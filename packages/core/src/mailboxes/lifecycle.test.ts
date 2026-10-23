// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { MAILBOX_DELETE_GRACE_DAYS } from "@anhourmail/shared/plans";

import { ACCOUNT_A, ACCOUNT_B, anonymous, deps as makeDeps, fixedClock, req, user } from "../__tests__/helpers";
import { createAlias, listAliases, setAliasEnabled } from "../aliases/service";
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError } from "../errors";
import type { Deps, UnitOfWork } from "../ports";
import type { MailServer } from "../provisioning/ports";
import type { Mailbox } from "./entity";
import {
  deleteMailbox,
  getMailbox,
  purgeDueMailboxes,
  restoreMailbox,
  resumeMailbox,
  setMailboxQuota,
  suspendMailbox,
} from "./service";

const owner = user({ id: "owner", account: [[ACCOUNT_A, "owner"]] });
const userAdmin = user({ id: "uadmin", account: [[ACCOUNT_A, "user_admin"]] });
const domainAdmin = user({ id: "dadmin", account: [[ACCOUNT_A, "domain_admin"]] });
const member = user({ id: "member", account: [[ACCOUNT_A, "member"]] });
const ownerB = user({ id: "owner-b", account: [[ACCOUNT_B, "owner"]] });

const DOMAIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MBX = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MBX_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MBX_OWNER = "abababab-abab-4bab-8bab-abababababab";
const MBX_DADMIN = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const MBX_UADMIN = "efefefef-efef-4fef-8fef-efefefefefef";
const DAY = 24 * 3600_000;

function setup() {
  const clock = fixedClock("2026-10-22T12:00:00Z");
  const d = makeDeps(clock);
  const s = d.uow.state;
  s.accounts.push({ id: ACCOUNT_A, name: "A", plan: "plus" }, { id: ACCOUNT_B, name: "B", plan: "plus" });
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
  s.domains.push({
    id: DOMAIN_A,
    accountId: ACCOUNT_A,
    name: "family.ca",
    status: "active",
    verifyToken: "t",
    stalwartId: "sd",
    lastError: null,
    createdAt: new Date(0),
  });
  const mailbox = (id: string, accountId: string, address: string, userId = "member"): Mailbox => ({
    id,
    accountId,
    userId,
    address,
    status: "active",
    quotaBytes: 1024,
    stalwartId: `s-${id}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(
    mailbox(MBX, ACCOUNT_A, "kid@family.ca"),
    mailbox(MBX_B, ACCOUNT_B, "b@other.ca"),
    mailbox(MBX_OWNER, ACCOUNT_A, "mum@family.ca", "owner"),
    mailbox(MBX_DADMIN, ACCOUNT_A, "it@family.ca", "dadmin"),
    mailbox(MBX_UADMIN, ACCOUNT_A, "me@family.ca", "uadmin"),
  );
  s.aliases.push({
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    accountId: ACCOUNT_A,
    mailboxId: MBX,
    address: "hi@family.ca",
    kind: "alias",
    enabled: true,
    description: null,
    createdAt: new Date(0),
  });
  return { d, clock };
}

const box = (d: ReturnType<typeof setup>["d"], id = MBX) => d.uow.state.mailboxes.find((m) => m.id === id);

/** A mail server that records destroys (and can be told to fail); provisioning calls aren't expected here. */
function fakeMail(fail = false): MailServer & { destroyed: { externalId: string | null; address: string }[] } {
  const destroyed: { externalId: string | null; address: string }[] = [];
  const unused = () => Promise.reject(new Error("not used"));
  return {
    destroyed,
    ensureDomain: unused,
    ensureMailbox: unused,
    removeDomain: unused,
    listDomains: unused,
    listMailboxes: unused,
    revokeAppPassword: unused,
    setMailboxPassword: unused,
    destroyMailbox: async (input) => {
      if (fail) throw new Error("mail server unavailable");
      destroyed.push(input);
    },
  };
}

/** The same deps, but every conditional mailbox write loses a race (another change got there first). */
function racing(d: Deps): Deps {
  const uow: UnitOfWork = {
    run: (fn) =>
      d.uow.run((r) =>
        fn({
          ...r,
          mailboxes: { ...r.mailboxes, transition: async () => false, deleteIfDue: async () => false },
        }),
      ),
  };
  return { uow, clock: d.clock, platform: d.platform };
}

describe("suspend and resume", () => {
  it("suspends (queued for the worker, audited), refuses a second suspend, then resumes via provisioning", async () => {
    const { d } = setup();
    const v = await suspendMailbox(d, userAdmin, ACCOUNT_A, MBX, req);
    expect(v).toMatchObject({ status: "suspended", purgeAfter: null });
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "mailbox.ensure", subjectId: MBX })]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "mailbox.suspended",
      result: "success",
      target: { id: MBX, label: "kid@family.ca" },
      meta: { from: "active" },
    });
    await expect(suspendMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow("already suspended");

    const back = await resumeMailbox(d, owner, ACCOUNT_A, MBX, req);
    expect(back.status).toBe("provisioning"); // the worker turns access back on, then marks it active
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "mailbox.unsuspended", result: "success" });
    expect(d.uow.state.jobs.filter((j) => j.subjectId === MBX)).toHaveLength(1); // the queued job is reused
    await expect(resumeMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow("isn't suspended");
  });

  it("refuses to resume once the domain is no longer the account's", async () => {
    const { d } = setup();
    await suspendMailbox(d, owner, ACCOUNT_A, MBX, req);
    d.uow.state.domains[0]!.status = "removing";
    await expect(resumeMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow(ConflictError);
    expect(box(d)?.status).toBe("suspended");
  });

  it("enforces permission and scope: 401, 403, 404 for other accounts' ids, all audited as denied", async () => {
    const { d } = setup();
    await expect(suspendMailbox(d, anonymous, ACCOUNT_A, MBX, req)).rejects.toThrow(UnauthenticatedError);
    await expect(suspendMailbox(d, domainAdmin, ACCOUNT_A, MBX, req)).rejects.toThrow(ForbiddenError);
    await expect(suspendMailbox(d, member, ACCOUNT_A, MBX, req)).rejects.toThrow(ForbiddenError);
    await expect(suspendMailbox(d, ownerB, ACCOUNT_A, MBX, req)).rejects.toThrow(NotFoundError);
    // Account B's owner naming account A's mailbox under their own account: not found, nothing changes.
    await expect(suspendMailbox(d, ownerB, ACCOUNT_B, MBX, req)).rejects.toThrow(NotFoundError);
    await expect(resumeMailbox(d, ownerB, ACCOUNT_B, MBX, req)).rejects.toThrow(NotFoundError);
    await expect(deleteMailbox(d, ownerB, ACCOUNT_B, MBX, req)).rejects.toThrow(NotFoundError);
    await expect(restoreMailbox(d, ownerB, ACCOUNT_B, MBX, req)).rejects.toThrow(NotFoundError);
    await expect(deleteMailbox(d, owner, ACCOUNT_A, "not-an-id", req)).rejects.toThrow(NotFoundError);
    expect(box(d)?.status).toBe("active");
    expect(d.uow.state.jobs).toEqual([]);
    const refused = d.uow.state.audit.filter((e) => e.result !== "success").map((e) => e.action);
    expect(refused).toEqual(
      expect.arrayContaining([
        "mailbox.suspended",
        "mailbox.unsuspended",
        "mailbox.deletion_scheduled",
        "mailbox.restored",
      ]),
    );
    expect(d.uow.state.audit.filter((e) => e.result === "denied")).toHaveLength(4);
  });

  it("turns a lost race into a conflict instead of a silent overwrite", async () => {
    const { d } = setup();
    await expect(suspendMailbox(racing(d), owner, ACCOUNT_A, MBX, req)).rejects.toThrow("changed while");
    expect(box(d)?.status).toBe("active");
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "mailbox.suspended", result: "failed" });
  });
});

describe("delete with a grace period, and restore", () => {
  it(`schedules deletion ${String(MAILBOX_DELETE_GRACE_DAYS)} days out, keeping the address and aliases`, async () => {
    const { d, clock } = setup();
    const v = await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    const purgeAfter = new Date(clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY);
    expect(v).toMatchObject({ status: "deleting", purgeAfter });
    expect(box(d)).toMatchObject({ status: "deleting", purgeAfter });
    expect(d.uow.state.aliases).toHaveLength(1);
    expect(d.uow.state.jobs).toEqual([expect.objectContaining({ kind: "mailbox.ensure", subjectId: MBX })]);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "mailbox.deletion_scheduled",
      result: "success",
      meta: { from: "active", purgeAfter: purgeAfter.toISOString(), aliases: 1 },
    });
    expect((await getMailbox(d, domainAdmin, ACCOUNT_A, MBX)).purgeAfter).toEqual(purgeAfter);
  });

  it("refuses suspend, quota changes and a second delete while deleting; a suspended mailbox can be deleted", async () => {
    const { d } = setup();
    await suspendMailbox(d, owner, ACCOUNT_A, MBX, req);
    expect((await deleteMailbox(d, owner, ACCOUNT_A, MBX, req)).status).toBe("deleting");
    expect(d.uow.state.audit.at(-1)?.meta).toMatchObject({ from: "suspended" });
    await expect(suspendMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow("Restore it first");
    await expect(resumeMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow(ConflictError);
    await expect(setMailboxQuota(d, owner, ACCOUNT_A, MBX, { quotaGb: 2 }, req)).rejects.toThrow("Restore it first");
    await expect(deleteMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow("already being deleted");
  });

  it("restores during the grace period (back to active via the worker) and audits it", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    clock.set(new Date(clock.now().getTime() + 29 * DAY));
    const v = await restoreMailbox(d, userAdmin, ACCOUNT_A, MBX, req);
    expect(v).toMatchObject({ status: "provisioning", purgeAfter: null });
    expect(box(d)).toMatchObject({ status: "provisioning", purgeAfter: null });
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "mailbox.restored", result: "success" });
    await expect(restoreMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow("isn't being deleted");
  });

  it("refuses to restore after the grace period, or when the domain is no longer the account's", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    d.uow.state.domains[0]!.status = "removing";
    await expect(restoreMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow("no longer active");
    d.uow.state.domains[0]!.status = "active";
    clock.set(new Date(clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY));
    await expect(restoreMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow("grace period has ended");
    expect(box(d)?.status).toBe("deleting");
  });

  it("keeps a deleting mailbox out of alias targets and refuses new or toggled aliases on it", async () => {
    const { d } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    const overview = await listAliases(d, owner, ACCOUNT_A);
    expect(overview.mailboxes.map((m) => m.id)).not.toContain(MBX);
    expect(overview.mailboxes).toHaveLength(3);
    expect(overview.aliases[0]?.mailbox).toEqual({ id: MBX, address: "kid@family.ca", deleting: true });
    await expect(createAlias(d, owner, ACCOUNT_A, { kind: "masked", mailboxId: MBX }, req)).rejects.toThrow(
      "being deleted",
    );
    await expect(
      setAliasEnabled(d, owner, ACCOUNT_A, "ffffffff-ffff-4fff-8fff-ffffffffffff", { enabled: false }, req),
    ).rejects.toThrow("being deleted");
  });
});

describe("scheduled purge", () => {
  it("does nothing before the grace period ends", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    const audits = d.uow.state.audit.length;
    clock.set(new Date(clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY - 1));
    const mail = fakeMail();
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 0, failed: 0 });
    expect(mail.destroyed).toEqual([]);
    expect(box(d)?.status).toBe("deleting");
    expect(d.uow.state.audit).toHaveLength(audits);
  });

  it("destroys the mail-server account, deletes the rows, frees the addresses and audits it as the system", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    clock.set(new Date(clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY));
    const mail = fakeMail();
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 1, failed: 0 });
    expect(mail.destroyed).toEqual([{ externalId: `s-${MBX}`, address: "kid@family.ca" }]);
    expect(box(d)).toBeUndefined();
    expect(d.uow.state.aliases).toEqual([]);
    expect(await d.uow.run((r) => r.mailboxes.addressTaken("kid@family.ca"))).toBe(false);
    expect(await d.uow.run((r) => r.mailboxes.addressTaken("hi@family.ca"))).toBe(false);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "platform.mailbox_purged",
      result: "success",
      scope: `account:${ACCOUNT_A}`,
      actor: { type: "system", email: "mailbox-purge" },
      target: { type: "mailbox", id: MBX, label: "kid@family.ca" },
      meta: { aliases: 1 },
    });
    // Gone for good: restoring is now "not found", and another run has nothing to do.
    await expect(restoreMailbox(d, owner, ACCOUNT_A, MBX, req)).rejects.toThrow(NotFoundError);
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 0, failed: 0 });
    expect(box(d, MBX_B)).toBeDefined(); // other mailboxes untouched
    expect(box(d, MBX_OWNER)).toBeDefined();
  });

  it("keeps the rows when the mail server refuses, audits the failure, and retries next run", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    clock.set(new Date(clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY + 1));
    expect(await purgeDueMailboxes(d, fakeMail(true))).toEqual({ purged: 0, failed: 1 });
    expect(box(d)?.status).toBe("deleting");
    expect(d.uow.state.aliases).toHaveLength(1);
    expect(d.uow.state.audit.at(-1)).toMatchObject({ action: "platform.mailbox_purged", result: "failed" });
    expect(await purgeDueMailboxes(d, fakeMail())).toEqual({ purged: 1, failed: 0 });
  });

  it("skips a mailbox restored between listing and purging, and one whose row changed underneath", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    clock.set(new Date(clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY));
    const mail = fakeMail();
    // Restored after the purge listed it: the purge re-reads inside its unit of work and stops.
    const listed: Deps = {
      clock: d.clock,
      platform: d.platform,
      uow: {
        run: (fn) =>
          d.uow.run((r) =>
            fn({
              ...r,
              mailboxes: {
                ...r.mailboxes,
                dueForPurge: async (now, limit) => {
                  const due = await r.mailboxes.dueForPurge(now, limit);
                  const m = d.uow.state.mailboxes.find((x) => x.id === MBX);
                  if (m) Object.assign(m, { status: "provisioning", purgeAfter: null });
                  return due;
                },
              },
            }),
          ),
      },
    };
    expect(await purgeDueMailboxes(listed, mail)).toEqual({ purged: 0, failed: 1 });
    expect(mail.destroyed).toEqual([]);
    expect(box(d)?.status).toBe("provisioning");

    Object.assign(box(d)!, { status: "deleting", purgeAfter: clock.now() });
    expect(await purgeDueMailboxes(racing(d), mail)).toEqual({ purged: 0, failed: 1 });
    expect(box(d)).toBeDefined();
  });
});

describe("retrying a change whose job gave up", () => {
  it("shows it as not applied, and suspending again re-queues it (audited) instead of a conflict", async () => {
    const { d } = setup();
    await suspendMailbox(d, owner, ACCOUNT_A, MBX, req);
    expect((await getMailbox(d, owner, ACCOUNT_A, MBX)).applyFailed).toBe(false);
    // The worker gave up: the job failed and the mailbox carries the error.
    d.uow.state.jobs[0]!.status = "failed";
    box(d)!.lastError = "Error: mail server unavailable";
    const failed = await getMailbox(d, owner, ACCOUNT_A, MBX);
    expect(failed).toMatchObject({ status: "suspended", applyFailed: true });
    expect(JSON.stringify(failed)).not.toContain("mail server unavailable"); // presence only, never the text

    const v = await suspendMailbox(d, owner, ACCOUNT_A, MBX, req);
    expect(v).toMatchObject({ status: "suspended", applyFailed: false });
    expect(box(d)?.lastError).toBeNull();
    expect(d.uow.state.jobs.filter((j) => j.subjectId === MBX && j.status === "queued")).toHaveLength(1);
    expect(d.uow.state.audit.at(-1)).toMatchObject({
      action: "mailbox.suspended",
      result: "success",
      meta: { from: "suspended", retry: true },
    });
  });

  it("deleting again re-queues a deletion whose job gave up and keeps the purge date", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    const purgeAfter = box(d)?.purgeAfter;
    d.uow.state.jobs[0]!.status = "failed";
    box(d)!.lastError = "Error: gave up";
    clock.set(new Date(clock.now().getTime() + 5 * DAY));
    const v = await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    expect(v).toMatchObject({ status: "deleting", purgeAfter, applyFailed: false });
    expect(d.uow.state.audit.at(-1)?.meta).toMatchObject({ retry: true, purgeAfter: purgeAfter?.toISOString() });
    expect(d.uow.state.jobs.filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("a new change clears an old error", async () => {
    const { d } = setup();
    box(d)!.lastError = "Error: earlier failure";
    box(d)!.status = "failed";
    expect((await suspendMailbox(d, owner, ACCOUNT_A, MBX, req)).applyFailed).toBe(false);
    expect(box(d)?.lastError).toBeNull();
  });
});

describe("owners' and admins' mailboxes", () => {
  it("a User Admin can't suspend, resume, delete or restore an owner's or another admin's mailbox (403, audited)", async () => {
    const { d } = setup();
    for (const id of [MBX_OWNER, MBX_DADMIN]) {
      await expect(suspendMailbox(d, userAdmin, ACCOUNT_A, id, req)).rejects.toThrow(ForbiddenError);
      await expect(deleteMailbox(d, userAdmin, ACCOUNT_A, id, req)).rejects.toThrow("Only an owner");
      expect(box(d, id)?.status).toBe("active");
      expect((await getMailbox(d, userAdmin, ACCOUNT_A, id)).lifecycleLocked).toBe(true);
    }
    // The owner can; the User Admin still can't resume or restore it afterwards.
    await suspendMailbox(d, owner, ACCOUNT_A, MBX_OWNER, req);
    await expect(resumeMailbox(d, userAdmin, ACCOUNT_A, MBX_OWNER, req)).rejects.toThrow(ForbiddenError);
    await deleteMailbox(d, owner, ACCOUNT_A, MBX_DADMIN, req);
    await expect(restoreMailbox(d, userAdmin, ACCOUNT_A, MBX_DADMIN, req)).rejects.toThrow(ForbiddenError);
    expect((await getMailbox(d, owner, ACCOUNT_A, MBX_DADMIN)).lifecycleLocked).toBe(false);

    const denied = d.uow.state.audit.filter((e) => e.result === "denied");
    expect(denied.map((e) => e.action)).toEqual([
      "mailbox.suspended",
      "mailbox.deletion_scheduled",
      "mailbox.suspended",
      "mailbox.deletion_scheduled",
      "mailbox.unsuspended",
      "mailbox.restored",
    ]);
    expect(denied.every((e) => e.errorCode === "forbidden" && e.scope === `account:${ACCOUNT_A}`)).toBe(true);
    expect(d.uow.state.jobs.map((j) => j.subjectId).sort()).toEqual([MBX_DADMIN, MBX_OWNER].sort()); // owner's only
  });

  it("a User Admin can manage their own mailbox, members' and unassigned ones", async () => {
    const { d } = setup();
    expect((await suspendMailbox(d, userAdmin, ACCOUNT_A, MBX_UADMIN, req)).status).toBe("suspended");
    expect((await suspendMailbox(d, userAdmin, ACCOUNT_A, MBX, req)).status).toBe("suspended");
    box(d)!.userId = null;
    expect((await deleteMailbox(d, userAdmin, ACCOUNT_A, MBX, req)).status).toBe("deleting");
    expect((await getMailbox(d, userAdmin, ACCOUNT_A, MBX)).lifecycleLocked).toBe(false);
  });
});

describe("purge ordering", () => {
  it("removes the row (locking out a restore) before it destroys the mail-server account", async () => {
    const { d, clock } = setup();
    await deleteMailbox(d, owner, ACCOUNT_A, MBX, req);
    clock.set(new Date(clock.now().getTime() + MAILBOX_DELETE_GRACE_DAYS * DAY));
    const seen: (string | undefined)[] = [];
    const mail: MailServer = {
      ...fakeMail(),
      destroyMailbox: async () => {
        seen.push(box(d)?.status); // inside the purge's unit of work: the row is already gone
      },
    };
    expect(await purgeDueMailboxes(d, mail)).toEqual({ purged: 1, failed: 0 });
    expect(seen).toEqual([undefined]);
  });
});
