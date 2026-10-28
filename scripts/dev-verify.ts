// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Proves the dev mail stack (docs/internal/handoff.md "How the dev stack was verified"):
 *   1. Stalwart is ready and the seeded dev.test mailboxes exist.
 *   2. alice@dev.test -> bob@dev.test over JMAP submission arrives in bob's Inbox (read over JMAP).
 *   3. Mail to an external address lands in Mailpit, and the remote route is Mailpit.
 *   4. The Stalwart container has no route to the internet.
 *   5. Mail clients can sign in over every protocol we offer: IMAP (993), POP3 (995) and SMTP submission (465)
 *      with TLS, plus greetings on SMTP 587 (STARTTLS) and ManageSieve (4190).
 *   6. Sender identity (ADR-0019): an authenticated submission with a forged header From, two From lines or a
 *      null envelope sender is refused.
 *   7. A submitted message reaches a local mailbox without any Authentication-Results header, so a sender can't
 *      plant results our server never produced (07-security.md "Authentication results in the webmail").
 *
 *   npm run stack:verify      (after `npm run stack:up` and `npm run db:seed`)
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { JmapClient } from "@anhourmail/jmap-client";
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";

import { DEV_DOMAIN } from "../infra/stalwart/dev-plan";

const base = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const mailpit = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? "43026"}`;
const password = process.env.DEV_MAILBOX_PASSWORD ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jmapFor = (local: string) =>
  new JmapClient({
    sessionUrl: `${base}/jmap/session`,
    authorization: `Basic ${Buffer.from(`${local}@${DEV_DOMAIN}:${password}`).toString("base64")}`,
  });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await sleep(500);
  }
  return undefined;
}

await stalwartDevAdmin().ready();
check("Stalwart ready", true);
check("Remote route is Mailpit", (await stalwartDevAdmin().remoteRoute()) === "mailpit");

const alice = jmapFor("alice");
const bob = jmapFor("bob");
check("alice JMAP session", (await alice.accountId()).length > 0);
check("bob JMAP session", (await bob.accountId()).length > 0);

// Internal delivery: alice -> bob
const token = randomUUID().slice(0, 8);
await alice.sendText({
  from: `alice@${DEV_DOMAIN}`,
  to: [`bob@${DEV_DOMAIN}`],
  subject: `stack-verify internal ${token}`,
  text: "Internal delivery check.",
});
const inbox = await bob.mailboxByRole("inbox");
const got = inbox
  ? await waitFor(async () =>
      (await bob.listEmails(inbox.id, 20)).find((e) => e.subject === `stack-verify internal ${token}`),
    )
  : undefined;
check("alice -> bob visible in bob's Inbox via JMAP", got !== undefined);

// External delivery: must land in Mailpit
const external = `someone-${token}@example.com`;
await alice.sendText({
  from: `alice@${DEV_DOMAIN}`,
  to: [external],
  subject: `stack-verify external ${token}`,
  text: "Must stay on this machine.",
});
const caught = await waitFor(async () => {
  const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${external}`)}`);
  const body = (await res.json()) as { messages_count?: number };
  return (body.messages_count ?? 0) > 0 ? true : undefined;
});
check("external recipient captured by Mailpit", caught === true);

// Egress: the Stalwart container cannot reach the internet at all
let egressBlocked = false;
try {
  execFileSync("docker", ["compose", "exec", "-T", "stalwart", "curl", "-sS", "-m", "5", "https://example.com"], {
    stdio: "pipe",
  });
} catch {
  egressBlocked = true;
}
check("Stalwart container has no internet egress", egressBlocked);

// Protocols: dev certificates are self-signed, so TLS verification is off here (dev only).
type Wire = { send(line: string): void; read(until: RegExp): Promise<string>; close(): void };
function wire(port: number, secure: boolean): Promise<Wire> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const socket = secure
      ? tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false })
      : net.connect({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (buf += d));
    socket.once("error", reject);
    socket.once(secure ? "secureConnect" : "connect", () => {
      resolve({
        send: (line) => {
          socket.write(`${line}\r\n`);
        },
        read: async (until) => {
          for (let i = 0; i < 100; i++) {
            if (until.test(buf)) {
              const out = buf;
              buf = "";
              return out;
            }
            await sleep(50);
          }
          throw new Error(`timeout waiting for ${until.source} (got ${buf.slice(0, 80)})`);
        },
        close: () => {
          socket.destroy();
        },
      });
    });
  });
}
const port = (k: string, d: number) => Number(process.env[k] ?? d);
const user = `alice@${DEV_DOMAIN}`;

async function protocolCheck(name: string, fn: () => Promise<boolean>) {
  try {
    check(name, await fn());
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
  }
}

await protocolCheck("IMAP 993: TLS sign-in", async () => {
  const w = await wire(port("STALWART_IMAPS_PORT", 993), true);
  await w.read(/^\* OK/m);
  w.send(`a1 LOGIN "${user}" "${password}"`);
  const res = await w.read(/^a1 /m);
  w.close();
  return /^a1 OK/m.test(res);
});
await protocolCheck("POP3 995: TLS sign-in", async () => {
  const w = await wire(port("STALWART_POP3S_PORT", 995), true);
  await w.read(/^\+OK/m);
  w.send(`USER ${user}`);
  await w.read(/^[+-]/m);
  w.send(`PASS ${password}`);
  const res = await w.read(/^[+-]/m);
  w.close();
  return res.startsWith("+OK");
});
await protocolCheck("SMTP 465: TLS AUTH PLAIN", async () => {
  const w = await wire(port("STALWART_SUBMISSIONS_PORT", 465), true);
  await w.read(/^220 /m);
  w.send("EHLO verify.local");
  await w.read(/^250 /m);
  w.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`);
  const res = await w.read(/^\d{3} /m);
  w.close();
  return res.startsWith("235");
});
/** SMTP AUTH submission as alice with a given header From; resolves to the DATA reply (ADR-0019). */
async function submitWithHeaderFrom(
  headerFrom: string,
  opts: { to?: string; subject?: string; extra?: string } = {},
): Promise<string> {
  const to = opts.to ?? `sender-check-${randomUUID().slice(0, 8)}@example.com`;
  const w = await wire(port("STALWART_SUBMISSIONS_PORT", 465), true);
  await w.read(/^220 /m);
  w.send("EHLO verify.local");
  await w.read(/^250 /m);
  w.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`);
  await w.read(/^\d{3} /m);
  w.send(`MAIL FROM:<${user}>`);
  await w.read(/^\d{3} /m);
  w.send(`RCPT TO:<${to}>`);
  await w.read(/^\d{3} /m);
  w.send("DATA");
  await w.read(/^354 /m);
  const subject = opts.subject ?? "sender identity check";
  w.send(`From: ${headerFrom}\r\nTo: ${to}\r\nSubject: ${subject}\r\n${opts.extra ?? ""}\r\nx\r\n.`);
  const res = await w.read(/^\d{3} /m);
  w.send("QUIT");
  w.close();
  return res;
}
await protocolCheck("Sender identity: own header From accepted", async () =>
  (await submitWithHeaderFrom(user)).startsWith("250"),
);
await protocolCheck("Sender identity: forged header From refused", async () =>
  /^5\d\d /m.test(await submitWithHeaderFrom(`bob@${DEV_DOMAIN}`)),
);
await protocolCheck("Sender identity: two From lines refused", async () =>
  /^5\d\d /m.test(await submitWithHeaderFrom(`${user}\r\nFrom: bob@${DEV_DOMAIN}`)),
);
await protocolCheck("Sender identity: authenticated null sender (MAIL FROM:<>) refused", async () => {
  const w = await wire(port("STALWART_SUBMISSIONS_PORT", 465), true);
  await w.read(/^220 /m);
  w.send("EHLO verify.local");
  await w.read(/^250 /m);
  w.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`);
  await w.read(/^\d{3} /m);
  w.send("MAIL FROM:<>");
  const res = await w.read(/^\d{3} /m);
  w.send("QUIT");
  w.close();
  return /^5\d\d /m.test(res);
});
await protocolCheck("Submission: Authentication-Results headers stripped before local delivery", async () => {
  const subject = `stack-verify results ${randomUUID().slice(0, 8)}`;
  const forged = `Authentication-Results: mail.${DEV_DOMAIN}; dkim=pass header.d=bank.example; dmarc=pass\r\n`;
  const reply = await submitWithHeaderFrom(user, { to: `bob@${DEV_DOMAIN}`, subject, extra: forged });
  if (!reply.startsWith("250") || !inbox) return false;
  const delivered = await waitFor(async () => (await bob.listEmails(inbox.id, 20)).find((e) => e.subject === subject));
  if (!delivered) return false;
  const res = await bob.request([
    ["Email/get", { accountId: await bob.accountId(), ids: [delivered.id], properties: ["headers"] }, "g"],
  ]);
  const list = (res.get("g")?.list ?? []) as { headers?: { name: string }[] }[];
  const names = (list[0]?.headers ?? []).map((h) => h.name.toLowerCase());
  return names.includes("from") && !names.includes("authentication-results");
});
await protocolCheck("IMAP 143: greeting + STARTTLS offered", async () => {
  const w = await wire(port("STALWART_IMAP_PORT", 143), false);
  const res = await w.read(/^\* OK/m);
  w.send("a0 CAPABILITY");
  const caps = await w.read(/^a0 /m);
  w.close();
  return /STARTTLS/i.test(res + caps);
});
await protocolCheck("POP3 110: greeting + STLS offered", async () => {
  const w = await wire(port("STALWART_POP3_PORT", 110), false);
  await w.read(/^\+OK/m);
  w.send("CAPA");
  const caps = await w.read(/^\.\r?$/m);
  w.close();
  return /STLS/i.test(caps);
});
await protocolCheck("SMTP 25: inbound greeting", async () => {
  const w = await wire(port("STALWART_SMTP_PORT", 25), false);
  const res = await w.read(/^220 /m);
  w.close();
  return res.startsWith("220");
});
await protocolCheck("SMTP 587: greeting + STARTTLS offered", async () => {
  const w = await wire(port("STALWART_SUBMISSION_PORT", 587), false);
  await w.read(/^220 /m);
  w.send("EHLO verify.local");
  const res = await w.read(/^250 /m);
  w.close();
  return /STARTTLS/i.test(res);
});
await protocolCheck("SMTP 587: no AUTH mechanisms offered before STARTTLS", async () => {
  const w = await wire(port("STALWART_SUBMISSION_PORT", 587), false);
  await w.read(/^220 /m);
  w.send("EHLO verify.local");
  const res = await w.read(/^250 /m);
  w.close();
  return !/^250[ -]AUTH/im.test(res);
});
await protocolCheck("ManageSieve 4190: greeting", async () => {
  const w = await wire(port("STALWART_SIEVE_PORT", 4190), false);
  const res = await w.read(/^OK/m);
  w.close();
  return /"IMPLEMENTATION"/i.test(res);
});

console.log(failures === 0 ? "\nstack:verify — all checks passed." : `\nstack:verify — ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
