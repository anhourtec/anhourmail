// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The mail import's destination credential and the mail server behaviour the importer depends on (ADR-0030 §1 and
 * "What the pinned Stalwart v0.16.27 does"), against the real dev Stalwart. The code under test runs with the
 * production credentials (ADR-0020 "Credential split"): the customer account is made with the provisioning key, the
 * credential minted with the operations key and revoked with the provisioning key. The dev admin only observes
 * (spam-training samples) and lifts the bans this test's deliberate refusals cause.
 *
 * Pinned on every Stalwart upgrade (rule 22); a failure here means the importer's assumptions changed:
 *   - customer accounts have room for seven credentials, and the credential is exactly the import one;
 *   - IMAP CREATE (parents too) and SUBSCRIBE work for a customer account; APPEND keeps INTERNALDATE and keywords;
 *   - Stalwart doesn't de-duplicate, and `SEARCH HEADER Message-ID` finds nothing (dedupe must read the headers);
 *   - a literal over 50 MiB is refused up front; GETQUOTAROOT answers with the account quota;
 *   - APPEND runs no Sieve and no spam filter, but it does feed the spam classifier's training samples by folder
 *     (Junk, or the `$Junk` keyword: spam; anything else: ham), so the importer drops spam-training keywords and the
 *     training question is recorded in ADR-0030;
 *   - a command the credential doesn't allow gets no tagged reply (the importer must never send one);
 *   - SMTP, POP3 and JMAP refuse the credential; revoking it cuts an open IMAP session off; `expiresAt` ends it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { afterAll, describe, expect, it } from "vitest";

import {
  IMPORT_CREDENTIAL_DESCRIPTION,
  isImportCredential,
  StalwartManagement,
  StalwartTransport,
} from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { imapSession } from "./int-imap";
import { issueTestKeys } from "./int-keys";

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
const domain = `imp-${tag}.test`;
const address = `dest@${domain}`;
/** RFC 5737 documentation range, random per run: this test's deliberate wrong-credential sign-ins count here. */
const clientAddress = `203.0.113.${String(1 + Math.floor(Math.random() * 254))}`;
const bansBefore = new Set<string>();
const port = (k: string, d: number) => Number(process.env[k] ?? d);

const bans = () => mgmt.transport.getAll<{ id: string; address: string }>("x:BlockedIp", ["address"]);

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

/** A customer account as `mailbox.ensure` makes it (provisioning key, customer permissions). */
async function customerAccount(): Promise<string> {
  for (const b of await bans()) bansBefore.add(b.id);
  await keys.provisioning.upsertDomain({ name: domain });
  return keys.provisioning.upsertUser({
    name: "dest",
    domain,
    password: await hashPassword(randomBytes(18).toString("base64url")),
    quotaBytes: 50 * 1024 * 1024,
    suspended: false,
  });
}

/** An APPEND with a non-synchronising literal (the server offers LITERAL+). */
const append = (folder: string, flags: string, raw: string) =>
  `APPEND "${folder}" (${flags}) "03-Feb-2015 10:00:00 +0000" {${String(Buffer.byteLength(raw))}+}\r\n${raw}`;

const message = (id: string | null, subject: string) =>
  [
    `From: someone@old-${tag}.test`,
    `To: ${address}`,
    `Subject: ${subject}`,
    ...(id === null ? [] : [`Message-ID: <${id}>`]),
    "Date: Tue, 3 Feb 2015 10:00:00 +0000",
    "",
    "hello",
    "",
  ].join("\r\n");

const signedIn = async (secret: string) => {
  const s = await imapSession();
  expect(await s.run(`LOGIN "${address}" "${secret}"`)).toMatch(/^t1 OK/m);
  return s;
};

/** A tagged reply never came: the server either kept quiet or closed the connection. */
const noTaggedReply = (reply: string) => reply.endsWith("<no reply>") || reply.endsWith("<closed>");

/** One line-based exchange on a mail port (dev certificates are self-signed: verification off, dev only). */
async function converse(p: number, lines: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: "127.0.0.1", port: p, rejectUnauthorized: false });
    const replies: string[] = [];
    let buf = "";
    let i = -1;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(replies);
    };
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      buf += d;
      clearTimeout(timer);
      timer = setTimeout(() => {
        replies.push(buf.trim());
        buf = "";
        i += 1;
        if (i >= lines.length) finish();
        else socket.write(`${lines[i] ?? ""}\r\n`);
      }, 300);
    });
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 15_000).unref();
  });
}

/** Inbound SMTP on port 25, as another mail server would deliver. */
async function deliver(subject: string): Promise<string[]> {
  const lines = [
    "EHLO sender.test",
    `MAIL FROM:<someone@sender-${tag}.test>`,
    `RCPT TO:<${address}>`,
    "DATA",
    `From: someone@sender-${tag}.test\r\nTo: ${address}\r\nSubject: ${subject}\r\n\r\nhello\r\n.`,
    "QUIT",
  ];
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: port("STALWART_SMTP_PORT", 25) });
    const replies: string[] = [];
    let buf = "";
    let i = -1;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(replies);
    };
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      buf += d;
      clearTimeout(timer);
      timer = setTimeout(() => {
        replies.push(buf.trim().split("\r\n").at(-1) ?? "");
        buf = "";
        i += 1;
        if (i >= lines.length || replies.some((r) => /^5\d\d /.test(r))) finish();
        else socket.write(`${lines[i] ?? ""}\r\n`);
      }, 300);
    });
    socket.on("close", finish);
    socket.on("error", finish);
    setTimeout(finish, 15_000).unref();
  });
}

const sessionStatus = async (secret: string) =>
  (
    await fetch(`${stalwartUrl}/jmap/session`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${address}:${secret}`).toString("base64")}`,
        "X-Forwarded-For": clientAddress,
      },
    })
  ).status;

const trainingSamples = async (accountId: string) =>
  (
    await mgmt.transport.getAll<{ id: string; accountId?: string; isSpam?: boolean }>("x:SpamTrainingSample", [
      "accountId",
      "isSpam",
    ])
  ).filter((s) => s.accountId === accountId);

let accountId = "";
let secret = "";
let credential = { id: "", createdAt: new Date(0) };

describe("mail import credential on Stalwart (ADR-0030)", () => {
  it("is minted by the operations key on a customer account with room for seven credentials", async () => {
    accountId = await customerAccount();
    const [account] = await keys.provisioning.transport.getAll<{ id: string; quotas?: Record<string, unknown> }>(
      "x:Account",
      ["quotas"],
      [accountId],
    );
    expect(account?.quotas?.maxAppPasswords).toBe(7);

    const asked = new Date(Date.now() + 7 * 86_400_000 + 750);
    const made = await keys.operations.createImportCredential(accountId, asked);
    secret = made.secret;
    credential = { id: made.id, createdAt: made.createdAt };
    expect(secret).toMatch(/^app_/);
    expect(made.expiresAt.getTime() % 1000).toBe(0);
    expect(made.expiresAt.getTime()).toBeLessThanOrEqual(asked.getTime());

    const [stored] = await keys.operations.transport.getAll<{
      id: string;
      description?: string;
      createdAt?: string;
      expiresAt?: string;
      permissions?: unknown;
    }>("x:AppPassword", ["description", "createdAt", "expiresAt", "permissions"], [made.id], accountId);
    expect(stored?.description).toBe(IMPORT_CREDENTIAL_DESCRIPTION);
    expect(
      isImportCredential({
        description: stored?.description,
        permissions: stored?.permissions,
        createdAt: stored?.createdAt ? new Date(stored.createdAt) : null,
        expiresAt: stored?.expiresAt ? new Date(stored.expiresAt) : null,
      }),
    ).toBe(true);
    // The provisioning key sees it in the account's credential list (what the revoke job and the reconciler read).
    const inventory = await keys.provisioning.credentialInventory(accountId);
    expect(inventory.appPasswords.map((a) => a.id)).toContain(made.id);
  });

  it("creates folders, appends keeping dates and keywords, doesn't de-duplicate and can't search Message-IDs", async () => {
    const s = await signedIn(secret);
    try {
      const caps = await s.run("CAPABILITY");
      for (const c of ["UIDPLUS", "LITERAL+", "SPECIAL-USE", "QUOTA"]) expect(caps).toContain(c);

      expect(await s.run(`CREATE "Imported/Old Stuff"`)).toMatch(/^t3 OK/m);
      expect(await s.run(`SUBSCRIBE "Imported/Old Stuff"`)).toMatch(/^t4 OK/m);
      const list = await s.run(`LIST "" "Imported*"`);
      expect(list).toContain(`"Imported"`);
      expect(list).toContain(`"Imported/Old Stuff"`);

      const id = `m-${tag}@old.test`;
      const raw = message(id, `kept ${tag}`);
      const first = await s.run(append("Imported/Old Stuff", "\\Seen \\Flagged $Forwarded custom_kw", raw));
      expect(first).toMatch(/OK \[APPENDUID \d+ \d+\]/);
      expect(await s.run(append("Imported/Old Stuff", "\\Seen", raw))).toMatch(/OK \[APPENDUID/);

      expect(await s.run(`EXAMINE "Imported/Old Stuff"`)).toMatch(/\* 2 EXISTS/);
      const fetched = await s.run(`UID FETCH 1:* (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])`);
      // Two copies of the same message: Stalwart doesn't de-duplicate.
      expect(fetched.match(/^\* \d+ FETCH/gm)).toHaveLength(2);
      expect(fetched).toContain(`INTERNALDATE "03-Feb-2015 10:00:00 +0000"`);
      const flags = /FLAGS \(([^)]*)\)/.exec(fetched)?.[1]?.toLowerCase().split(" ") ?? [];
      expect(flags.sort()).toEqual(["$forwarded", "\\flagged", "\\seen", "custom_kw"].sort());
      // The header read the dedupe index needs works with the credential.
      expect(fetched).toContain(`Message-ID: <${id}>`);

      const byId = await s.run(`UID SEARCH HEADER Message-ID "${id}"`);
      const bySubject = await s.run(`UID SEARCH SUBJECT "kept ${tag}"`);
      expect(bySubject).toMatch(/^\* SEARCH \d+ \d+/m);
      expect(
        /^\* SEARCH\s*$/m.test(byId),
        "Message-ID became searchable: the importer's dedupe could use SEARCH now (ADR-0030 §5)",
      ).toBe(true);

      // A literal over the 50 MiB request limit is refused before any bytes are sent (synchronising literal).
      expect(await s.run(`APPEND INBOX {62914560}`)).toMatch(/BAD .*52428800/);

      const quota = await s.run("GETQUOTAROOT INBOX");
      expect(quota).toMatch(/\* QUOTA "[^"]*" \(STORAGE \d+ 51200\)/);
    } finally {
      s.close();
    }
  });

  it("runs no Sieve and no spam filter on APPEND, but trains the spam classifier by folder", async () => {
    // A managed script that marks every delivered message, written as the web app writes one (operations key).
    await keys.operations.putSieveScript(accountId, "import-probe", 'require ["imap4flags"]; addflag "$sievemark";');
    const control = await deliver(`delivered ${tag}`);
    expect(control.some((r) => r.startsWith("250 2.0.0"))).toBe(true);

    expect(await trainingSamples(accountId)).toEqual([]);
    const s = await signedIn(secret);
    try {
      expect(await s.run(append("INBOX", "\\Seen", message(`a-${tag}@old.test`, `appended ${tag}`)))).toMatch(
        /OK \[APPENDUID/,
      );
      expect(await s.run(append("Junk Mail", "", message(`j-${tag}@old.test`, `junk ${tag}`)))).toMatch(
        /OK \[APPENDUID/,
      );
      expect(await s.run("SELECT INBOX")).toMatch(/OK/);
      const headers = async () =>
        s.run(`UID FETCH 1:* (FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT X-SPAM-STATUS AUTHENTICATION-RESULTS)])`);
      await expect.poll(headers, { timeout: 15_000 }).toContain(`delivered ${tag}`);
      const all = await headers();
      const parts = all.split(/^\* \d+ FETCH/m).slice(1);
      const delivered = parts.find((p) => p.includes(`delivered ${tag}`)) ?? "";
      const appended = parts.find((p) => p.includes(`appended ${tag}`)) ?? "";
      // The control: delivery runs the script and the spam filter.
      expect(delivered).toContain("$sievemark");
      expect(delivered).toMatch(/X-Spam-Status:/i);
      // APPEND runs neither (no mark, no spam verdict, no Authentication-Results of ours).
      expect(appended).not.toContain("$sievemark");
      expect(appended).not.toMatch(/X-Spam-Status:|Authentication-Results:/i);
    } finally {
      s.close();
    }
    // Every APPEND becomes a training sample: Junk as spam, anything else as ham (keywords other than `$Junk` don't
    // matter). If an upgrade stops this, ADR-0030's spam-training note can be revisited.
    await expect
      .poll(async () => (await trainingSamples(accountId)).map((x) => x.isSpam).sort(), { timeout: 10_000 })
      .toEqual([false, true]);
  });

  it("gets no reply to a command it isn't allowed, and is refused by SMTP, POP3 and JMAP", async () => {
    const refused = await Promise.all(
      [`UID STORE 1 +FLAGS (\\Deleted)`, "EXPUNGE", `DELETE "Imported"`, `RENAME "Imported" "Other"`].map(
        async (command) => {
          const s = await signedIn(secret);
          try {
            expect(await s.run(`SELECT "Imported/Old Stuff"`)).toMatch(/OK/);
            return await s.run(command);
          } finally {
            s.close();
          }
        },
      ),
    );
    expect(refused.map(noTaggedReply)).toEqual([true, true, true, true]);
    // Nothing was changed by them.
    const s = await signedIn(secret);
    try {
      expect(await s.run(`EXAMINE "Imported/Old Stuff"`)).toMatch(/\* 2 EXISTS/);
    } finally {
      s.close();
    }

    const plain = Buffer.from(`\0${address}\0${secret}`).toString("base64");
    const smtp = await converse(port("STALWART_SUBMISSIONS_PORT", 465), [
      "EHLO int-test",
      `AUTH PLAIN ${plain}`,
      `MAIL FROM:<${address}>`,
      "QUIT",
    ]);
    expect(smtp.some((r) => /^250 2\.1\.0/m.test(r))).toBe(false);

    const pop = await converse(port("STALWART_POP3S_PORT", 995), [`USER ${address}`, `PASS ${secret}`, "STAT", "QUIT"]);
    expect(pop.slice(2).some((r) => /^\+OK \d+ \d+/m.test(r))).toBe(false);

    const jmap = await fetch(`${stalwartUrl}/jmap`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${address}:${secret}`).toString("base64")}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": clientAddress,
      },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Email/query", { accountId }, "q"]],
      }),
    });
    const body = (await jmap.json().catch(() => ({}))) as { methodResponses?: [string, { type?: string }][] };
    const first = body.methodResponses?.[0];
    expect(jmap.ok ? first?.[0] === "error" && first[1].type === "forbidden" : true).toBe(true);
  });

  it("is cut off by the provisioning key's revocation, also in an open IMAP session", async () => {
    const s = await signedIn(secret);
    try {
      expect(await s.run("SELECT INBOX")).toMatch(/OK/);
      expect(await keys.provisioning.revokeAppPasswordCredential(accountId, credential.id, credential.createdAt)).toBe(
        true,
      );
      const after = await s.run("STATUS INBOX (MESSAGES)");
      expect(after).not.toMatch(/^t\d+ OK/m);
    } finally {
      s.close();
    }
    expect(await keys.provisioning.revokeAppPasswordCredential(accountId, credential.id, credential.createdAt)).toBe(
      false,
    );
    expect(await sessionStatus(secret)).toBe(401);
  });

  it("is refused by Stalwart after its expiry", async () => {
    const short = await keys.operations.createImportCredential(accountId, new Date(Date.now() + 3000));
    try {
      expect(await sessionStatus(short.secret)).toBe(200);
      await new Promise((r) => setTimeout(r, 4500));
      expect(await sessionStatus(short.secret)).toBe(401);
    } finally {
      await keys.provisioning.revokeAppPasswordCredential(accountId, short.id, short.createdAt);
    }
  });
});
