// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, ACCOUNT_B, actingStaff, anonymous, req } from "../__tests__/helpers";
import {
  auditor,
  billingAdmin,
  domainAdmin,
  fakeSealer,
  importWorld,
  MBX_B,
  MBX_MEMBER,
  MBX_OWNER,
  MBX_PAUSED,
  MBX_SHARED,
  MBX_UADMIN,
  member,
  member2,
  owner,
  SESSION,
  SOURCE,
  userAdmin,
} from "../__tests__/imports";
import { ForbiddenError, NotFoundError, StepUpRequiredError, UnauthenticatedError, ValidationError } from "../errors";
import { fakeHasher } from "../__tests__/helpers";
import { convertMailboxToShared } from "../mailboxes/convert-to-shared";
import { deleteMailbox, suspendMailbox } from "../mailboxes/service";
import { removeMember } from "../people/service";
import { holdMailboxes } from "../platform/suspension";
import { ImportRefusedError } from "./errors";
import { openDestinationSecret, openSourceSecret } from "./secrets";
import {
  cancelImport,
  getImport,
  listImports,
  pauseImport,
  resumeImport,
  startImport,
  stopImportSync,
} from "./service";

const session = { sessionId: SESSION };

function setup() {
  const w = importWorld();
  const ctx = { issuer: w.issuer, sealer: fakeSealer };
  const start = (actor = member, mailboxId = MBX_MEMBER, extra: Record<string, unknown> = {}) =>
    startImport(w.d, ctx, actor, ACCOUNT_A, { mailboxId, ...SOURCE, ...extra }, session, req);
  const audits = (action: string) => w.s.audit.filter((a) => a.action === action);
  return { ...w, ctx, start, audits };
}

describe("startImport", () => {
  it("mints an IMAP-only credential, seals both secrets and records a queued import", async () => {
    const t = setup();
    const { import: view, notice } = await t.start();
    expect(view).toMatchObject({ mailboxId: MBX_MEMBER, status: "queued", requestedAs: "own", startedByYou: true });
    expect(view.options).toEqual({ excludeJunkTrash: true, intoSubfolder: false, sync: false });
    expect(notice).toBeNull();
    expect(t.issuer.minted).toHaveLength(1);
    expect(t.issuer.minted[0]?.stalwartAccountId).toBe("s-dddd");
    // Seven days for a one-off import.
    expect(t.issuer.minted[0]?.expiresAt.toISOString()).toBe("2026-11-12T12:00:00.000Z");
    const row = t.s.mailImports[0];
    expect(row?.sourceSecret && openSourceSecret(fakeSealer, view.id, row.sourceSecret)).toBe("app-pw");
    expect(row?.destinationSecret && openDestinationSecret(fakeSealer, view.id, row.destinationSecret)).toBe(
      "app_secret_1",
    );
    // The view never carries a secret or the source username.
    expect(JSON.stringify(view)).not.toMatch(/app-pw|app_secret|kid@old/);
    const [audit] = t.audits("data.import_started");
    expect(audit?.result).toBe("success");
    expect(audit?.meta).toMatchObject({ importId: view.id, sourceDomain: "old-provider.example", sourcePort: 993 });
    expect(JSON.stringify(audit)).not.toMatch(/app-pw|app_secret|kid@old/);
  });

  it("gives a syncing import a fourteen-day credential and window", async () => {
    const t = setup();
    const { import: view } = await t.start(member, MBX_MEMBER, { options: { sync: true, excludeJunkTrash: false } });
    expect(view.options).toEqual({ excludeJunkTrash: false, intoSubfolder: false, sync: true });
    expect(view.syncUntil?.toISOString()).toBe("2026-11-19T12:00:00.000Z");
    expect(t.issuer.minted[0]?.expiresAt.toISOString()).toBe("2026-11-19T12:00:00.000Z");
  });

  it("lets an admin with .any import into a member's or shared mailbox, and tells the person", async () => {
    const t = setup();
    const { import: view, notice } = await t.start(userAdmin);
    expect(view.requestedAs).toBe("admin");
    expect(notice).toMatchObject({ to: "member@example.ca", address: "kid@family.ca", sourceHost: SOURCE.host });
    const shared = await t.start(userAdmin, MBX_SHARED);
    expect(shared.notice).toBeNull();
  });

  it("keeps Owners' and admins' mailboxes for Owners", async () => {
    const t = setup();
    await expect(t.start(userAdmin, MBX_OWNER)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await t.start(owner, MBX_UADMIN)).import.requestedAs).toBe("admin");
  });

  it("refuses without .any on someone else's mailbox: 403 for those who see mailboxes, 404 otherwise", async () => {
    const t = setup();
    await expect(t.start(domainAdmin, MBX_MEMBER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.start(member2, MBX_MEMBER)).rejects.toBeInstanceOf(NotFoundError);
    expect(t.audits("data.import_started").map((a) => a.result)).toEqual(["denied", "failed"]);
    expect(t.issuer.minted).toEqual([]);
  });

  it("answers 404 for another account's mailbox and nonsense ids", async () => {
    const t = setup();
    await expect(t.start(member, MBX_B)).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.start(member, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses the auditor, anonymous callers and staff acting as someone", async () => {
    const t = setup();
    await expect(t.start(auditor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.start(anonymous as never)).rejects.toBeInstanceOf(UnauthenticatedError);
    const staff = { ...actingStaff(ACCOUNT_A), memberships: [{ accountId: ACCOUNT_A, role: "owner" as const }] };
    await expect(t.start(staff)).rejects.toThrow(/acting as someone/);
    expect(t.audits("data.import_started").at(-1)?.errorCode).toBe("act_as");
    expect(t.issuer.minted).toEqual([]);
  });

  it("needs a fresh step-up", async () => {
    const t = setup();
    await expect(
      startImport(t.d, t.ctx, member, ACCOUNT_A, { mailboxId: MBX_MEMBER, ...SOURCE }, { sessionId: null }, req),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(
      startImport(t.d, t.ctx, member, ACCOUNT_A, { mailboxId: MBX_MEMBER, ...SOURCE }, { sessionId: "old" }, req),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(t.audits("data.import_started").map((a) => a.errorCode)).toEqual(["step_up_required", "step_up_required"]);
  });

  it("checks the source before minting anything", async () => {
    const t = setup();
    for (const bad of [
      { host: "localhost" },
      { host: "10.0.0.5" },
      { host: "imap" },
      { host: "user@imap.example.com" },
      { port: 465 },
      { username: "" },
      { password: "" },
      { password: "a\r\nb" },
    ]) {
      await expect(t.start(member, MBX_MEMBER, bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(t.issuer.minted).toEqual([]);
    // A development allow-list lets an exact host:port through.
    const dev = await startImport(
      t.d,
      { ...t.ctx, devSources: new Set(["127.0.0.1:993"]) },
      member,
      ACCOUNT_A,
      { mailboxId: MBX_MEMBER, ...SOURCE, host: "127.0.0.1" },
      session,
      req,
    );
    expect(dev.import.sourceHost).toBe("127.0.0.1");
  });

  it("refuses a second live import (409) and an unavailable mailbox (409)", async () => {
    const t = setup();
    await t.start();
    await expect(t.start()).rejects.toMatchObject({ code: "import_running" });
    await expect(t.start(member2, MBX_PAUSED)).rejects.toMatchObject({ code: "mailbox_unavailable" });
    const m = t.s.mailboxes.find((x) => x.id === MBX_OWNER);
    if (m) m.mustChangePassword = true;
    await expect(t.start(owner, MBX_OWNER)).rejects.toBeInstanceOf(ImportRefusedError);
    expect(t.issuer.minted).toHaveLength(1);
  });

  it("destroys the credential again when the import can't be recorded", async () => {
    const t = setup();
    const insert = t.d.uow.state;
    const original = t.d.uow.run.bind(t.d.uow);
    let calls = 0;
    t.d.uow.run = (async (fn: Parameters<typeof original>[0]) =>
      original(async (r) => {
        calls += 1;
        return fn({
          ...r,
          imports: {
            ...r.imports,
            insert: async () => {
              throw new Error("database gone");
            },
          },
        });
      })) as typeof t.d.uow.run;
    await expect(t.start()).rejects.toThrow(/database gone/);
    expect(calls).toBeGreaterThan(0);
    expect(t.issuer.destroyed).toEqual(["cred-1"]);
    expect(insert.mailImports).toEqual([]);
  });

  it("records nothing when the mint fails", async () => {
    const t = setup();
    t.issuer.fail = true;
    await expect(t.start()).rejects.toThrow(/unavailable/);
    expect(t.s.mailImports).toEqual([]);
    expect(t.audits("data.import_started").at(-1)?.result).toBe("failed");
  });
});

describe("listing and reading imports", () => {
  it("shows a person their own mailboxes' imports and an admin every one they may manage", async () => {
    const t = setup();
    const mine = (await t.start()).import;
    const ownerOwn = (await t.start(owner, MBX_OWNER)).import;
    expect((await listImports(t.d, member, ACCOUNT_A)).map((i) => i.id)).toEqual([mine.id]);
    // An admin-started import into the member's mailbox shows to the member too.
    expect((await listImports(t.d, userAdmin, ACCOUNT_A)).map((i) => i.id)).toEqual([mine.id]);
    expect((await listImports(t.d, owner, ACCOUNT_A)).map((i) => i.id).sort()).toEqual([mine.id, ownerOwn.id].sort());
    expect(await listImports(t.d, member2, ACCOUNT_A)).toEqual([]);
    await expect(listImports(t.d, auditor, ACCOUNT_A)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listImports(t.d, member, ACCOUNT_B)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reads one import with its folders, 404 for anyone who can't see it", async () => {
    const t = setup();
    const v = (await t.start()).import;
    const detail = await getImport(t.d, fakeSealer, member, ACCOUNT_A, v.id);
    expect(detail).toMatchObject({ id: v.id, folders: [] });
    await expect(getImport(t.d, fakeSealer, member2, ACCOUNT_A, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getImport(t.d, fakeSealer, billingAdmin, ACCOUNT_A, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getImport(t.d, fakeSealer, member, ACCOUNT_A, "x")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("pause, resume, cancel and stop syncing", () => {
  it("pauses a queued import at once and asks a running one to stop at a message boundary", async () => {
    const t = setup();
    const v = (await t.start()).import;
    expect((await pauseImport(t.d, member, ACCOUNT_A, v.id, req)).status).toBe("paused");
    const row = t.s.mailImports[0];
    if (!row) throw new Error("no row");
    row.status = "running";
    row.leaseToken = "lease";
    row.leaseUntil = new Date(t.clock.now().getTime() + 60_000);
    const asked = await pauseImport(t.d, member, ACCOUNT_A, v.id, req);
    expect(asked).toMatchObject({ status: "running", pauseRequested: true });
    expect(t.audits("data.import_paused")).toHaveLength(2);
    await expect(pauseImport(t.d, member2, ACCOUNT_A, v.id, req)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resumes a blocked import with a new source password and a renewed credential, needing a step-up", async () => {
    const t = setup();
    const v = (await t.start()).import;
    const row = t.s.mailImports[0];
    if (!row) throw new Error("no row");
    row.status = "blocked";
    row.blockedReason = "source_auth";
    await expect(
      resumeImport(t.d, t.ctx, member, ACCOUNT_A, v.id, {}, { sessionId: null }, req),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    // Six days and a half later the credential has less than a day left: resume mints a new one.
    t.clock.set(new Date("2026-11-11T13:00:00Z"));
    t.s.stepUps.push({ userId: "member", sessionId: SESSION, expiresAt: new Date("2026-11-11T13:01:00Z") });
    const resumed = await resumeImport(t.d, t.ctx, member, ACCOUNT_A, v.id, { password: "new-pw" }, session, req);
    expect(resumed).toMatchObject({ status: "queued", blockedReason: null });
    expect(t.issuer.minted.map((m) => m.id)).toEqual(["cred-1", "cred-2"]);
    expect(row.sourceSecret && openSourceSecret(fakeSealer, v.id, row.sourceSecret)).toBe("new-pw");
    expect(row.destinationCredentialId).toBe("cred-2");
    // The replaced credential comes off through the revoke job.
    expect(t.s.jobs.filter((j) => j.kind === "mail_import.credential_revoke").map((j) => j.subjectId)).toEqual([v.id]);
    expect(t.audits("data.import_resumed").at(-1)?.meta).toMatchObject({
      credentialRenewed: true,
      sourcePasswordChanged: true,
    });
  });

  it("resumes without a new credential while the current one has time left, and refuses during act-as", async () => {
    const t = setup();
    const v = (await t.start()).import;
    await pauseImport(t.d, member, ACCOUNT_A, v.id, req);
    expect((await resumeImport(t.d, t.ctx, member, ACCOUNT_A, v.id, {}, session, req)).status).toBe("queued");
    expect(t.issuer.minted).toHaveLength(1);
    const staff = { ...actingStaff(ACCOUNT_A), memberships: [{ accountId: ACCOUNT_A, role: "owner" as const }] };
    await expect(resumeImport(t.d, t.ctx, staff, ACCOUNT_A, v.id, {}, session, req)).rejects.toThrow(/acting/);
  });

  it("cancels at once: secrets, username and folder names wiped and the revoke queued, in one go", async () => {
    const t = setup();
    const v = (await t.start()).import;
    const done = await cancelImport(t.d, member, ACCOUNT_A, v.id, req);
    expect(done.status).toBe("cancelled");
    const row = t.s.mailImports[0];
    expect(row).toMatchObject({ sourceSecret: null, destinationSecret: null, sourceUsername: null });
    expect(row?.sourceHost).toBe("old-provider.example");
    expect(t.s.jobs.some((j) => j.kind === "mail_import.credential_revoke" && j.subjectId === v.id)).toBe(true);
    expect(t.audits("data.import_cancelled")[0]?.meta).toMatchObject({ reason: "person" });
    await expect(cancelImport(t.d, member, ACCOUNT_A, v.id, req)).rejects.toMatchObject({ code: "import_finished" });
    await expect(pauseImport(t.d, member, ACCOUNT_A, v.id, req)).rejects.toMatchObject({ code: "import_finished" });
  });

  it("stops syncing: the window ends now and the next pass is due at once", async () => {
    const t = setup();
    const plain = (await t.start()).import;
    await expect(stopImportSync(t.d, member, ACCOUNT_A, plain.id, req)).rejects.toBeInstanceOf(ImportRefusedError);
    await cancelImport(t.d, member, ACCOUNT_A, plain.id, req);
    const v = (await t.start(member, MBX_MEMBER, { options: { sync: true } })).import;
    const row = t.s.mailImports.find((i) => i.id === v.id);
    if (!row) throw new Error("no row");
    row.status = "syncing";
    row.runAfter = new Date("2026-11-05T12:30:00Z");
    const stopped = await stopImportSync(t.d, member, ACCOUNT_A, v.id, req);
    expect(stopped.syncUntil?.toISOString()).toBe("2026-11-05T12:00:00.000Z");
    expect(row.runAfter.toISOString()).toBe("2026-11-05T12:00:00.000Z");
    expect(t.audits("data.import_sync_stopped").at(-1)?.meta).toMatchObject({ reason: "person" });
  });
});

describe("mailbox changes end the import", () => {
  const revokeQueued = (t: ReturnType<typeof setup>, id: string) =>
    t.s.jobs.some((j) => j.kind === "mail_import.credential_revoke" && j.subjectId === id);

  it("ends a leaver's import when they are removed, and when their mailbox is converted to shared", async () => {
    const t = setup();
    const a = (await t.start(member, MBX_MEMBER, { options: { sync: true } })).import;
    await removeMember(t.d, owner, ACCOUNT_A, "member", req, fakeHasher);
    expect(t.s.mailImports.find((i) => i.id === a.id)).toMatchObject({
      status: "cancelled",
      errorCode: "mailbox_released",
      sourceSecret: null,
      destinationSecret: null,
    });
    expect(revokeQueued(t, a.id)).toBe(true);
    expect(t.audits("data.import_cancelled").at(-1)?.meta).toMatchObject({ reason: "mailbox_released" });

    const b = (await t.start(owner, MBX_UADMIN)).import;
    await convertMailboxToShared(t.d, owner, ACCOUNT_A, MBX_UADMIN, {}, session, req, fakeHasher);
    expect(t.s.mailImports.find((i) => i.id === b.id)).toMatchObject({
      status: "cancelled",
      errorCode: "mailbox_released",
    });
    expect(revokeQueued(t, b.id)).toBe(true);
  });

  it("ends the import of a mailbox a staff or deletion hold suspends", async () => {
    const t = setup();
    const a = (await t.start()).import;
    const m = t.s.mailboxes.find((x) => x.id === MBX_MEMBER);
    if (!m) throw new Error("no mailbox");
    const held = await t.d.uow.run((r) => holdMailboxes(t.d, r, [{ ...m }], "person"));
    expect(held.also.map((e) => e.action)).toEqual(["data.import_cancelled"]);
    expect(t.s.mailImports.find((i) => i.id === a.id)).toMatchObject({
      status: "cancelled",
      errorCode: "mailbox_suspended",
    });
    expect(revokeQueued(t, a.id)).toBe(true);
  });

  it("cancels a live import when its mailbox is suspended or deleted", async () => {
    const t = setup();
    const a = (await t.start()).import;
    await suspendMailbox(t.d, owner, ACCOUNT_A, MBX_MEMBER, req);
    expect(t.s.mailImports.find((i) => i.id === a.id)?.status).toBe("cancelled");
    expect(t.audits("data.import_cancelled").at(-1)?.meta).toMatchObject({ reason: "mailbox_suspended" });
    await expect(t.start()).rejects.toMatchObject({ code: "mailbox_unavailable" });
    const c = (await t.start(owner, MBX_SHARED)).import;
    await deleteMailbox(t.d, owner, ACCOUNT_A, MBX_SHARED, req);
    const ended = t.s.mailImports.find((i) => i.id === c.id);
    expect(ended).toMatchObject({ status: "cancelled", errorCode: "mailbox_deleted", destinationSecret: null });
  });
});
