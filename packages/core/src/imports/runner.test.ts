// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  defaultDestinationFolders,
  type FakeDestinationServer,
  type FakeMessage,
  type FakeSourceServer,
  fakeDestination,
  fakeSource,
} from "../../../adapters/src/memory/imports";
import { ACCOUNT_A, req } from "../__tests__/helpers";
import { fakeSealer, importWorld, MBX_MEMBER, member, SESSION, SOURCE } from "../__tests__/imports";
import { ImportSessionError, type MailDestination } from "./ports";
import {
  appendFlags,
  DEFAULT_RUNNER_CONFIG,
  importBackoffMs,
  type RunnerConfig,
  runNextImportSlice,
  withMarker,
} from "./runner";
import { cancelImport, startImport } from "./service";

const D2015 = new Date("2015-02-03T10:00:00Z");

const msg = (uid: number, opts: { id?: string | null; subject?: string; flags?: string[]; body?: string } = {}) =>
  ({
    uid,
    flags: opts.flags ?? [],
    internalDate: D2015,
    raw: [
      "From: Someone <someone@old.example>",
      `Subject: ${opts.subject ?? `message ${String(uid)}`}`,
      ...(opts.id === null ? [] : [`Message-ID: <${opts.id ?? `m${String(uid)}@old.example`}>`]),
      "Date: Tue, 3 Feb 2015 10:00:00 +0000",
      "",
      opts.body ?? "hello",
      "",
    ].join("\r\n"),
  }) satisfies FakeMessage;

function sourceServer(): FakeSourceServer {
  return {
    username: SOURCE.username,
    password: SOURCE.password,
    log: [],
    folders: [
      {
        path: "INBOX",
        messages: [
          msg(1, { flags: ["\\Seen", "$Forwarded", "custom_kw", "$Junk", "\\Recent"] }),
          msg(2, { flags: ["\\Flagged"] }),
          msg(3, { id: "m1@old.example", subject: "same Message-ID as uid 1" }),
          msg(4, { id: null, subject: "no message id" }),
          msg(5, { flags: ["\\Deleted"] }),
          msg(6, { id: "already@old.example" }),
        ],
      },
      { path: "Sent", specialUse: "\\Sent", messages: [msg(1, { id: "s1@old.example", flags: ["\\Seen"] })] },
      { path: "Projects", selectable: false, messages: [] },
      { path: "Projects/2015", messages: [msg(7, { id: "p1@old.example" })] },
      { path: "Spam", specialUse: "\\Junk", messages: [msg(1, { id: "spam1@old.example" })] },
    ],
  };
}

function destServer(): FakeDestinationServer {
  const folders = defaultDestinationFolders();
  // One message is already there (forwarded during the switch): it must not be copied again.
  folders
    .get("INBOX")
    ?.messages.push({ raw: msg(99, { id: "already@old.example" }).raw, flags: [], internalDate: D2015 });
  return { address: "kid@family.ca", secret: "app_secret_1", folders, quotaBytes: 10_000_000, appends: [] };
}

const config = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
  ...DEFAULT_RUNNER_CONFIG,
  // Never fires during a test: leases are checked through the conditional writes.
  renewEveryMs: 3_600_000,
  global: 4,
  messageCap: () => null,
  checkpointEveryMessages: 1,
  ...over,
});

async function setup(options: Record<string, unknown> = {}) {
  const w = importWorld();
  const ctx = { issuer: w.issuer, sealer: fakeSealer };
  const { import: view } = await startImport(
    w.d,
    ctx,
    member,
    ACCOUNT_A,
    { mailboxId: MBX_MEMBER, ...SOURCE, options },
    { sessionId: SESSION },
    req,
  );
  const src = sourceServer();
  const dst = destServer();
  const ports = (destination: MailDestination = fakeDestination(dst)) => ({
    source: fakeSource(src),
    destination,
    sealer: fakeSealer,
    sleep: async (ms: number) => {
      w.clock.set(new Date(w.clock.now().getTime() + ms));
    },
  });
  const row = () => {
    const r = w.s.mailImports.find((i) => i.id === view.id);
    if (!r) throw new Error("no import");
    return r;
  };
  const inFolder = (path: string) => dst.folders.get(path)?.messages ?? [];
  const audits = (action: string) => w.s.audit.filter((a) => a.action === action);
  return { ...w, view, src, dst, ports, row, inFolder, audits };
}

describe("appendFlags and the marker", () => {
  it("keeps system flags and valid keywords, drops \\Recent and spam-training keywords, skips \\Deleted", () => {
    expect(appendFlags(["\\Seen", "\\recent", "$Forwarded", "$Junk", "NonJunk", "$notjunk", "custom_kw"])).toEqual([
      "\\Seen",
      "$Forwarded",
      "custom_kw",
    ]);
    expect(appendFlags(["\\Seen", "\\Deleted"])).toBe("deleted");
    expect(appendFlags(["bad(kw", "x".repeat(65), "\\Answered", "\\answered", "\\Draft"])).toEqual([
      "\\Answered",
      "\\Draft",
    ]);
    expect(appendFlags(Array.from({ length: 30 }, (_, i) => `k${String(i)}`))).toHaveLength(20);
  });

  it("prepends exactly one marker line and leaves the original bytes unchanged", () => {
    const raw = new TextEncoder().encode("Subject: x\r\n\r\nbody");
    const out = new TextDecoder().decode(withMarker("imp-1", raw));
    expect(out).toBe("X-AnhourMail-Imported: imp-1\r\nSubject: x\r\n\r\nbody");
  });

  it("backs off 1, 2, 4 … 30 minutes", () => {
    expect([1, 2, 3, 6, 9].map((n) => importBackoffMs(n) / 60_000)).toEqual([1, 2, 4, 30, 30]);
  });
});

describe("runImportSlice", () => {
  it("copies folders, flags and dates once, skips duplicates and Junk, and completes with everything wiped", async () => {
    const t = await setup();
    const out = await runNextImportSlice(t.d, t.ports(), config());
    expect(out).toMatchObject({ importId: t.view.id, outcome: "completed", appended: 5 });
    // INBOX: uid 1, 2, 4 copied; 3 (same Message-ID as 1) and 6 (already there) skipped; 5 (\Deleted) left out.
    const inbox = t.inFolder("INBOX");
    expect(inbox).toHaveLength(4);
    expect(inbox[1]?.raw.startsWith(`X-AnhourMail-Imported: ${t.view.id}\r\n`)).toBe(true);
    expect(inbox[1]?.flags).toEqual(["\\Seen", "$Forwarded", "custom_kw"]);
    expect(inbox[1]?.internalDate).toEqual(D2015);
    expect(t.inFolder("Sent Items")).toHaveLength(1);
    expect(t.inFolder("Projects/2015")).toHaveLength(1);
    // Never into Junk (Spam is left out by default).
    expect(t.inFolder("Junk Mail")).toEqual([]);
    expect(t.dst.appends.some((a) => /junk/i.test(a.folder))).toBe(false);
    expect(t.row()).toMatchObject({
      status: "completed",
      messagesDone: 5,
      duplicates: 2,
      sourceSecret: null,
      destinationSecret: null,
      sourceUsername: null,
    });
    // Folder names are wiped with it; roles and counts stay.
    const folders = t.s.mailImportFolders.filter((f) => f.importId === t.view.id);
    expect(folders.every((f) => f.sourcePath === null)).toBe(true);
    expect(folders.map((f) => [f.role, f.status, f.messagesDone])).toEqual([
      ["inbox", "done", 3],
      ["sent", "done", 1],
      [null, "done", 1],
      ["junk", "skipped", 0],
    ]);
    // The source was only read.
    expect(t.src.log.every((l) => /^(connect|examine|peek) /.test(l))).toBe(true);
    // The revoke job and this slice's training-sample cleanup are queued; audit has counts only.
    const kinds = t.s.jobs.map((j) => j.kind);
    expect(kinds).toContain("mail_import.credential_revoke");
    const cleanup = t.s.jobs.find((j) => j.kind === "mail_import.training_cleanup");
    expect(cleanup?.subjectId).toMatch(new RegExp(`^${t.view.id}:\\d+:\\d+$`));
    const [finished] = t.audits("data.import_finished");
    expect(finished?.meta).toMatchObject({ status: "completed", messagesDone: 5, duplicates: 2 });
    expect(JSON.stringify(t.s.audit)).not.toMatch(/Projects|Subject|old\.example>|app-pw|app_secret/);
  });

  it("copies the source's Junk as an ordinary folder when Junk isn't left out", async () => {
    const t = await setup({ excludeJunkTrash: false });
    await runNextImportSlice(t.d, t.ports(), config());
    expect(t.inFolder("Imported Junk")).toHaveLength(1);
    expect(t.inFolder("Junk Mail")).toEqual([]);
  });

  it("resumes after a dropped connection with an exactly-once result", async () => {
    const t = await setup();
    t.src.dropAfterBodies = 2;
    const first = await runNextImportSlice(t.d, t.ports(), config({ checkpointEveryMessages: 100 }));
    expect(first).toMatchObject({ outcome: "retry", reason: "session_dropped" });
    expect(t.row()).toMatchObject({ status: "running", attempts: 1 });
    expect(t.row().runAfter.getTime() - t.clock.now().getTime()).toBe(60_000);
    // Not due yet; then due.
    expect(await runNextImportSlice(t.d, t.ports(), config())).toBeNull();
    t.clock.set(new Date(t.clock.now().getTime() + 60_000));
    expect((await runNextImportSlice(t.d, t.ports(), config()))?.outcome).toBe("completed");
    const ids = t.inFolder("INBOX").map((m) => /Message-ID: <([^>]+)>/.exec(m.raw)?.[1] ?? m.raw.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(t.inFolder("INBOX")).toHaveLength(4);
    expect(t.row()).toMatchObject({ status: "completed", messagesDone: 5, attempts: 0 });
  });

  it("restarts a folder whose UIDVALIDITY changed, and dedupe keeps the result exact", async () => {
    const t = await setup();
    t.src.dropAfterBodies = 3;
    await runNextImportSlice(t.d, t.ports(), config());
    const inbox = t.src.folders[0];
    if (inbox) inbox.uidValidity = 2n;
    t.clock.set(new Date(t.clock.now().getTime() + 120_000));
    expect((await runNextImportSlice(t.d, t.ports(), config()))?.outcome).toBe("completed");
    expect(t.inFolder("INBOX")).toHaveLength(4);
  });

  it("stops at a message boundary when a pause is asked for, and when cancelled", async () => {
    const t = await setup();
    const dest = fakeDestination(t.dst);
    let appends = 0;
    const pausing: MailDestination = {
      async connect(...args) {
        const s = await dest.connect(...args);
        return {
          ...s,
          async append(...a) {
            appends += 1;
            if (appends === 2) t.row().pauseRequested = true;
            return s.append(...a);
          },
        };
      },
    };
    expect((await runNextImportSlice(t.d, t.ports(pausing), config()))?.outcome).toBe("paused");
    expect(t.row()).toMatchObject({ status: "paused", pauseRequested: false, messagesDone: 2 });

    const c = await setup();
    const cancelling: MailDestination = {
      async connect(...args) {
        const s = await fakeDestination(c.dst).connect(...args);
        return {
          ...s,
          async append(...a) {
            const r = await s.append(...a);
            await cancelImport(c.d, member, ACCOUNT_A, c.view.id, req);
            return r;
          },
        };
      },
    };
    expect((await runNextImportSlice(c.d, c.ports(cancelling), config()))?.outcome).toBe("lease_lost");
    expect(c.dst.appends).toHaveLength(1);
    expect(c.row()).toMatchObject({ status: "cancelled", destinationSecret: null });
    // The runner gives nothing back; the cancel queued the clean-up of what it appended under its lease.
    expect(
      c.s.jobs.some((j) => j.kind === "mail_import.training_cleanup" && j.subjectId.startsWith(`${c.view.id}:`)),
    ).toBe(true);
  });

  it("waits for the person on a refused sign-in, a bad certificate or our refused credential", async () => {
    for (const [side, code, reason] of [
      ["source", "auth", "source_auth"],
      ["source", "certificate", "source_certificate"],
      ["source", "tls_required", "source_tls_required"],
      ["destination", "auth", "destination_credential"],
    ] as const) {
      const t = await setup();
      if (side === "source") t.src.failConnect = code;
      else t.dst.failConnect = code;
      expect(await runNextImportSlice(t.d, t.ports(), config())).toMatchObject({ outcome: "blocked", reason });
      expect(t.row()).toMatchObject({ status: "blocked", blockedReason: reason });
      expect(t.audits("data.import_blocked").at(-1)?.meta).toMatchObject({ reason });
    }
  });

  it("retries an unreachable source with back-off, then waits for the person", async () => {
    const t = await setup();
    t.src.failConnect = "unreachable";
    for (let i = 1; i < 10; i++) {
      expect((await runNextImportSlice(t.d, t.ports(), config()))?.outcome).toBe("retry");
      t.clock.set(new Date(t.clock.now().getTime() + 31 * 60_000));
    }
    expect(await runNextImportSlice(t.d, t.ports(), config())).toMatchObject({
      outcome: "blocked",
      reason: "source_unreachable",
    });
  });

  it("blocks on a full quota, before copying when the source is larger, and at the first over-quota answer", async () => {
    const t = await setup();
    t.dst.quotaBytes = 100;
    expect(await runNextImportSlice(t.d, t.ports(), config())).toMatchObject({ reason: "quota_full" });
    expect(t.dst.appends).toEqual([]);
    // Resumed ("import what fits"): copies until the server says no.
    const u = await setup();
    u.dst.quotaBytes = 900;
    expect(await runNextImportSlice(u.d, u.ports(), config())).toMatchObject({ reason: "quota_full" });
    u.row().status = "queued";
    u.row().blockedReason = null;
    expect(await runNextImportSlice(u.d, u.ports(), config())).toMatchObject({ reason: "quota_full" });
    expect(u.dst.appends.length).toBeGreaterThan(0);
  });

  it("counts messages over the size limit and ones the destination refuses, and keeps going", async () => {
    const t = await setup();
    const big = t.src.folders[0];
    if (big) big.messages.push(msg(8, { body: "x".repeat(5000) }));
    t.dst.rejectOver = 1000;
    const out = await runNextImportSlice(t.d, t.ports(), config({ maxMessageBytes: 4000 }));
    expect(out?.outcome).toBe("completed");
    expect(t.row()).toMatchObject({ tooLarge: 1, failed: 0 });
    const u = await setup();
    u.dst.rejectOver = 150;
    await runNextImportSlice(u.d, u.ports(), config());
    expect(u.row().failed).toBeGreaterThan(0);
  });

  it("gives the import back after its slice, so others take turns", async () => {
    const t = await setup();
    const out = await runNextImportSlice(t.d, t.ports(), config({ sliceMs: 1, maxMessagesPerSecond: 1 }));
    expect(out?.outcome).toBe("released");
    expect(t.row()).toMatchObject({ status: "running", leaseToken: null });
    expect(t.row().runAfter.getTime()).toBeLessThanOrEqual(t.clock.now().getTime());
  });

  it("throttles messages per second", async () => {
    const t = await setup();
    const before = t.clock.now().getTime();
    await runNextImportSlice(t.d, t.ports(), config({ maxMessagesPerSecond: 1 }));
    expect(t.clock.now().getTime() - before).toBeGreaterThanOrEqual(4000);
  });

  it("keeps syncing new mail until the window ends, copying only what is new", async () => {
    const t = await setup({ sync: true });
    expect((await runNextImportSlice(t.d, t.ports(), config()))?.outcome).toBe("syncing");
    expect(t.row()).toMatchObject({ status: "syncing" });
    expect(t.row().runAfter.getTime() - t.clock.now().getTime()).toBe(30 * 60_000);
    t.src.folders[0]?.messages.push(msg(10, { id: "new@old.example" }));
    t.clock.set(new Date(t.clock.now().getTime() + 30 * 60_000));
    const before = t.dst.appends.length;
    expect((await runNextImportSlice(t.d, t.ports(), config()))?.outcome).toBe("syncing");
    expect(t.dst.appends.length - before).toBe(1);
    // The window ends: the next pass completes it.
    t.clock.set(new Date("2026-11-20T00:00:00Z"));
    t.row().runAfter = t.clock.now();
    expect((await runNextImportSlice(t.d, t.ports(), config()))?.outcome).toBe("completed");
  });

  it("stops at the message cap for the destination mailbox's tier (a new account by default)", async () => {
    const t = await setup();
    const out = await runNextImportSlice(t.d, t.ports(), config({ messageCap: (tier) => (tier === "new" ? 2 : null) }));
    expect(out).toMatchObject({ outcome: "completed", reason: "message_cap", appended: 2 });
    expect(t.row()).toMatchObject({ status: "completed", errorCode: "message_cap", messagesDone: 2 });
  });

  it("caps by the account's tier, and by restricted while staff restrict the mailbox (ADR-0034 step B)", async () => {
    const tiers: string[] = [];
    const cap = (tier: string) => {
      tiers.push(tier);
      return tier === "restricted" ? 0 : null;
    };
    const standard = await setup();
    standard.s.trust.push({
      accountId: ACCOUNT_A,
      tier: "standard",
      since: standard.clock.now(),
      source: "billing",
      reason: null,
      note: null,
      setBy: null,
      lastRestrictedAt: null,
    });
    const free = await runNextImportSlice(standard.d, standard.ports(), config({ messageCap: cap }));
    expect(free?.outcome === "completed" ? free.reason : null).not.toBe("message_cap");
    const held = await setup();
    held.s.mailboxRestrictions.push({
      mailboxId: MBX_MEMBER,
      at: held.clock.now(),
      reason: "spam",
      note: null,
      byUserId: null,
    });
    const out = await runNextImportSlice(held.d, held.ports(), config({ messageCap: cap }));
    expect(out).toMatchObject({ outcome: "completed", reason: "message_cap", appended: 0 });
    expect(tiers).toEqual(["standard", "restricted"]);
  });

  it("counts the cap per mailbox over 30 days, so a new import can't get around it", async () => {
    const t = await setup();
    const inbox = t.src.folders[0];
    if (inbox) inbox.messages = Array.from({ length: 6 }, (_, i) => msg(20 + i, { id: `c${String(i)}@old.example` }));
    t.src.folders = inbox ? [inbox] : [];
    const capped = config({ messageCap: () => 2 });
    expect(await runNextImportSlice(t.d, t.ports(), capped)).toMatchObject({ reason: "message_cap", appended: 2 });
    t.s.stepUps.push({ userId: "member", sessionId: SESSION, expiresAt: new Date(t.clock.now().getTime() + 60_000) });
    await startImport(
      t.d,
      { issuer: t.issuer, sealer: fakeSealer },
      member,
      ACCOUNT_A,
      { mailboxId: MBX_MEMBER, ...SOURCE },
      { sessionId: SESSION },
      req,
    );
    expect(await runNextImportSlice(t.d, t.ports(), capped)).toMatchObject({ reason: "message_cap", appended: 0 });
    expect(t.inFolder("INBOX").filter((m) => m.raw.startsWith("X-AnhourMail-Imported"))).toHaveLength(2);
    // Imports started more than 30 days ago no longer count.
    for (const i of t.s.mailImports) i.createdAt = new Date(t.clock.now().getTime() - 31 * 86_400_000);
    await startImport(
      t.d,
      { issuer: t.issuer, sealer: fakeSealer },
      member,
      ACCOUNT_A,
      { mailboxId: MBX_MEMBER, ...SOURCE },
      { sessionId: SESSION },
      req,
    );
    // Its own destination credential (the fake server accepts one secret).
    t.dst.secret = "app_secret_3";
    expect(await runNextImportSlice(t.d, t.ports(), capped)).toMatchObject({ reason: "message_cap", appended: 2 });
  });

  it("waits when the mailbox can't take mail, and fails an import whose secrets can't be opened", async () => {
    const t = await setup();
    const m = t.s.mailboxes.find((x) => x.id === MBX_MEMBER);
    if (m) m.mustChangePassword = true;
    expect(await runNextImportSlice(t.d, t.ports(), config())).toMatchObject({ reason: "mailbox_unavailable" });
    const u = await setup();
    u.row().sourceSecret = "sealed:garbage";
    expect(await runNextImportSlice(u.d, u.ports(), config())).toMatchObject({
      outcome: "failed",
      reason: "secret_unreadable",
    });
    expect(u.row()).toMatchObject({ status: "failed", destinationSecret: null });
  });

  it("covers a dead runner's slice with a training-sample clean-up when the import is claimed again", async () => {
    const t = await setup();
    // A runner took it and died: its lease was never given back.
    t.row().status = "running";
    t.row().leaseToken = "dead";
    const until = t.clock.now().getTime() - 1000;
    t.row().leaseUntil = new Date(until);
    await runNextImportSlice(t.d, t.ports(), config());
    const backstop = t.s.jobs.find(
      (j) =>
        j.kind === "mail_import.training_cleanup" &&
        j.subjectId === `${t.view.id}:${String(until - 2 * 60_000 - 15 * 60_000)}:${String(until)}`,
    );
    expect(backstop).toBeDefined();
  });

  it("skips a folder the destination won't create and copies the rest", async () => {
    const t = await setup();
    const refusing: MailDestination = {
      async connect(...args) {
        const s = await fakeDestination(t.dst).connect(...args);
        return {
          ...s,
          async ensureFolder(path) {
            if (path.startsWith("Projects")) throw new ImportSessionError("refused");
            return s.ensureFolder(path);
          },
        };
      },
    };
    expect((await runNextImportSlice(t.d, t.ports(refusing), config()))?.outcome).toBe("completed");
    expect(t.inFolder("Projects/2015")).toEqual([]);
    expect(t.inFolder("INBOX")).toHaveLength(4);
    expect(t.s.mailImportFolders.find((f) => f.role === null)?.status).toBe("skipped");
  });

  it("answers null when nothing is due", async () => {
    const t = await setup();
    t.row().runAfter = new Date(t.clock.now().getTime() + 60_000);
    expect(await runNextImportSlice(t.d, t.ports(), config())).toBeNull();
  });
});
