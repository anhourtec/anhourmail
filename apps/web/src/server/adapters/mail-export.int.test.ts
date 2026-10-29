// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail export from the webmail (ADR-0025) against the dev Stalwart (`npm run test:int`): two throwaway mailboxes on the
 * dev-only `dev.test` domain, each with its own messages; the signed-in mailbox's export holds its folders as mbox files
 * (mboxrd quoting intact) and its contacts, and nothing from the other mailbox. Passwords are random per run, hashed
 * before they reach the mail server, never printed. Both mailboxes are removed afterwards.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";

import { readZip } from "../../../../../tests/support/zip";
import { type MailExportSummary, mailExportStream } from "../webmail/export";
import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailRefusedError, WebmailService } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const run = randomBytes(4).toString("hex");
const boxes = {
  a: { name: `int-export-a-${run}`, password: randomBytes(18).toString("base64url"), id: "" },
  b: { name: `int-export-b-${run}`, password: randomBytes(18).toString("base64url"), id: "" },
};
const address = (k: keyof typeof boxes) => `${boxes[k].name}@dev.test`;
const TOKEN_A = `alpha-${run}`;
const TOKEN_B = `bravo-${run}`;

/** JMAP as the mailbox itself (Basic auth with its own password). */
async function jmap(k: keyof typeof boxes, calls: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${STALWART_URL}/jmap`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${address(k)}:${boxes[k].password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: calls }),
  });
  if (!res.ok) throw new Error(`JMAP HTTP ${String(res.status)}`);
  const body = (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
  return body.methodResponses.map(([, args]) => args);
}

async function accountOf(k: keyof typeof boxes): Promise<string> {
  const res = await fetch(`${STALWART_URL}/jmap/session`, {
    headers: { Authorization: `Basic ${Buffer.from(`${address(k)}:${boxes[k].password}`).toString("base64")}` },
  });
  const s = (await res.json()) as { primaryAccounts: Record<string, string> };
  return s.primaryAccounts["urn:ietf:params:jmap:mail"] ?? "";
}

/** Stores a message straight into a folder (no delivery: nothing leaves the stack). */
async function put(k: keyof typeof boxes, mailboxId: string, subject: string, body: string) {
  const accountId = await accountOf(k);
  const [res] = await jmap(k, [
    [
      "Email/set",
      {
        accountId,
        create: {
          e: {
            mailboxIds: { [mailboxId]: true },
            from: [{ email: address(k) }],
            to: [{ email: address(k) }],
            subject,
            bodyValues: { t: { value: body } },
            textBody: [{ partId: "t", type: "text/plain" }],
          },
        },
      },
      "s",
    ],
  ]);
  if (!(res?.created as Record<string, unknown> | undefined)?.e) throw new Error("message not stored");
}

async function folders(k: keyof typeof boxes) {
  const accountId = await accountOf(k);
  const [res] = await jmap(k, [["Mailbox/get", { accountId, ids: null, properties: ["id", "name", "role"] }, "m"]]);
  return { accountId, list: res?.list as { id: string; name: string; role: string | null }[] };
}

function service() {
  return new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
    stalwartUrl: STALWART_URL,
    access: { state: async () => "ok" as const },
    quota: memorySlidingQuota(),
    sieve: { read: async () => null, write: async () => undefined },
    confirmedForward: async () => null,
    defer: () => undefined,
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

let projectId = "";
let projectName = "";
beforeAll(async () => {
  for (const k of ["a", "b"] as const) {
    boxes[k].id = await stalwartDevAdmin().upsertUser({
      name: boxes[k].name,
      domain: "dev.test",
      password: await hashPassword(boxes[k].password),
      quotaBytes: 50 * 1024 * 1024,
    });
  }
  const a = await folders("a");
  const inboxA = a.list.find((f) => f.role === "inbox")?.id ?? "";
  // A second folder (Sent: customers' credentials can't create folders, ADR-0014), and a body line that an mbox reader
  // would take for a separator unless it's quoted.
  const sent = a.list.find((f) => f.role === "sent");
  if (!sent) throw new Error("no Sent folder");
  projectId = sent.id;
  projectName = sent.name;
  await put("a", inboxA, `${TOKEN_A} one`, `Hello\nFrom the start of a line\n>From quoted already\nbye`);
  await put("a", inboxA, `${TOKEN_A} two`, "second");
  await put("a", projectId, `${TOKEN_A} project`, "in a folder");
  const b = await folders("b");
  await put("b", b.list.find((f) => f.role === "inbox")?.id ?? "", `${TOKEN_B} private`, "not for A");
});

afterAll(async () => {
  for (const k of ["a", "b"] as const) if (boxes[k].id) await stalwartDevAdmin().destroy("x:Account", boxes[k].id);
});

describe("mail export from the webmail", () => {
  it("exports the signed-in mailbox's folders (mboxrd) and contacts, and nothing of another mailbox", async () => {
    const svc = service();
    const { sessionId } = await svc.signIn(address("a"), boxes.a.password);
    let done: { address: string; summary: MailExportSummary } | null = null;
    const zip = await collect(
      await mailExportStream(svc, sessionId, {}, async (addr, summary) => {
        done = { address: addr, summary };
      }),
    );
    const entries = readZip(zip);
    const names = entries.map((e) => e.name);
    expect(names).toContain("mail/Inbox.mbox");
    expect(names).toContain(`mail/${projectName}.mbox`);
    expect(names).toContain("contacts.vcf");
    expect(names).toContain("README.txt");
    const inbox = entries.find((e) => e.name === "mail/Inbox.mbox")?.data.toString("latin1") ?? "";
    expect(inbox.match(/^From MAILER-DAEMON /gm)).toHaveLength(2);
    expect(inbox).toContain(`${TOKEN_A} one`);
    expect(inbox).toContain(`${TOKEN_A} two`);
    expect(inbox).toContain("\n>From the start of a line");
    expect(inbox).toContain("\n>>From quoted already");
    const project = entries.find((e) => e.name === `mail/${projectName}.mbox`)?.data.toString("latin1") ?? "";
    expect(project).toContain(`${TOKEN_A} project`);
    expect(project).not.toContain(`${TOKEN_A} one`);
    // Nothing from mailbox B anywhere in A's archive.
    expect(zip.includes(Buffer.from(TOKEN_B))).toBe(false);
    for (const e of entries) expect(e.data.includes(Buffer.from(TOKEN_B))).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toMatchObject({ address: address("a"), summary: { messages: 3, skipped: 0, complete: true } });
    await svc.signOut(sessionId);
  });

  it("exports one folder on its own, and refuses a folder id the mailbox doesn't have", async () => {
    const svc = service();
    const { sessionId } = await svc.signIn(address("a"), boxes.a.password);
    const entries = readZip(
      await collect(await mailExportStream(svc, sessionId, { folderId: projectId }, async () => undefined)),
    );
    expect(entries.map((e) => e.name)).toEqual([`mail/${projectName}.mbox`, "README.txt"]);
    // Folder ids are per mailbox: an id this mailbox doesn't have is refused before anything is sent.
    await expect(
      mailExportStream(svc, sessionId, { folderId: `nope${run}` }, async () => undefined),
    ).rejects.toBeInstanceOf(WebmailRefusedError);
    await svc.signOut(sessionId);
  });
});
