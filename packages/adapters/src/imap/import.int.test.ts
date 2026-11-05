// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Phase 5 exit test for mail import (ADR-0030 §20, slice 9), against the compose stack only (rule 19: the dev
 * Stalwart plays the old provider too; nothing outside the machine is contacted):
 *
 * - a throwaway source mailbox seeded over IMAPS (nested and non-ASCII folders, Sent, Junk, flags and keywords, 2015
 *   dates, a duplicate Message-ID, a message without one, a `\Deleted` one, one message already in the destination);
 * - the real core service starts the import with the real operations key (it mints the IMAP-only credential) and the
 *   key ring seals both secrets in the test database;
 * - the real importer runs as a child process (`apps/worker/src/importer.ts`, no Stalwart key), is SIGKILLed after a
 *   few appends, restarted, and resumes from its checkpoints: exactly the expected messages, no duplicates, flags and
 *   dates kept, our marker on top, Junk left out, the source byte-for-byte and flag-for-flag unchanged;
 * - the worker's jobs then run with the real provisioning key (revoke) and training key (spam samples): no import
 *   credential left on the mail server, both sealed columns and the username null, `credentials_wiped_at` set, folder
 *   names gone, the destination's ham training samples destroyed while the source account's stay;
 * - an incremental (cut-over sync) import copies only new mail, and skips a copy that reached the destination over SMTP
 *   first;
 * - no secret, sign-in name or folder name in anything the importer logged.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { systemClock } from "@anhourmail/core";
import { devImportSources, type ImportContext, startImport, stopImportSync } from "@anhourmail/core/imports";
import { runClaimedJob } from "@anhourmail/core/provisioning";
import { createKeyRing, parseKeyRing } from "@anhourmail/server/keyring";
import { IMPORT_MARKER_HEADER } from "@anhourmail/shared/import";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { createDb, schema } from "../db-postgres/client";
import { PgUnitOfWork } from "../db-postgres/repositories";
import { stalwartImportCredentials, stalwartImportTrainingSamples, stalwartMailServer } from "../stalwart";
import { imapSession } from "../stalwart/int-imap";
import { issueTestKeys } from "../stalwart/int-keys";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!stalwartUrl || !admin || !adminPassword || !databaseUrl) {
  throw new Error("integration tests need STALWART_URL, the dev Stalwart admin and TEST_DATABASE_URL");
}
const ROOT = path.resolve(import.meta.dirname, "../../../..");
const IMAPS = Number(process.env.STALWART_IMAPS_PORT ?? 993);
const IMAP = Number(process.env.STALWART_IMAP_PORT ?? 143);
const SMTP = Number(process.env.STALWART_SMTP_PORT ?? 25);

const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-${tag}.test`);
const domain = `exit-${tag}.test`;
const sourceAddress = `import-source@${domain}`;
const destAddress = `dest@${domain}`;
const sourcePassword = randomBytes(18).toString("base64url");
const destPassword = randomBytes(18).toString("base64url");
const ringSpec = `it:${randomBytes(32).toString("base64")}`;
const sealer = createKeyRing(parseKeyRing(ringSpec));
const { db, pool } = createDb(databaseUrl);
const deps = { uow: new PgUnitOfWork(db), clock: systemClock, platform: PUBLIC_PLATFORM };
const SESSION = `session-${tag}`;
const ids = { source: "", dest: "", user: "", account: "", mailbox: "" };
const logs: string[] = [];
const children: ChildProcess[] = [];

const ctx: ImportContext = {
  issuer: stalwartImportCredentials(keys.operations),
  sealer,
  devSources: devImportSources({ NODE_ENV: "test", IMPORT_DEV_ALLOW_SOURCES: "127.0.0.1:993,127.0.0.1:143" }),
  devSourcesOnly: true,
};

const samplesOf = async (accountId: string) =>
  (
    await mgmt.transport.getAll<{ id: string; accountId?: string; isSpam?: boolean }>("x:SpamTrainingSample", [
      "accountId",
      "isSpam",
    ])
  ).filter((s) => s.accountId === accountId);

afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  try {
    for (const id of [ids.source, ids.dest]) {
      const left = (await samplesOf(id)).map((s) => s.id);
      if (left.length > 0) await mgmt.transport.set("x:SpamTrainingSample", { destroy: left }).catch(() => undefined);
    }
    for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
      await mgmt.destroy("x:Account", u.id);
    }
    for (let i = 0; i < 5; i++) {
      const d = (await mgmt.listDomains()).find((x) => x.name === domain);
      if (
        !d ||
        (await mgmt.destroyDomain(d.id).then(
          () => true,
          () => false,
        ))
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await keys.cleanup();
    await pool.end();
  }
});

const msg = (o: { id: string | null; subject: string; body?: string }) =>
  [
    `From: Old Friend <friend@old-${tag}.test>`,
    `To: ${sourceAddress}`,
    `Subject: ${o.subject}`,
    ...(o.id === null ? [] : [`Message-ID: <${o.id}>`]),
    "Date: Tue, 3 Feb 2015 10:00:00 +0000",
    "",
    o.body ?? "hello from 2015",
    "",
  ].join("\r\n");
const mid = (n: string) => `${n}-${tag}@old.test`;
const appendCmd = (folder: string, flags: string, raw: string) =>
  `APPEND "${folder}" (${flags}) "03-Feb-2015 10:00:00 +0000" {${String(Buffer.byteLength(raw))}+}\r\n${raw}`;

/** "Übersicht" in modified UTF-7. */
const UMLAUT = "&ANw-bersicht";
const SOURCE_FOLDERS = ["INBOX", "Projects/2015/Q1", UMLAUT, "Sent Items", "Junk Mail"];

async function asUser(address: string, password: string, fn: (run: (c: string) => Promise<string>) => Promise<void>) {
  const s = await imapSession();
  try {
    expect(await s.run(`LOGIN "${address}" "${password}"`)).toMatch(/^t1 OK/m);
    await fn((c) => s.run(c));
  } finally {
    s.close();
  }
}

/** Every folder's messages: flags, size and date (the "source unchanged" fingerprint). */
async function snapshot(address: string, password: string, folders: string[]): Promise<string> {
  const out: string[] = [];
  await asUser(address, password, async (run) => {
    for (const f of folders) {
      const opened = await run(`EXAMINE "${f}"`);
      out.push(f, /\* (\d+) EXISTS/.exec(opened)?.[1] ?? "?");
      const fetched = await run("UID FETCH 1:* (UID FLAGS RFC822.SIZE INTERNALDATE)");
      out.push(
        ...fetched
          .split("\r\n")
          .filter((l) => l.startsWith("* "))
          .sort(),
      );
    }
  });
  return out.join("\n");
}

/** The destination folder's messages as Message-ID (or subject), flags and the first header line. */
async function destination(folder: string): Promise<{ id: string; flags: string; top: string; date: string }[]> {
  const out: { id: string; flags: string; top: string; date: string }[] = [];
  await asUser(destAddress, destPassword, async (run) => {
    const opened = await run(`EXAMINE "${folder}"`);
    if (!opened.includes("OK") || opened.includes("* 0 EXISTS")) return;
    const fetched = await run("UID FETCH 1:* (FLAGS INTERNALDATE BODY.PEEK[HEADER])");
    for (const part of fetched.split(/^\* \d+ FETCH/m).slice(1)) {
      const header = part.slice(part.indexOf("}\r\n") + 3);
      out.push({
        id: /^Message-ID: <([^>]+)>/im.exec(header)?.[1] ?? `subject:${/^Subject: (.*)$/im.exec(header)?.[1] ?? ""}`,
        flags: (/FLAGS \(([^)]*)\)/.exec(part)?.[1] ?? "").toLowerCase(),
        top: header.split("\r\n")[0] ?? "",
        date: /INTERNALDATE "([^"]+)"/.exec(part)?.[1] ?? "",
      });
    }
  });
  return out;
}

/** Inbound SMTP on port 25, as another server would deliver to the destination during the switch. */
async function deliver(raw: string): Promise<void> {
  const lines = [
    "EHLO sender.test",
    `MAIL FROM:<friend@old-${tag}.test>`,
    `RCPT TO:<${destAddress}>`,
    "DATA",
    `${raw}\r\n.`,
    "QUIT",
  ];
  await new Promise<void>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: SMTP });
    let i = -1;
    let timer: NodeJS.Timeout | undefined;
    socket.setEncoding("utf8");
    socket.on("data", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        i += 1;
        if (i >= lines.length) socket.end();
        else socket.write(`${lines[i] ?? ""}\r\n`);
      }, 200);
    });
    socket.on("close", () => {
      resolve();
    });
    socket.on("error", () => {
      resolve();
    });
  });
}

/** The importer as production runs it: its own process, no Stalwart key, Postgres and IMAP only. */
function importer(): ChildProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(STALWART_|REDIS_|MAILBOX_PASSWORD_GRANT|SENDER_DELEGATION|SECRETS_KEYRING|IMPORT_)/.test(k)) env[k] = v;
  }
  Object.assign(env, {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    SECRETS_KEYRING: ringSpec,
    IMPORT_DESTINATION_IMAP: `127.0.0.1:${String(IMAPS)}`,
    IMPORT_DEV_DESTINATION_INSECURE: "true",
    IMPORT_DEV_ALLOW_SOURCES: "127.0.0.1:993,127.0.0.1:143",
    IMPORT_DEV_SOURCE_PORTS: `993=${String(IMAPS)},143=${String(IMAP)}`,
    IMPORT_PROCESS_CONCURRENCY: "1",
    IMPORT_IDLE_MS: "200",
    IMPORT_LEASE_SECONDS: "10",
    IMPORT_MAX_MESSAGES_PER_SECOND: "3",
    IMPORTER_HEARTBEAT: path.join(os.tmpdir(), `importer-heartbeat-${tag}`),
  });
  // One process (node with the tsx loader, not the tsx wrapper, which would leave its child running after a SIGKILL).
  const child = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/importer.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (d: Buffer) => logs.push(d.toString()));
  children.push(child);
  return child;
}

const row = (id: string) => deps.uow.run((r) => r.imports.getById(id));

async function waitFor<T>(what: string, fn: () => Promise<T | null | false>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const stop = async (c: ChildProcess) => {
  if (c.exitCode !== null) return;
  c.kill("SIGTERM");
  await waitFor("importer to stop", async () => c.exitCode !== null || c.signalCode !== null, 20_000).catch(() => {
    c.kill("SIGKILL");
  });
};

/** Runs this import's queued jobs as the worker would (other tests' leftovers in the shared database are completed). */
async function runJobs(importId: string): Promise<string[]> {
  const mail = stalwartMailServer(keys.provisioning);
  const trainingSamples = stalwartImportTrainingSamples(keys.training);
  const ran: string[] = [];
  // Training clean-ups wait a minute after their slice: claim "later".
  const later = new Date(Date.now() + 5 * 60_000);
  for (let i = 0; i < 200; i++) {
    const job = await deps.uow.run((r) => r.provisioning.claimNext(later));
    if (!job) break;
    if (job.subjectId === importId || job.subjectId.startsWith(`${importId}:`)) {
      const out = await runClaimedJob(deps, mail, job, { trainingSamples });
      const after = await deps.uow.run((r) => r.provisioning.get(job.id));
      expect(after?.status, `${job.kind} ${after?.lastError ?? ""}`).toBe("succeeded");
      expect(out.lockLost).toBe(false);
      ran.push(job.kind);
    } else {
      await deps.uow.run((r) => r.provisioning.complete(job, new Date()));
    }
  }
  return ran;
}

const start = (options: Record<string, unknown>) =>
  startImport(
    deps,
    ctx,
    {
      kind: "user",
      userId: ids.user,
      email: `owner-${tag}@example.test`,
      platformRoles: [],
      memberships: [{ accountId: ids.account, role: "owner" }],
      suspended: false,
    },
    ids.account,
    {
      mailboxId: ids.mailbox,
      host: "127.0.0.1",
      port: 993,
      username: sourceAddress,
      password: sourcePassword,
      options,
    },
    { sessionId: SESSION },
    { requestId: `it-${tag}`, ip: null, userAgent: null },
  );

let before = "";
let sourceSamples = 0;
let firstImport = "";

describe("mail import end to end (ADR-0030 Phase 5 exit)", () => {
  it("seeds a source mailbox, a destination with one message already there, and the control-plane rows", async () => {
    await keys.provisioning.upsertDomain({ name: domain });
    ids.source = await keys.provisioning.upsertUser({
      name: "import-source",
      domain,
      password: await hashPassword(sourcePassword),
      quotaBytes: 50 * 1024 * 1024,
      suspended: false,
    });
    ids.dest = await keys.provisioning.upsertUser({
      name: "dest",
      domain,
      password: await hashPassword(destPassword),
      quotaBytes: 50 * 1024 * 1024,
      suspended: false,
    });
    await asUser(sourceAddress, sourcePassword, async (run) => {
      expect(await run(`CREATE "Projects/2015/Q1"`)).toMatch(/OK/);
      expect(await run(`CREATE "${UMLAUT}"`)).toMatch(/OK/);
      const inbox: [string, string][] = [
        ["\\Seen \\Flagged $Forwarded custom_kw", msg({ id: mid("a1"), subject: "flagged" })],
        ["\\Answered", msg({ id: mid("a2"), subject: "answered" })],
        ["\\Seen", msg({ id: mid("a1"), subject: "same Message-ID, other copy" })],
        ["", msg({ id: null, subject: `no message id ${tag}` })],
        ["\\Deleted", msg({ id: mid("a5"), subject: "deleted at the source" })],
        ["", msg({ id: mid("already"), subject: "already in the destination" })],
        ...Array.from({ length: 8 }, (_, i): [string, string] => [
          "",
          msg({ id: mid(`f${String(i)}`), subject: `filler ${String(i)}` }),
        ]),
      ];
      for (const [flags, raw] of inbox) expect(await run(appendCmd("INBOX", flags, raw))).toMatch(/OK/);
      expect(await run(appendCmd("Projects/2015/Q1", "\\Seen", msg({ id: mid("p1"), subject: "q1" })))).toMatch(/OK/);
      expect(await run(appendCmd("Projects/2015/Q1", "", msg({ id: mid("p2"), subject: "q1 b" })))).toMatch(/OK/);
      expect(await run(appendCmd(UMLAUT, "", msg({ id: mid("u1"), subject: "umlaut" })))).toMatch(/OK/);
      expect(await run(appendCmd("Sent Items", "\\Seen", msg({ id: mid("s1"), subject: "sent" })))).toMatch(/OK/);
      expect(await run(appendCmd("Junk Mail", "", msg({ id: mid("j1"), subject: "junk" })))).toMatch(/OK/);
    });
    await asUser(destAddress, destPassword, async (run) => {
      expect(await run(appendCmd("INBOX", "", msg({ id: mid("already"), subject: "arrived by forwarding" })))).toMatch(
        /OK/,
      );
    });
    before = await snapshot(sourceAddress, sourcePassword, SOURCE_FOLDERS);
    sourceSamples = (await samplesOf(ids.source)).length;

    // Control plane: a person who owns the account and the destination mailbox, with a fresh step-up.
    ids.user = randomUUID();
    await db
      .insert(schema.authUser)
      .values({ id: ids.user, name: "Owner", email: `owner-${tag}@example.test`, emailVerified: true });
    const [account] = await db
      .insert(schema.customerAccount)
      .values({ name: `import ${tag}` })
      .returning();
    ids.account = account?.id ?? "";
    await db.insert(schema.accountMembership).values({ accountId: ids.account, userId: ids.user, role: "owner" });
    const [m] = await db
      .insert(schema.mailbox)
      .values({
        accountId: ids.account,
        userId: ids.user,
        address: destAddress,
        quotaBytes: 50 * 1024 * 1024,
        status: "active",
        stalwartId: ids.dest,
      })
      .returning();
    ids.mailbox = m?.id ?? "";
    await db.insert(schema.authVerification).values({
      id: randomUUID(),
      identifier: `step-up-${SESSION}`,
      value: ids.user,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
  });

  it(
    "copies everything exactly once across an importer killed mid-run and restarted",
    { timeout: 180_000 },
    async () => {
      const { import: started } = await start({});
      firstImport = started.id;
      const stored = await row(started.id);
      expect(stored?.sourceSecret).toMatch(/^v1\./);
      expect(stored?.destinationSecret).toMatch(/^v1\./);
      expect(stored?.destinationSecret).not.toContain("app_");

      const first = importer();
      await waitFor("a few appends", async () => ((await row(started.id))?.messagesDone ?? 0) >= 3, 90_000);
      first.kill("SIGKILL");
      await waitFor("the kill", async () => first.signalCode !== null || first.exitCode !== null, 10_000);
      const killedAt = (await row(started.id))?.messagesDone ?? 0;
      expect(killedAt).toBeLessThan(15);
      // Dead for real: nothing moves while no importer runs (its lease still holds the import for ten seconds).
      await new Promise((r) => setTimeout(r, 2000));
      expect((await row(started.id))?.messagesDone).toBe(killedAt);
      expect((await row(started.id))?.status).toBe("running");

      const second = importer();
      const done = await waitFor(
        "the import to complete",
        async () => {
          const r = await row(started.id);
          return r?.status === "completed" ? r : null;
        },
        120_000,
      );
      await stop(second);

      // INBOX: a1, a2, the one without Message-ID and 8 fillers; the duplicate a1, "already" (forwarded first) and the
      // \Deleted one are not copied. Projects/2015/Q1: 2; Übersicht: 1; Sent: 1; Junk left out.
      const inbox = await destination("INBOX");
      const imported = inbox.filter((m) => m.top.startsWith(`${IMPORT_MARKER_HEADER}: ${started.id}`));
      expect(imported).toHaveLength(11);
      expect(new Set(inbox.map((m) => m.id)).size).toBe(inbox.length);
      expect(inbox.filter((m) => m.id === mid("already"))).toHaveLength(1);
      expect(inbox.some((m) => m.id === mid("a5"))).toBe(false);
      const flagged = inbox.find((m) => m.id === mid("a1"));
      expect(flagged?.flags.split(" ").sort()).toEqual(["$forwarded", "\\flagged", "\\seen", "custom_kw"]);
      expect(flagged?.date).toBe("03-Feb-2015 10:00:00 +0000");
      expect(inbox.find((m) => m.id === mid("a2"))?.flags).toContain("\\answered");
      expect(await destination("Projects/2015/Q1")).toHaveLength(2);
      expect(await destination(UMLAUT)).toHaveLength(1);
      expect((await destination("Sent Items")).map((m) => m.id)).toEqual([mid("s1")]);
      expect(await destination("Junk Mail")).toEqual([]);
      expect(await destination("Imported Junk")).toEqual([]);
      // 15 copied and 2 skipped (the second a1, "already"); a message appended by the killed run after its last
      // checkpoint is found in the destination on resume and counted as a duplicate (at-least-once copy,
      // exactly-once result).
      expect(done.messagesDone + done.duplicates).toBe(17);
      expect(done.messagesDone).toBeLessThanOrEqual(15);

      // The source was only read.
      expect(await snapshot(sourceAddress, sourcePassword, SOURCE_FOLDERS)).toBe(before);
      // Wiped in the write that ended it.
      expect(done).toMatchObject({ sourceSecret: null, destinationSecret: null, sourceUsername: null });
      expect(done.credentialsWipedAt).not.toBeNull();
      expect(done.sourceHost).toBe("IP address");
      const folders = await deps.uow.run((r) => r.imports.folders(started.id));
      expect(folders.length).toBeGreaterThanOrEqual(5);
      expect(folders.every((f) => f.sourcePath === null)).toBe(true);
    },
  );

  it("leaves no credential or training sample behind once the worker's jobs ran", { timeout: 120_000 }, async () => {
    expect((await keys.provisioning.credentialInventory(ids.dest)).importCredentials).toHaveLength(1);
    const ran = await runJobs(firstImport);
    expect(ran).toContain("mail_import.credential_revoke");
    expect(ran).toContain("mail_import.training_cleanup");
    expect((await keys.provisioning.credentialInventory(ids.dest)).importCredentials).toEqual([]);
    // Every ham sample on the destination is gone (the killed slice's window covers the message appended at set-up
    // too: the window match can't tell them apart); the source account's samples are untouched.
    expect((await samplesOf(ids.dest)).filter((s) => s.isSpam !== true)).toEqual([]);
    expect(await samplesOf(ids.source)).toHaveLength(sourceSamples);
  });

  it(
    "an incremental sync copies only new mail and skips what arrived over SMTP first",
    { timeout: 180_000 },
    async () => {
      const { import: sync } = await start({ sync: true });
      const proc = importer();
      await waitFor("the first pass", async () => (await row(sync.id))?.status === "syncing", 90_000);
      expect((await row(sync.id))?.messagesDone).toBe(0);
      // New mail at the old provider: one fresh, one that was also forwarded to the new address first.
      await deliver(msg({ id: mid("forwarded"), subject: "forwarded during the switch" }));
      await waitFor(
        "the SMTP delivery",
        async () => (await destination("INBOX")).some((m) => m.id === mid("forwarded")),
        30_000,
      );
      await asUser(sourceAddress, sourcePassword, async (run) => {
        expect(await run(appendCmd("INBOX", "", msg({ id: mid("new"), subject: "new after the first pass" })))).toMatch(
          /OK/,
        );
        expect(
          await run(appendCmd("INBOX", "", msg({ id: mid("forwarded"), subject: "forwarded during the switch" }))),
        ).toMatch(/OK/);
      });
      // "Stop syncing": the last pass copies what is new, then the import completes.
      await stopImportSync(
        deps,
        {
          kind: "user",
          userId: ids.user,
          email: `owner-${tag}@example.test`,
          platformRoles: [],
          memberships: [{ accountId: ids.account, role: "owner" }],
          suspended: false,
        },
        ids.account,
        sync.id,
        { requestId: `it-${tag}-stop`, ip: null, userAgent: null },
      );
      const done = await waitFor(
        "the last pass",
        async () => {
          const r = await row(sync.id);
          return r?.status === "completed" ? r : null;
        },
        90_000,
      );
      await stop(proc);
      expect(done.messagesDone).toBe(1);
      const inbox = await destination("INBOX");
      expect(inbox.filter((m) => m.id === mid("new"))).toHaveLength(1);
      expect(inbox.filter((m) => m.id === mid("forwarded"))).toHaveLength(1);
      await runJobs(sync.id);
      expect((await keys.provisioning.credentialInventory(ids.dest)).importCredentials).toEqual([]);
      expect((await samplesOf(ids.dest)).filter((s) => s.isSpam !== true)).toEqual([]);
    },
  );

  it("logged no secret, sign-in name or folder name", () => {
    const all = logs.join("\n");
    expect(all).toContain("importer started");
    for (const secret of [
      sourcePassword,
      destPassword,
      sourceAddress,
      "app_",
      "Projects",
      UMLAUT,
      "Übersicht",
      "Sent Items",
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
