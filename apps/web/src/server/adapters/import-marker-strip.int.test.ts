// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SA-66-01 (ADR-0030 run-66) against the dev Stalwart: the mail import marker can only come from our importer (IMAP
 * APPEND). A message that arrives over SMTP with `X-AnhourMail-Imported` as its very first header — from outside on
 * port 25, or from a signed-in mail app on submission (587, STARTTLS) — is delivered without it, so it can never show
 * as an imported copy with "the old provider's" results its sender wrote. Applies the current sender-identity and
 * inbound-headers scripts first, with the dev plan's own key, and reloads (as `db:seed` does).
 */
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { afterAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { resolveSenderDelegationKey } from "@anhourmail/core/webmail";
import { IMPORT_MARKER_HEADER } from "@anhourmail/shared/import";
import {
  applySenderIdentityPolicy,
  IMPORT_MARKER_HEADER as SCRIPT_MARKER,
  StalwartManagement,
  StalwartTransport,
} from "@anhourmail/stalwart-client";

import { imapSession } from "../../../../../packages/adapters/src/stalwart/int-imap";
import { isImportedCopy, originalChecks, parseHeaderBlock } from "../webmail/original";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!stalwartUrl || !admin || !adminPassword) throw new Error("integration tests need the dev Stalwart admin");

const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const domain = `strip-${tag}.test`;
const address = `me@${domain}`;
const password = `${randomBytes(12).toString("base64url")}-Int9`;
const OURS = ["mail.dev.test"];

afterAll(async () => {
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  for (let i = 0; i < 5; i++) {
    const d = (await mgmt.listDomains()).find((x) => x.name === domain);
    if (!d) break;
    const gone = await mgmt.destroyDomain(d.id).then(
      () => true,
      () => false,
    );
    if (gone) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
});

type Wire = { send(line: string): void; read(until: RegExp): Promise<string>; socket: net.Socket };

function wire(socket: net.Socket): Wire {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => (buf += d));
  return {
    socket,
    send: (line) => {
      socket.write(`${line}\r\n`);
    },
    read: async (until) => {
      for (let i = 0; i < 200; i++) {
        if (until.test(buf)) {
          const out = buf;
          buf = "";
          return out;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timeout waiting for ${until.source}`);
    },
  };
}

const connect = (port: number) =>
  new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => {
      resolve(s);
    });
    s.once("error", reject);
  });

/** A message whose very first header is our marker in the importer's exact form, with PASS results under it. */
const forged = (from: string, subject: string) =>
  [
    `${IMPORT_MARKER_HEADER}: ${randomUUID()}`,
    "Authentication-Results: mx.old.example; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example;",
    "\tdmarc=pass header.from=bank.example",
    `From: ${from}`,
    `To: ${address}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    `Date: ${new Date().toUTCString()}`,
    "",
    "hello",
    "",
  ].join("\r\n");

async function data(w: Wire, from: string, raw: string): Promise<string> {
  w.send(`MAIL FROM:<${from}>`);
  expect(await w.read(/^250 /m)).toMatch(/^250 /m);
  w.send(`RCPT TO:<${address}>`);
  expect(await w.read(/^250 /m)).toMatch(/^250 /m);
  w.send("DATA");
  await w.read(/^354 /m);
  w.send(`${raw.replace(/\r\n\.?$/, "")}\r\n.`);
  return w.read(/^\d{3} /m);
}

/** The stored copy's header block (INBOX or Junk Mail), polled until delivered. */
async function stored(subject: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const s = await imapSession();
    try {
      await s.run(`LOGIN "${address}" "${password}"`);
      for (const folder of ["INBOX", "Junk Mail"]) {
        await s.run(`EXAMINE "${folder}"`);
        const found = /\* SEARCH ([\d ]+)/.exec(await s.run(`UID SEARCH SUBJECT "${subject}"`))?.[1]?.trim();
        if (found) {
          const fetched = await s.run(`UID FETCH ${found.split(" ")[0] ?? ""} (BODY.PEEK[HEADER])`);
          return fetched.slice(fetched.indexOf("\r\n") + 2);
        }
      }
    } finally {
      s.close();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`not delivered: ${subject}`);
}

function expectStripped(block: string) {
  const headers = parseHeaderBlock(block);
  expect(headers.some((h) => h.name.toLowerCase() === IMPORT_MARKER_HEADER.toLowerCase())).toBe(false);
  expect(isImportedCopy(headers)).toBe(false);
  expect(originalChecks(headers, OURS).imported).toBe(false);
}

describe("the mail import marker never survives SMTP (SA-66-01, on the dev Stalwart)", () => {
  it("applies the current scripts and makes a mailbox", async () => {
    expect(SCRIPT_MARKER).toBe(IMPORT_MARKER_HEADER);
    await applySenderIdentityPolicy(mgmt, { onBehalfKey: resolveSenderDelegationKey(process.env) });
    // As the dev plan does after applying it: the scripts take effect on reload.
    await mgmt.reloadSettings();
    await mgmt.upsertDomain({ name: domain });
    await mgmt.upsertUser({
      name: "me",
      domain,
      password: await hashPassword(password),
      quotaBytes: 50 * 1024 * 1024,
      suspended: false,
    });
  });

  it("removes it from mail arriving from outside on port 25", async () => {
    const w = wire(await connect(Number(process.env.STALWART_SMTP_PORT ?? 25)));
    try {
      await w.read(/^220 /m);
      w.send("EHLO outside.example");
      await w.read(/^250 /m);
      const subject = `strip inbound ${tag}`;
      expect(await data(w, "alerts@outside.example", forged("Bank <alerts@outside.example>", subject))).toMatch(
        /^250 /m,
      );
      w.send("QUIT");
      expectStripped(await stored(subject));
    } finally {
      w.socket.destroy();
    }
  });

  it("removes it from a signed-in mail app's submission on 587 (STARTTLS)", async () => {
    const plain = wire(await connect(Number(process.env.STALWART_SUBMISSION_PORT ?? 587)));
    await plain.read(/^220 /m);
    plain.send("EHLO client.example");
    await plain.read(/^250 /m);
    plain.send("STARTTLS");
    await plain.read(/^220 /m);
    plain.socket.removeAllListeners("data");
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: plain.socket, rejectUnauthorized: false, servername: "localhost" }, () => {
        resolve(s);
      });
      s.once("error", reject);
    });
    const w = wire(secure);
    try {
      w.send("EHLO client.example");
      await w.read(/^250 /m);
      w.send(`AUTH PLAIN ${Buffer.from(`\0${address}\0${password}`).toString("base64")}`);
      expect(await w.read(/^\d{3} /m)).toMatch(/^235 /m);
      const subject = `strip submission ${tag}`;
      expect(await data(w, address, forged(`Me <${address}>`, subject))).toMatch(/^250 /m);
      w.send("QUIT");
      expectStripped(await stored(subject));
    } finally {
      secure.destroy();
    }
  });
});
