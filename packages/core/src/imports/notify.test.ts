// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { ACCOUNT_A, req } from "../__tests__/helpers";
import {
  fakeSealer,
  importWorld,
  MBX_MEMBER,
  MBX_SHARED,
  MBX_UADMIN,
  member,
  SESSION,
  SOURCE,
  userAdmin,
} from "../__tests__/imports";
import type { MailImportFolder } from "./entity";
import { endImport } from "./lifecycle";
import { claimImportSummaries } from "./notify";
import { getImport, importTargets, startImport } from "./service";

function setup() {
  const w = importWorld();
  const ctx = { issuer: w.issuer, sealer: fakeSealer };
  const start = async (actor = member, mailboxId = MBX_MEMBER) =>
    (await startImport(w.d, ctx, actor, ACCOUNT_A, { mailboxId, ...SOURCE }, { sessionId: SESSION }, req)).import;
  const folder = (importId: string, role: MailImportFolder["role"], done: number, dup = 0): MailImportFolder => ({
    id: crypto.randomUUID(),
    importId,
    role,
    sourcePath: null,
    uidValidity: 1n,
    lastUid: 10n,
    messagesTotal: done + dup,
    messagesDone: done,
    duplicates: dup,
    tooLarge: role === null ? 1 : 0,
    failed: 0,
    bytesDone: 0,
    status: "done",
    updatedAt: w.clock.now(),
  });
  const end = (id: string, status: "completed" | "failed" | "cancelled", errorCode: string | null = null) =>
    w.d.uow.run(async (r) => {
      await r.imports.update(id, { messagesDone: 7, duplicates: 2, tooLarge: 1 });
      await endImport(r, id, { status, at: w.clock.now(), errorCode });
    });
  return { ...w, ctx, start, folder, end };
}

describe("claimImportSummaries", () => {
  it("emails the person who started it with counts per role, once", async () => {
    const t = setup();
    const i = await t.start();
    await t.d.uow.run(async (r) => {
      await r.imports.saveFolder(t.folder(i.id, "inbox", 4, 2), null);
      await r.imports.saveFolder(t.folder(i.id, "sent", 1), null);
      await r.imports.saveFolder(t.folder(i.id, null, 1), null);
      await r.imports.saveFolder(t.folder(i.id, null, 1), null);
    });
    await t.end(i.id, "completed");
    const first = await claimImportSummaries(t.d);
    expect(first.claimed).toBe(1);
    expect(first.summaries).toHaveLength(1);
    const [s] = first.summaries;
    expect(s).toMatchObject({
      to: "member@example.ca",
      address: "kid@family.ca",
      startedByRecipient: true,
      status: "completed",
      totals: { copied: 7, duplicates: 2, tooLarge: 1, failed: 0 },
    });
    expect(s?.roles).toEqual([
      { role: "inbox", copied: 4, duplicates: 2, tooLarge: 0, failed: 0 },
      { role: "sent", copied: 1, duplicates: 0, tooLarge: 0, failed: 0 },
      { role: "custom", copied: 2, duplicates: 0, tooLarge: 2, failed: 0 },
    ]);
    // Nothing about the mail, the source sign-in or the folder names.
    expect(JSON.stringify(s)).not.toMatch(/kid@old|app-pw/);
    expect(await claimImportSummaries(t.d)).toEqual({ claimed: 0, summaries: [] });
    expect(t.s.mailImports[0]?.notifiedAt).not.toBeNull();
  });

  it("tells both the admin who started it and the mailbox's person", async () => {
    const t = setup();
    const i = await t.start(userAdmin, MBX_MEMBER);
    await t.end(i.id, "failed", "expired");
    const { summaries } = await claimImportSummaries(t.d);
    expect(summaries.map((s) => [s.to, s.startedByRecipient, s.startedBy])).toEqual([
      ["uadmin@example.ca", true, null],
      ["member@example.ca", false, "uadmin@example.ca"],
    ]);
    expect(summaries[0]).toMatchObject({ status: "failed", errorCode: "expired" });
  });

  it("claims cancelled imports without an email and skips live ones", async () => {
    const t = setup();
    const a = await t.start(member, MBX_MEMBER);
    await t.start(userAdmin, MBX_SHARED);
    await t.end(a.id, "cancelled", "person");
    expect(await claimImportSummaries(t.d)).toEqual({ claimed: 1, summaries: [] });
  });
});

describe("importTargets", () => {
  it("offers the person's own mailboxes, and an admin every mailbox they may manage, with why one can't take an import", async () => {
    const t = setup();
    expect(await importTargets(t.d, member, ACCOUNT_A)).toEqual({
      targets: [{ mailboxId: MBX_MEMBER, address: "kid@family.ca", as: "own", hasPerson: true, unavailable: null }],
      canBatch: false,
    });
    await t.start(member, MBX_MEMBER);
    const admin = await importTargets(t.d, userAdmin, ACCOUNT_A);
    expect(admin.canBatch).toBe(true);
    expect(admin.targets.map((x) => [x.address, x.as, x.hasPerson, x.unavailable])).toEqual([
      ["it@family.ca", "own", true, null],
      ["kid@family.ca", "admin", true, "import_running"],
      ["paused@family.ca", "admin", true, "mailbox_unavailable"],
      ["shop@family.ca", "admin", false, null],
    ]);
    expect(admin.targets.some((x) => x.mailboxId === MBX_UADMIN && x.as === "own")).toBe(true);
  });
});

describe("getImport domainActive", () => {
  it("is true once the mailbox's domain is one of the account's own and active", async () => {
    const t = setup();
    const i = await t.start();
    expect((await getImport(t.d, fakeSealer, member, ACCOUNT_A, i.id)).domainActive).toBe(false);
    t.s.domains.push({
      id: crypto.randomUUID(),
      accountId: ACCOUNT_A,
      name: "family.ca",
      status: "active",
      verifyToken: "t",
      stalwartId: "d1",
      lastError: null,
    } as (typeof t.s.domains)[number]);
    expect((await getImport(t.d, fakeSealer, member, ACCOUNT_A, i.id)).domainActive).toBe(true);
  });
});
