// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The importer's IMAP adapters against the real dev Stalwart (rule 19: no external server is ever contacted). The dev
 * server plays both sides: a throwaway `import-source@…` mailbox seeded here over IMAPS (never by `db:seed`) is the
 * "old provider", and a second mailbox with an import credential minted by the operations key is the destination.
 *
 * Asserts: the source's folders with special use and a non-ASCII name; UID ranges, flags, dates, Message-IDs and the
 * fallback fingerprint; the size cap; STARTTLS on 143; the source left byte-for-byte and flag-for-flag unchanged;
 * destination CREATE (nested) + SUBSCRIBE, APPEND keeping flags and dates, the dedupe index matching the source's keys
 * (a copy's marker line taken into account), quota and over-quota; certificate verification on by default; the net
 * guard refusing a private source that isn't on the dev allow-list; nothing secret in errors.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  dedupeKey,
  type DestinationSession,
  ImportConnectError,
  ImportSessionError,
  importMarkerLine,
  type SourceSession,
} from "@anhourmail/core/imports";
import { parseDevAllowList } from "@anhourmail/server/net-guard";
import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { imapSession } from "../stalwart/int-imap";
import { issueTestKeys } from "../stalwart/int-keys";
import { type ImapTarget, imapMailDestination, imapMailSource } from ".";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!stalwartUrl || !admin || !adminPassword) {
  throw new Error("integration tests need STALWART_URL and the dev Stalwart admin");
}

const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-${tag}.test`);
const domain = `imx-${tag}.test`;
const sourceAddress = `import-source@${domain}`;
const destAddress = `dest@${domain}`;
const fullAddress = `full@${domain}`;
const sourcePassword = randomBytes(18).toString("base64url");
const IMAPS = Number(process.env.STALWART_IMAPS_PORT ?? 993);
const IMAP = Number(process.env.STALWART_IMAP_PORT ?? 143);
const bansBefore = new Set<string>();
const bans = () => mgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"]);

/** The person "types" 127.0.0.1:993 / :143; the dev allow-list lets exactly that through; sockets go to the dev ports. */
const allow = parseDevAllowList("127.0.0.1:993,127.0.0.1:143", { NODE_ENV: "test" }, "IMPORT_DEV_ALLOW_SOURCES");
const connectTo = (t: ImapTarget) => ({ address: t.address, port: t.port === 143 ? IMAP : IMAPS });
const source = imapMailSource({ allow, connectTo });
const destinationOf = (insecureDevCertificate: boolean) =>
  imapMailDestination({
    endpoint: { host: "127.0.0.1", port: IMAPS },
    servername: "mail.dev.test",
    insecureDevCertificate,
  });

const signal = () => AbortSignal.timeout(30_000);
let destSecret = "";
let fullSecret = "";

afterAll(async () => {
  const added = (await bans()).filter((b) => !bansBefore.has(b.id));
  if (added.length > 0) {
    await mgmt.transport.set("x:BlockedIp", { destroy: added.map((b) => b.id) });
    await mgmt.transport.call([["x:Action/set", { create: { r: { "@type": "ReloadBlockedIps" } } }, "r"]]);
  }
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  await keys.cleanup();
});

const message = (opts: { id: string | null; subject: string; body?: string }) =>
  [
    `From: Someone <someone@old-${tag}.test>`,
    `To: ${sourceAddress}`,
    `Subject: ${opts.subject}`,
    ...(opts.id === null ? [] : [`Message-ID: <${opts.id}>`]),
    "Date: Tue, 3 Feb 2015 10:00:00 +0000",
    "",
    opts.body ?? "hello",
    "",
  ].join("\r\n");

const appendCmd = (folder: string, flags: string, raw: string, date = "03-Feb-2015 10:00:00 +0000") =>
  `APPEND "${folder}" (${flags}) "${date}" {${String(Buffer.byteLength(raw))}+}\r\n${raw}`;

/** "Übersicht" in modified UTF-7 (RFC 3501 §5.1.3). */
const UMLAUT_FOLDER = "&ANw-bersicht";

/** Flags and sizes of every message per folder, as a raw IMAP session sees them (for "the source is unchanged"). */
async function snapshot(): Promise<string> {
  const s = await imapSession();
  try {
    await s.run(`LOGIN "${sourceAddress}" "${sourcePassword}"`);
    const out: string[] = [];
    for (const f of ["INBOX", "Projects/2015", UMLAUT_FOLDER, "Sent Items"]) {
      const opened = await s.run(`EXAMINE "${f}"`);
      out.push(f, /\* (\d+) EXISTS/.exec(opened)?.[1] ?? "?");
      const fetched = await s.run("UID FETCH 1:* (UID FLAGS RFC822.SIZE INTERNALDATE)");
      out.push(
        ...fetched
          .split("\r\n")
          .filter((l) => l.startsWith("* "))
          .sort(),
      );
    }
    return out.join("\n");
  } finally {
    s.close();
  }
}

describe("IMAP adapters on the dev Stalwart (ADR-0030)", () => {
  let before = "";

  it("sets up a throwaway source mailbox and a destination with an import credential", async () => {
    for (const b of await bans()) bansBefore.add(b.id);
    await keys.provisioning.upsertDomain({ name: domain });
    const quotaBytes = 50 * 1024 * 1024;
    await keys.provisioning.upsertUser({
      name: "import-source",
      domain,
      password: await hashPassword(sourcePassword),
      quotaBytes,
      suspended: false,
    });
    const destId = await keys.provisioning.upsertUser({
      name: "dest",
      domain,
      password: await hashPassword(randomBytes(18).toString("base64url")),
      quotaBytes,
      suspended: false,
    });
    // A destination with almost no room, for the over-quota answer.
    const fullId = await keys.provisioning.upsertUser({
      name: "full",
      domain,
      password: await hashPassword(randomBytes(18).toString("base64url")),
      quotaBytes: 2048,
      suspended: false,
    });
    const week = new Date(Date.now() + 7 * 86_400_000);
    destSecret = (await keys.operations.createImportCredential(destId, week)).secret;
    fullSecret = (await keys.operations.createImportCredential(fullId, week)).secret;

    const s = await imapSession();
    try {
      expect(await s.run(`LOGIN "${sourceAddress}" "${sourcePassword}"`)).toMatch(/^t1 OK/m);
      expect(await s.run(`CREATE "Projects/2015"`)).toMatch(/OK/);
      expect(await s.run(`CREATE "${UMLAUT_FOLDER}"`)).toMatch(/OK/);
      const ok = /OK \[APPENDUID/;
      // INBOX: flags, a custom keyword, a duplicate Message-ID, one without a Message-ID, one deleted.
      expect(
        await s.run(
          appendCmd("INBOX", "\\Seen \\Flagged $Forwarded custom_kw", message({ id: `a-${tag}@old`, subject: "one" })),
        ),
      ).toMatch(ok);
      expect(await s.run(appendCmd("INBOX", "", message({ id: `a-${tag}@old`, subject: "one again" })))).toMatch(ok);
      expect(await s.run(appendCmd("INBOX", "\\Answered", message({ id: null, subject: "no id" })))).toMatch(ok);
      expect(
        await s.run(appendCmd("INBOX", "\\Deleted \\Seen", message({ id: `d-${tag}@old`, subject: "deleted" }))),
      ).toMatch(ok);
      expect(
        await s.run(
          appendCmd("INBOX", "", message({ id: `big-${tag}@old`, subject: "big", body: "x".repeat(20_000) })),
        ),
      ).toMatch(ok);
      expect(
        await s.run(appendCmd("Projects/2015", "\\Seen", message({ id: `p-${tag}@old`, subject: "project" }))),
      ).toMatch(ok);
      expect(await s.run(appendCmd(UMLAUT_FOLDER, "", message({ id: `u-${tag}@old`, subject: "umlaut" })))).toMatch(ok);
      expect(await s.run(appendCmd("Sent Items", "\\Seen", message({ id: `s-${tag}@old`, subject: "sent" })))).toMatch(
        ok,
      );
    } finally {
      s.close();
    }
    before = await snapshot();
  });

  let session: SourceSession;

  it("lists the source's folders with special use, a decoded non-ASCII name and their status", async () => {
    session = await source.connect(
      { host: "127.0.0.1", port: 993 },
      { kind: "password", username: sourceAddress, secret: sourcePassword },
      signal(),
    );
    const folders = await session.folders();
    const byPath = new Map(folders.map((f) => [f.path, f]));
    expect(byPath.get("INBOX")).toMatchObject({ messages: 5, selectable: true });
    expect(byPath.get("Sent Items")).toMatchObject({ specialUse: "\\Sent", specialUseSource: "server", messages: 1 });
    expect(byPath.get("Junk Mail")?.specialUse).toBe("\\Junk");
    expect(byPath.get("Deleted Items")?.specialUse).toBe("\\Trash");
    expect(byPath.get("Drafts")?.specialUse).toBe("\\Drafts");
    expect(byPath.get("Projects/2015")).toMatchObject({ delimiter: "/", messages: 1 });
    expect(byPath.get("Übersicht")).toMatchObject({ messages: 1, specialUse: null });
    expect(folders.filter((f) => f.selectable).every((f) => typeof f.uidValidity === "bigint")).toBe(true);
  });

  it("reads metadata by UID range with flags, dates, Message-IDs and the fallback fingerprint", async () => {
    const opened = await session.open("INBOX");
    expect(typeof opened.uidValidity).toBe("bigint");
    const all = await session.headers(0, 100);
    expect(all.map((m) => m.uid)).toEqual([1, 2, 3, 4, 5]);
    expect(all[0]).toMatchObject({ messageId: `a-${tag}@old`, internalDate: new Date("2015-02-03T10:00:00Z") });
    expect(all[0]?.flags.map((f) => f.toLowerCase()).sort()).toEqual([
      "$forwarded",
      "\\flagged",
      "\\seen",
      "custom_kw",
    ]);
    expect(all[1]?.messageId).toBe(all[0]?.messageId);
    expect(all[2]?.messageId).toBeNull();
    expect(all[2]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(all[3]?.flags).toContain("\\Deleted");
    // UID ranges: after a UID, with a limit; past the end nothing (not the last message).
    expect((await session.headers(2, 2)).map((m) => m.uid)).toEqual([3, 4]);
    expect(await session.headers(5, 10)).toEqual([]);
    expect(await session.headers(999, 10)).toEqual([]);
  });

  it("downloads one message, and refuses one over the size cap without reading it", async () => {
    const raw = await session.body(1, 1024 * 1024);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(raw as Uint8Array).toString("latin1")).toContain("Subject: one");
    expect(await session.body(5, 10_000)).toBe("too_large");
    expect(await session.body(5, 1024 * 1024)).toBeInstanceOf(Uint8Array);
    await session.close();
  });

  it("connects with STARTTLS on 143", async () => {
    const s = await source.connect(
      { host: "127.0.0.1", port: 143 },
      { kind: "password", username: sourceAddress, secret: sourcePassword },
      signal(),
    );
    try {
      expect((await s.folders()).some((f) => f.path === "INBOX")).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("left the source byte-for-byte and flag-for-flag as it was", async () => {
    expect(await snapshot()).toBe(before);
  });

  let dest: DestinationSession;

  it("creates nested folders, appends with flags and dates, and indexes keys that match the source's", async () => {
    dest = await destinationOf(true).connect(destAddress, destSecret, signal());
    const names = (await dest.folders()).map((f) => f.path);
    expect(names).toContain("INBOX");
    expect(names).toContain("Archive");
    await dest.ensureFolder("Imported/Projects/2015");
    await dest.ensureFolder("Imported/Projects/2015"); // idempotent
    expect((await dest.folders()).map((f) => f.path)).toEqual(
      expect.arrayContaining(["Imported", "Imported/Projects", "Imported/Projects/2015"]),
    );
    await dest.ensureFolder("Übersicht");
    expect((await dest.folders()).map((f) => f.path)).toContain("Übersicht");
    expect(await dest.index("Imported/Projects/2015")).toEqual(new Set());
    // Never into the shared-folders namespace (other accounts' folders), whatever the case.
    await expect(dest.ensureFolder("Shared Folders/someone/Inbox")).rejects.toBeInstanceOf(ImportSessionError);
    await expect(dest.append("shared folders/x", new Uint8Array([1]), [], null)).rejects.toBeInstanceOf(
      ImportSessionError,
    );

    const s = await source.connect(
      { host: "127.0.0.1", port: 993 },
      { kind: "password", username: sourceAddress, secret: sourcePassword },
      signal(),
    );
    try {
      await s.open("INBOX");
      const metas = await s.headers(0, 10);
      const importId = randomUUID();
      for (const m of metas.filter((x) => x.uid <= 3)) {
        const raw = await s.body(m.uid, 1024 * 1024);
        if (raw === "too_large") throw new Error("unexpected");
        const marked = Buffer.concat([Buffer.from(importMarkerLine(importId), "latin1"), raw]);
        const flags = m.flags.filter((f) => f !== "\\Recent");
        expect(await dest.append("Imported/Projects/2015", marked, flags, m.internalDate)).toBe("ok");
      }
      // Every source key is in the destination's index, the fingerprinted one too (the marker's length taken off).
      const index = await dest.index("Imported/Projects/2015");
      for (const m of metas.filter((x) => x.uid <= 3)) expect(index.has(dedupeKey(m))).toBe(true);
      expect(index.size).toBe(2); // two copies share a Message-ID
      expect(index.has(dedupeKey(metas[4] ?? { messageId: "x", fingerprint: "" }))).toBe(false);
    } finally {
      await s.close();
    }

    const quota = await dest.quota();
    expect(quota.limitBytes).toBe(50 * 1024 * 1024);
    expect(quota.usedBytes).toBeGreaterThanOrEqual(0);
    await dest.close();

    // What the append kept, as a mail app sees it.
    const raw = await imapSession();
    try {
      await raw.run(`LOGIN "${destAddress}" "${destSecret}"`);
      await raw.run(`EXAMINE "Imported/Projects/2015"`);
      const fetched = await raw.run(
        "UID FETCH 1 (FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (X-ANHOURMAIL-IMPORTED)])",
      );
      expect(fetched).toContain(`INTERNALDATE "03-Feb-2015 10:00:00 +0000"`);
      expect(fetched.toLowerCase()).toContain("$forwarded");
      expect(fetched).toContain("X-AnhourMail-Imported:");
      const subscribed = await raw.run(`LSUB "" "Imported*"`);
      expect(subscribed).toContain(`"Imported/Projects/2015"`);
    } finally {
      raw.close();
    }
  });

  it("answers over_quota when the destination is full", async () => {
    const full = await destinationOf(true).connect(fullAddress, fullSecret, signal());
    try {
      const big = Buffer.from(message({ id: `q-${tag}@old`, subject: "too big", body: "y".repeat(8192) }), "latin1");
      expect(await full.append("INBOX", big, [], null)).toBe("over_quota");
    } finally {
      await full.close();
    }
  });

  it("verifies the destination's certificate unless told it's the dev server", async () => {
    const err = await destinationOf(false)
      .connect(destAddress, destSecret, signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportConnectError);
    expect((err as ImportConnectError).code).toBe("certificate");
    expect(String(err)).not.toContain(destSecret);
  });

  it("refuses a private source that isn't on the dev allow-list, and a wrong password, with codes only", async () => {
    const strict = imapMailSource({ connectTo });
    const codes: [string, string][] = [];
    for (const host of ["127.0.0.1", "localhost", "10.0.0.1", "stalwart"]) {
      const err = await strict
        .connect({ host, port: 993 }, { kind: "password", username: sourceAddress, secret: sourcePassword }, signal())
        .catch((e: unknown) => e);
      codes.push([host, (err as ImportConnectError).code]);
    }
    expect(codes).toEqual(["127.0.0.1", "localhost", "10.0.0.1", "stalwart"].map((h) => [h, "blocked_address"]));
    const wrong = "not-the-password-" + randomBytes(6).toString("hex");
    const err = await source
      .connect({ host: "127.0.0.1", port: 993 }, { kind: "password", username: sourceAddress, secret: wrong }, signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportConnectError);
    expect((err as ImportConnectError).code).toBe("auth");
    expect(`${String(err)} ${JSON.stringify(err)}`).not.toContain(wrong);
    expect(`${String(err)} ${JSON.stringify(err)}`).not.toContain(sourceAddress);
  });
});
