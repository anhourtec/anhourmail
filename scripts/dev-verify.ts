// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Proves the dev mail stack (docs/internal/handoff.md "How the dev stack was verified"):
 *   1. Stalwart is ready and the seeded dev.test mailboxes exist.
 *   2. alice@dev.test -> bob@dev.test over JMAP submission arrives in bob's Inbox (read over JMAP).
 *   3. Mail to an external address lands in Mailpit, and the remote route is Mailpit.
 *   4. The Stalwart container has no route to the internet.
 *   5. Mail clients can sign in over every protocol we offer: IMAP (993), POP3 (995) and SMTP submission (465)
 *      with TLS, plus greetings on SMTP 587 (STARTTLS) and ManageSieve (4190).
 *   6. Sender identity (ADR-0019): an authenticated submission with a forged header From, two From lines, a second
 *      Sender header, a From/Sender field name written oddly (space or tab before the colon, mixed case) or a null
 *      envelope sender is refused, also when addressed to the sender's own mailbox. Send on behalf (ADR-0026 §8): From =
 *      the mailbox and Sender = a delegate pass only with the web app's tag for exactly that pair, that Message-ID and
 *      an expiry not yet passed (`onBehalfTag`), over SMTP and JMAP, and arrive without the tag or expiry header (in
 *      Mailpit and in a local mailbox's stored copy); a wrong, missing, empty, other-pair, other-message or
 *      other-expiry tag, an expired one, a missing, doubled or malformed expiry, a missing, doubled or unreadable
 *      Message-ID (even with the tag made for an empty one), odd Sender forms (group, `<>`, encoded word, source route)
 *      and a delegate putting the mailbox in From even with the tag are refused. Each case uses a fresh recipient so the per-recipient throttle never answers first.
 *   7. A submitted message reaches a local mailbox without any Authentication-Results header, so a sender can't
 *      plant results our server never produced (07-security.md "Authentication results in the webmail").
 *   9. Internal-mail marker (ADR-0019 update 2026-10-30): mail submitted here over JMAP or SMTP 465 is delivered with
 *      exactly one `X-AnhourMail-Internal` that the webmail's own check (`isInternalMail`) accepts for its From — a
 *      marker the client planted is replaced, none is added without a Message-ID; the same marker copied into a port 25
 *      message (with the same From and Message-ID) is removed on arrival, and our Authentication-Results are still read;
 *      a copy of that outside message redirected by a mailbox's own rule has no marker and no results the webmail would
 *      trust (not verified), while a redirected copy of internal mail keeps a valid marker. A different key fails the
 *      check (negative control).
 *  10. Forwarding guard (ADR-0019 updates "forwarding and DMARC"): the real generator's script on throwaway mailboxes —
 *      the pre-change script forwards our `dmarc=fail` (control); the start-up upgrade equals today's script and its
 *      compare-and-swap write loses to a save made in between; our `dmarc=fail`, own-domain or subdomain From without our
 *      top-most pass for that domain, two From headers or addresses, a planted pass and pass words injected through a
 *      quoted MAIL FROM are kept, not forwarded; foreign
 *      mail, another id's fail and internal mail are forwarded; the spam skip still applies; and Stalwart's regex engine
 *      matches the pass pattern at a header's end and its anchored form against our real header. Dev has no DNS, so a
 *      real DMARC pass or fail is a pre-staging check.
 *   8. Unknown local recipients (02-mail-infrastructure.md "Unknown recipients"): refused at RCPT with 550 on a
 *      domain without a catch-all, inbound on 25 and on authenticated submission (465); a catch-all domain still
 *      accepts them; a JMAP submission to one is created but reports the 550 in `deliveryStatus` (no bounce), which
 *      is what the webmail must show the sender. No message content is sent: each SMTP probe stops at RCPT.
 *
 *   npm run stack:verify      (after `npm run stack:up` and `npm run db:seed`)
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { hashPassword } from "@anhourmail/adapters/auth";
import {
  ON_BEHALF_EXPIRES_HEADER,
  ON_BEHALF_HEADER,
  onBehalfExpires,
  onBehalfTag,
  resolveSenderDelegationKey,
} from "@anhourmail/core/webmail";
import { JmapClient } from "@anhourmail/jmap-client";
import { INTERNAL_MAIL_HEADER, stalwartDevAdmin } from "@anhourmail/stalwart-client";

import { isInternalMail, ourAuthResultsHeader, trustedAuthservIds } from "../apps/web/src/server/webmail/original";
import { buildScript, DEFAULT_RULES, dmarcPassRegex, upgradeManagedScript } from "../apps/web/src/server/webmail/sieve";
import { MANAGED_SIEVE_SCRIPT } from "@anhourmail/shared/webmail";
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
type Wire = { send(line: string): void; read(until: RegExp, timeoutMs?: number): Promise<string>; close(): void };
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
        read: async (until, timeoutMs = 5000) => {
          for (let i = 0; i < timeoutMs / 50; i++) {
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
/**
 * SMTP AUTH submission (alice unless `as` is given) with a given header From; resolves to the DATA reply, or to the
 * first 4xx/5xx before it (ADR-0019).
 */
async function submitWithHeaderFrom(
  headerFrom: string,
  opts: {
    to?: string;
    subject?: string;
    extra?: string;
    as?: { user: string; password: string };
    /** Write the headers as given, with no `From:` line of our own. */
    raw?: boolean;
  } = {},
): Promise<string> {
  const to = opts.to ?? `sender-check-${randomUUID().slice(0, 8)}@example.com`;
  const login = opts.as ?? { user, password };
  await sleep(250); // stay under the per-IP throttle (5 / s): a 4xx would hide what the script decides
  const w = await wire(port("STALWART_SUBMISSIONS_PORT", 465), true);
  try {
    await w.read(/^220 /m);
    w.send("EHLO verify.local");
    await w.read(/^250 /m);
    w.send(`AUTH PLAIN ${Buffer.from(`\0${login.user}\0${login.password}`).toString("base64")}`);
    await w.read(/^\d{3} /m);
    for (const line of [`MAIL FROM:<${login.user}>`, `RCPT TO:<${to}>`]) {
      w.send(line);
      const reply = await w.read(/^\d{3} /m);
      if (/^[45]\d\d /m.test(reply)) return reply;
    }
    w.send("DATA");
    await w.read(/^354 /m);
    const subject = opts.subject ?? "sender identity check";
    const from = opts.raw === true ? headerFrom : `From: ${headerFrom}\r\n`;
    w.send(`${from}To: ${to}\r\nSubject: ${subject}\r\n${opts.extra ?? ""}\r\nx\r\n.`);
    const res = await w.read(/^\d{3} /m);
    w.send("QUIT");
    return res;
  } finally {
    w.close();
  }
}
/** A submission whose header block (apart from To and Subject) is exactly `headers`. */
const submitRaw = (headers: string, opts: { to?: string } = {}) =>
  submitWithHeaderFrom(headers, { ...opts, raw: true });
/** A DATA refusal by the sender-identity script (5.5.3), not a throttle or recipient answer. */
const refusedBySenderCheck = (reply: string) => /^5\d\d 5\.5\.3 /m.test(reply);
await protocolCheck("Sender identity: own header From accepted", async () =>
  (await submitWithHeaderFrom(user)).startsWith("250"),
);
await protocolCheck("Sender identity: forged header From refused", async () =>
  refusedBySenderCheck(await submitWithHeaderFrom(`bob@${DEV_DOMAIN}`)),
);
await protocolCheck("Sender identity: two From lines refused", async () =>
  refusedBySenderCheck(await submitWithHeaderFrom(`${user}\r\nFrom: bob@${DEV_DOMAIN}`)),
);
await protocolCheck("Sender identity: a second Sender header refused, even when one matches", async () =>
  refusedBySenderCheck(await submitWithHeaderFrom(user, { extra: `Sender: ${user}\r\nSender: bob@${DEV_DOMAIN}\r\n` })),
);
type Throwaway = { id: string; user: string; password: string };
/** A throwaway dev.test mailbox (fresh recipient throttle), removed again whatever happens. */
async function withThrowawayMailbox(label: string, fn: (m: Throwaway) => Promise<boolean>): Promise<boolean> {
  const admin = stalwartDevAdmin();
  const local = `verify-${label}-${token}`;
  const password = `Vs-${randomUUID()}-9!`;
  const id = await admin.upsertUser({
    name: local,
    domain: DEV_DOMAIN,
    password: await hashPassword(password),
    quotaBytes: 10 * 1024 ** 2,
    suspended: false,
  });
  try {
    return await fn({ id, user: `${local}@${DEV_DOMAIN}`, password });
  } finally {
    await admin.destroy("x:Account", id);
  }
}
await protocolCheck("Sender identity: forged From to the sender's own mailbox refused", async () =>
  // The control must be delivered and the forged one refused at DATA by the script.
  withThrowawayMailbox("self", async (self) => {
    const own = await submitWithHeaderFrom(self.user, { to: self.user, as: self });
    const forged = await submitWithHeaderFrom(`bob@${DEV_DOMAIN}`, { to: self.user, as: self });
    return own.startsWith("250") && refusedBySenderCheck(forged);
  }),
);
// Field names written oddly: Stalwart's parser reads every one of these as From / Sender (verified 2026-10-30), so the
// checks see them; these cases keep it that way.
const bobForged = `bob@${DEV_DOMAIN}`;
for (const [label, submit] of [
  ["Sender with a space before the colon", () => submitWithHeaderFrom(user, { extra: `Sender : ${bobForged}\r\n` })],
  ["Sender with a tab before the colon", () => submitWithHeaderFrom(user, { extra: `Sender\t: ${bobForged}\r\n` })],
  ["Sender in mixed case", () => submitWithHeaderFrom(user, { extra: `sEnDeR: ${bobForged}\r\n` })],
  [
    "a second From with a space before the colon",
    () => submitWithHeaderFrom(user, { extra: `From : ${bobForged}\r\n` }),
  ],
  ["a From with a tab before the colon, then our own", () => submitRaw(`From\t: ${bobForged}\r\nFrom: ${user}\r\n`)],
  ["From in mixed case", () => submitRaw(`fRoM: ${bobForged}\r\n`)],
] as const) {
  await protocolCheck(`Sender identity: ${label} refused`, async () => refusedBySenderCheck(await submit()));
}
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
// Send on behalf (ADR-0026 §8): alice is the mailbox (envelope and From), bob the delegate (Sender). The key is the one
// the dev plan wrote into the script (SENDER_DELEGATION_KEY, else derived from BETTER_AUTH_SECRET); never printed.
const onBehalfKey = resolveSenderDelegationKey(process.env);
const bobAddress = `bob@${DEV_DOMAIN}`;
const newMessageId = () => `${randomUUID()}@verify.${DEV_DOMAIN}`;
/** A fresh expiry (the web app's `ON_BEHALF_TTL_MS` ahead), or `ms` from now. */
const expiresIn = (ms?: number) => onBehalfExpires(Date.now(), ms);
const tagFor = (messageId: string, expires: string, delegate = bobAddress) =>
  onBehalfTag(onBehalfKey, user, delegate, messageId, expires);
/**
 * Sender, Message-ID(s), expiry and tag header lines for an SMTP submission (`tag: null` = no tag header; `expires`
 * a list of values, `[]` for none; `rawIds` written as given instead of `<id>`).
 */
const onBehalf = (o: {
  tag: string | null;
  messageIds: string[];
  expires: string[];
  sender?: string;
  rawIds?: boolean;
}) =>
  `Sender: ${o.sender ?? bobAddress}\r\n${o.messageIds
    .map((id) => `Message-ID: ${o.rawIds === true ? id : `<${id}>`}\r\n`)
    .join("")}${o.expires.map((e) => `${ON_BEHALF_EXPIRES_HEADER}: ${e}\r\n`).join("")}${
    o.tag === null ? "" : `${ON_BEHALF_HEADER}: ${o.tag}\r\n`
  }`;
/** The headers of the one Mailpit message to `to`, keys lowercased. */
async function mailpitHeaders(to: string): Promise<Record<string, string[]> | undefined> {
  const found = await waitFor(async () => {
    const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const body = (await res.json()) as { messages?: { ID: string }[] };
    return body.messages?.[0]?.ID;
  });
  if (!found) return undefined;
  const res = await fetch(`${mailpit}/api/v1/message/${found}/headers`);
  const headers = (await res.json()) as Record<string, string[]>;
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
const deliveredOnBehalf = (h: Record<string, string[]> | undefined) =>
  h !== undefined &&
  (h.from ?? []).some((v) => v.includes(user)) &&
  (h.sender ?? []).some((v) => v.includes(bobAddress)) &&
  !(ON_BEHALF_HEADER.toLowerCase() in h) &&
  !(ON_BEHALF_EXPIRES_HEADER.toLowerCase() in h);
const fresh = (label: string) => `on-behalf-${label}-${randomUUID().slice(0, 8)}@example.com`;
const refusedOnBehalf = async (label: string, extra: string, as?: { user: string; password: string }) =>
  refusedBySenderCheck(await submitWithHeaderFrom(user, { to: fresh(label), extra, ...(as ? { as } : {}) }));

await protocolCheck(
  "Send on behalf (SMTP): right tag accepted, delivered with Sender and without the tag",
  async () => {
    const to = fresh("smtp");
    const id = newMessageId();
    const exp = expiresIn();
    const reply = await submitWithHeaderFrom(user, {
      to,
      extra: onBehalf({ tag: tagFor(id, exp), messageIds: [id], expires: [exp] }),
    });
    return reply.startsWith("250") && deliveredOnBehalf(await mailpitHeaders(to));
  },
);
await protocolCheck(
  "Send on behalf (JMAP): right tag accepted, delivered with Sender and without the tag",
  async () => {
    const to = fresh("jmap");
    const id = newMessageId();
    const exp = expiresIn();
    const accountId = await alice.accountId();
    const drafts = await alice.mailboxByRole("drafts");
    const ids = await alice.request([["Identity/get", { accountId, ids: null }, "i"]]);
    const identity = ((ids.get("i")?.list ?? []) as { id: string; email: string }[]).find((i) => i.email === user);
    if (!drafts || !identity) return false;
    const res = await alice.request([
      [
        "Email/set",
        {
          accountId,
          create: {
            e: {
              mailboxIds: { [drafts.id]: true },
              keywords: { $draft: true, $seen: true },
              messageId: [id],
              from: [{ email: user }],
              sender: [{ email: bobAddress }],
              to: [{ email: to }],
              subject: "stack-verify on behalf",
              [`header:${ON_BEHALF_EXPIRES_HEADER}:asText`]: exp,
              [`header:${ON_BEHALF_HEADER}:asText`]: tagFor(id, exp),
              bodyValues: { b: { value: "On-behalf check." } },
              textBody: [{ partId: "b", type: "text/plain" }],
            },
          },
        },
        "e",
      ],
      [
        "EmailSubmission/set",
        { accountId, create: { s: { identityId: identity.id, emailId: "#e" } }, onSuccessDestroyEmail: ["#s"] },
        "s",
      ],
    ]);
    const created = res.get("s")?.created as Record<string, unknown> | undefined;
    if (created?.s === undefined) {
      // Refused: the draft stays behind (onSuccessDestroyEmail runs only on success), so remove it.
      const draft = (res.get("e")?.created as Record<string, { id: string }> | undefined)?.e;
      if (draft) await alice.request([["Email/set", { accountId, destroy: [draft.id] }, "d"]]);
      return false;
    }
    return deliveredOnBehalf(await mailpitHeaders(to));
  },
);
await protocolCheck("Send on behalf (local delivery): the stored copy has Sender and no tag header", async () =>
  withThrowawayMailbox("onbehalf", async (box) => {
    const id = newMessageId();
    const exp = expiresIn();
    const subject = `stack-verify on behalf local ${token}`;
    const reply = await submitWithHeaderFrom(user, {
      to: box.user,
      subject,
      extra: onBehalf({ tag: tagFor(id, exp), messageIds: [id], expires: [exp] }),
    });
    if (!reply.startsWith("250")) return false;
    const reader = new JmapClient({
      sessionUrl: `${base}/jmap/session`,
      authorization: `Basic ${Buffer.from(`${box.user}:${box.password}`).toString("base64")}`,
    });
    const boxInbox = await reader.mailboxByRole("inbox");
    if (!boxInbox) return false;
    const got = await waitFor(async () =>
      (await reader.listEmails(boxInbox.id, 10)).find((e) => e.subject === subject),
    );
    if (!got) return false;
    const res = await reader.request([
      ["Email/get", { accountId: await reader.accountId(), ids: [got.id], properties: ["headers"] }, "g"],
    ]);
    const list = (res.get("g")?.list ?? []) as { headers?: { name: string; value: string }[] }[];
    const headers = list[0]?.headers ?? [];
    const names = headers.map((h) => h.name.toLowerCase());
    return (
      names.includes("sender") &&
      headers.some((h) => h.name.toLowerCase() === "sender" && h.value.includes(bobAddress)) &&
      !names.includes(ON_BEHALF_HEADER.toLowerCase()) &&
      !names.includes(ON_BEHALF_EXPIRES_HEADER.toLowerCase())
    );
  }),
);
{
  const id = newMessageId();
  const exp = expiresIn();
  const good = tagFor(id, exp);
  const ob = (o: {
    tag: string | null;
    messageIds?: string[];
    expires?: string[];
    sender?: string;
    rawIds?: boolean;
  }) => onBehalf({ messageIds: [id], expires: [exp], ...o });
  // The script's formula done by hand, for inputs `onBehalfTag` itself refuses to make a tag for.
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  const manual = (messageId: string, expires: string) =>
    sha(`${onBehalfKey}|${sha(`${onBehalfKey}|${user}|${bobAddress}|${messageId}|${expires}`)}`);
  // Expired by the mail server's own clock (its HTTP Date header), ten minutes back: never "past" only on this machine.
  const serverNow = Date.parse((await fetch(`${base}/jmap/session`)).headers.get("date") ?? "");
  const past = onBehalfExpires(Number.isNaN(serverNow) ? Date.now() : serverNow, -10 * 60_000);
  check(
    "Send on behalf: the expired case's expiry is before the mail server's clock",
    !Number.isNaN(serverNow) && Date.parse(past) < serverNow,
  );
  const cases: [string, string][] = [
    ["wrong tag", ob({ tag: "0".repeat(64) })],
    ["missing tag", ob({ tag: null })],
    ["empty tag header", ob({ tag: "" })],
    ["another pair's tag", ob({ tag: good, sender: `someone@${DEV_DOMAIN}` })],
    // Replay: a tag copied from one message is useless on any other.
    ["a tag made for another Message-ID", ob({ tag: good, messageIds: [newMessageId()] })],
    ["no Message-ID", ob({ tag: good, messageIds: [] })],
    ["two Message-IDs (tag right for one)", ob({ tag: good, messageIds: [newMessageId(), id] })],
    // Expiry (ADR-0026 slice 13): a right tag whose time has passed, or one moved to another time.
    ["an expired tag (right for its expiry)", ob({ tag: tagFor(id, past), expires: [past] })],
    ["a tag with its expiry header changed", ob({ tag: good, expires: [expiresIn(60 * 60_000)] })],
    ["no expiry header", ob({ tag: good, expires: [] })],
    ["two expiry headers (one right)", ob({ tag: good, expires: [exp, exp] })],
    [
      "an expiry not in the UTC form (tag right for it)",
      ob({ tag: manual(id, `${exp.slice(0, 19)}+00:00`), expires: [`${exp.slice(0, 19)}+00:00`] }),
    ],
    // An unreadable Message-ID reads as empty: the tag for an empty id must never pass (verified 2026-10-30).
    [
      "an empty Message-ID with the tag for an empty one",
      ob({ tag: manual("", exp), messageIds: ["<>"], rawIds: true }),
    ],
    [
      "a Message-ID without brackets (tag right for it)",
      ob({ tag: manual("garbage", exp), messageIds: ["garbage"], rawIds: true }),
    ],
  ];
  // Sender forms an expression might read oddly: never accepted without the web app's tag, not with an empty one.
  for (const [form, sender] of [
    ["group syntax", "Undisclosed recipients:;"],
    ["an empty address <>", "<>"],
    ["an encoded word", `=?utf-8?q?B=C3=B6b?= <${bobAddress}>`],
    ["a source route", `<@relay.example:${bobAddress}>`],
  ] as const) {
    cases.push([`Sender as ${form}, no tag`, ob({ tag: null, sender })]);
    cases.push([`Sender as ${form}, empty tag`, ob({ tag: "", sender })]);
  }
  for (const [label, extra] of cases) {
    await protocolCheck(`Send on behalf: ${label} refused`, () => refusedOnBehalf("refuse", extra));
  }
  await protocolCheck("Send on behalf: delegate putting the mailbox in From refused, even with the tag", () =>
    refusedOnBehalf("forge", ob({ tag: good }), { user: bobAddress, password }),
  );
}
// Internal-mail marker (ADR-0019 update 2026-10-30, 05-webmail.md "Remote images"). The key is the one the dev plan
// wrote into the script (as for send on behalf); never printed.
{
  type Box = { user: string; password: string };
  type Header = { name: string; value: string };
  const readerFor = (box: Box) =>
    new JmapClient({
      sessionUrl: `${base}/jmap/session`,
      authorization: `Basic ${Buffer.from(`${box.user}:${box.password}`).toString("base64")}`,
    });
  /** The stored headers of the message with `subject` in `box`'s Inbox, or undefined if it never arrives. */
  const storedHeaders = async (box: Box, subject: string, timeoutMs?: number): Promise<Header[] | undefined> => {
    const reader = readerFor(box);
    const boxInbox = await reader.mailboxByRole("inbox");
    if (!boxInbox) return undefined;
    const got = await waitFor(
      async () => (await reader.listEmails(boxInbox.id, 20)).find((e) => e.subject === subject),
      timeoutMs,
    );
    if (!got) return undefined;
    const res = await reader.request([
      ["Email/get", { accountId: await reader.accountId(), ids: [got.id], properties: ["headers"] }, "g"],
    ]);
    const list = (res.get("g")?.list ?? []) as { headers?: Header[] }[];
    return (list[0]?.headers ?? []).map((h) => ({ name: h.name, value: h.value.trim() }));
  };
  const markers = (h: Header[]) => h.filter((x) => x.name.trim().toLowerCase() === INTERNAL_MAIL_HEADER.toLowerCase());
  const valueOf = (h: Header[], name: string) => h.find((x) => x.name.toLowerCase() === name)?.value ?? "";
  const trusted = trustedAuthservIds(undefined, [`mail.${DEV_DOMAIN}`], false);
  /** A whole message over port 25 from an outside envelope sender; resolves to the reply to the message data. */
  async function deliverInbound(
    to: string,
    headers: string,
    opts: { bdat?: boolean; mailFrom?: string } = {},
  ): Promise<string> {
    await sleep(250);
    const w = await wire(port("STALWART_SMTP_PORT", 25), false);
    try {
      await w.read(/^220 /m);
      w.send("EHLO outside.example");
      await w.read(/^250 /m);
      for (const line of [`MAIL FROM:<${opts.mailFrom ?? `verify@outside-${token}.example`}>`, `RCPT TO:<${to}>`]) {
        w.send(line);
        const reply = await w.read(/^\d{3} /m);
        if (/^[45]\d\d /m.test(reply)) return reply;
      }
      if (opts.bdat === true) {
        // CHUNKING (advertised on 25): the whole message in one last chunk; `send` writes its final CRLF.
        const msg = `${headers}To: ${to}\r\n\r\nx\r\n`;
        w.send(`BDAT ${String(Buffer.byteLength(msg))} LAST\r\n${msg.slice(0, -2)}`);
      } else {
        w.send("DATA");
        await w.read(/^354 /m);
        w.send(`${headers}To: ${to}\r\n\r\nx\r\n.`);
      }
      const res = await w.read(/^\d{3} /m);
      w.send("QUIT");
      return res;
    } finally {
      w.close();
    }
  }
  const otherKey = createHash("sha256").update(`not-${onBehalfKey}`).digest("hex");

  await protocolCheck("Internal mail: marker on every path, never forgeable from outside or by redirect", async () =>
    withThrowawayMailbox("intbox", (box) =>
      withThrowawayMailbox("intfwd", (fwd) =>
        withThrowawayMailbox("inttgt", async (tgt) => {
          // fwd redirects every message to tgt and keeps a copy (the webmail's forwarding rule, in short).
          await stalwartDevAdmin().putSieveScript(
            fwd.id,
            "verify",
            `require ["copy"];\nredirect :copy "${tgt.user}";\n`,
          );
          const results: [string, boolean][] = [];
          const note = (name: string, ok: boolean) => results.push([name, ok]);

          // (b) JMAP submission, the webmail's path.
          const jmapSubject = `stack-verify internal jmap ${token}`;
          await alice.sendText({ from: user, to: [box.user], subject: jmapSubject, text: "Internal mail check." });
          const viaJmap = (await storedHeaders(box, jmapSubject)) ?? [];
          note(
            "JMAP: one marker, valid for its From",
            markers(viaJmap).length === 1 && isInternalMail(viaJmap, user, onBehalfKey, trusted),
          );
          note("negative control: another key fails", !isInternalMail(viaJmap, user, otherKey, trusted));
          note("another From fails", !isInternalMail(viaJmap, `bob@${DEV_DOMAIN}`, onBehalfKey, trusted));

          // (a) SMTP 465 with planted markers (three spellings): replaced by exactly one of ours.
          const smtpSubject = `stack-verify internal smtp ${token}`;
          const planted = `${INTERNAL_MAIL_HEADER}: ${"ab".repeat(32)}\r\nx-anhourmail-internal : ${"cd".repeat(32)}\r\n${INTERNAL_MAIL_HEADER}\t: ${"ef".repeat(32)}\r\n`;
          const smtpReply = await submitWithHeaderFrom(user, {
            to: box.user,
            subject: smtpSubject,
            extra: `Message-ID: <${newMessageId()}>\r\n${planted}`,
          });
          const viaSmtp = (await storedHeaders(box, smtpSubject)) ?? [];
          note(
            "SMTP 465: planted markers replaced by one valid marker",
            smtpReply.startsWith("250") &&
              markers(viaSmtp).length === 1 &&
              isInternalMail(viaSmtp, user, onBehalfKey, trusted),
          );
          // No Message-ID: nothing to bind the marker to, so none (the reader then asks first).
          const bareSubject = `stack-verify internal bare ${token}`;
          await submitWithHeaderFrom(user, { to: box.user, subject: bareSubject });
          const bare = (await storedHeaders(box, bareSubject)) ?? [{ name: "missing", value: "" }];
          note(
            "SMTP 465 without a Message-ID: no marker",
            markers(bare).length === 0 && !bare.some((h) => h.name === "missing"),
          );

          // (d) Port 25: the genuine marker from the JMAP message, with its From and Message-ID, is removed on arrival.
          const replayed = `From: ${user}\r\nMessage-ID: ${valueOf(viaJmap, "message-id")}\r\n${markers(viaJmap)
            .map((m) => `${INTERNAL_MAIL_HEADER}: ${m.value}\r\n`)
            .join("")}x-anhourmail-internal : ${markers(viaJmap)[0]?.value ?? ""}\r\n`;
          const inSubject = `stack-verify internal inbound ${token}`;
          const inReply = await deliverInbound(box.user, `${replayed}Subject: ${inSubject}\r\n`);
          const inbound = (await storedHeaders(box, inSubject)) ?? [{ name: "missing", value: "" }];
          note(
            "port 25: a copied genuine marker is removed, our results still read",
            inReply.startsWith("250") &&
              markers(inbound).length === 0 &&
              !isInternalMail(inbound, user, onBehalfKey, trusted) &&
              ourAuthResultsHeader(inbound, trusted) !== null,
          );

          // (e) The same outside message to fwd: the redirected copy has no marker and no results the webmail trusts.
          const fwdSubject = `stack-verify internal redirect25 ${token}`;
          const fwdReply = await deliverInbound(fwd.user, `${replayed}Subject: ${fwdSubject}\r\n`);
          const redirected = (await storedHeaders(tgt, fwdSubject)) ?? [{ name: "missing", value: "" }];
          note(
            "redirected copy of outside mail: no marker, no trusted results (not verified)",
            fwdReply.startsWith("250") &&
              !redirected.some((h) => h.name === "missing") &&
              markers(redirected).length === 0 &&
              !isInternalMail(redirected, user, onBehalfKey, trusted) &&
              ourAuthResultsHeader(redirected, trusted) === null,
          );
          // A redirected copy of internal mail keeps its marker: its From is ours and verified.
          const fwdIntSubject = `stack-verify internal redirect ${token}`;
          await alice.sendText({
            from: user,
            to: [fwd.user],
            subject: fwdIntSubject,
            text: "Internal redirect check.",
          });
          const redirectedInt = (await storedHeaders(tgt, fwdIntSubject)) ?? [];
          note(
            "redirected copy of internal mail: marker still valid",
            isInternalMail(redirectedInt, user, onBehalfKey, trusted),
          );

          // Recipients: the marker is added only when every one is local (none reaches outside recipients).
          const mixedSubject = `stack-verify internal mixed ${token}`;
          const external = `internal-mixed-${token}@example.com`;
          await alice.sendText({ from: user, to: [box.user, external], subject: mixedSubject, text: "Mixed." });
          const mixed = (await storedHeaders(box, mixedSubject)) ?? [{ name: "missing", value: "" }];
          const outside = await mailpitHeaders(external);
          note(
            "local + outside recipients: no marker on either copy",
            !mixed.some((h) => h.name === "missing") &&
              markers(mixed).length === 0 &&
              outside !== undefined &&
              !(INTERNAL_MAIL_HEADER.toLowerCase() in outside),
          );
          const bothSubject = `stack-verify internal both ${token}`;
          await alice.sendText({ from: user, to: [box.user, fwd.user], subject: bothSubject, text: "Both local." });
          const both = (await storedHeaders(box, bothSubject)) ?? [];
          note("two local recipients: marked", isInternalMail(both, user, onBehalfKey, trusted));

          // Port 25 with the genuine marker under names Stalwart doesn't treat as the header (verified 2026-10-30: NBSP,
          // BOM and \v are kept as written, \f is removed) and over BDAT: never accepted by the reader.
          const genuine = markers(viaJmap)[0]?.value ?? "";
          const base25 = `From: ${user}\r\nMessage-ID: ${valueOf(viaJmap, "message-id")}\r\n`;
          for (const [label, name] of [
            ["NBSP", `${INTERNAL_MAIL_HEADER}\u00a0`],
            ["BOM", `\ufeff${INTERNAL_MAIL_HEADER}`],
            ["VT", `${INTERNAL_MAIL_HEADER}\v`],
            ["FF", `${INTERNAL_MAIL_HEADER}\f`],
          ] as const) {
            const subject = `stack-verify internal name ${label} ${token}`;
            const reply = await deliverInbound(box.user, `${base25}${name}: ${genuine}\r\nSubject: ${subject}\r\n`);
            const got = (await storedHeaders(box, subject)) ?? [{ name: "missing", value: "" }];
            const kept = got.filter((h) => h.name.toLowerCase().includes("anhourmail-internal")).length;
            console.log(`      port 25 marker named with ${label}: ${kept > 0 ? "kept as written" : "removed"}`);
            note(
              `port 25 marker named with ${label}: not internal`,
              reply.startsWith("250") &&
                !got.some((h) => h.name === "missing") &&
                !isInternalMail(got, user, onBehalfKey, trusted),
            );
          }
          const bdatSubject = `stack-verify internal bdat ${token}`;
          const bdatReply = await deliverInbound(
            box.user,
            `${base25}${INTERNAL_MAIL_HEADER}: ${genuine}\r\nSubject: ${bdatSubject}\r\n`,
            { bdat: true },
          );
          const bdat = (await storedHeaders(box, bdatSubject)) ?? [{ name: "missing", value: "" }];
          note(
            "port 25 over BDAT: the marker is removed",
            bdatReply.startsWith("250") && !bdat.some((h) => h.name === "missing") && markers(bdat).length === 0,
          );

          const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
          if (failed.length > 0) console.log(`      internal mail: failed ${failed.join("; ")}`);
          return failed.length === 0;
        }),
      ),
    ),
  );

  // Forwarding skips DMARC failures (maintainer decision 2026-10-30, ADR-0019 update "forwarding and DMARC"). Dev has
  // no DNS, so Stalwart's own results always say temperror: the fail cases plant a results header with our authserv-id,
  // which the rule treats like ours (a sender can only stop forwarding of their own message). The script is the real
  // generator's output, first in the pre-2026-10-30 form, then upgraded with the start-up transform.
  await protocolCheck(
    "Forwarding guard: our dmarc=fail, or own-domain mail without our pass, stays in the inbox; upgrade is a compare-and-swap",
    async () =>
      withThrowawayMailbox("dmarcfwd", (fwd) =>
        withThrowawayMailbox("dmarctgt", async (tgt) => {
          const rules = { ...DEFAULT_RULES, forwarding: { enabled: true, address: tgt.user, keepCopy: true } };
          const ctx = { identities: [fwd.user], contacts: [], mailboxDomain: DEV_DOMAIN };
          const older = buildScript(rules, { ...ctx, authservIds: [] });
          const today = buildScript(rules, { ...ctx, authservIds: trusted });
          const admin = stalwartDevAdmin();
          const results: [string, boolean][] = [];
          const note = (name: string, ok: boolean) => results.push([name, ok]);
          const ours = (verdict: string) =>
            `Authentication-Results: mail.${DEV_DOMAIN}; dmarc=${verdict} header.from=${DEV_DOMAIN} policy.dmarc=none\r\n`;
          const foreign = `someone@outside-${token}.example`;
          const own = `someone@${DEV_DOMAIN}`;
          /** Sends on port 25 to fwd; [kept in fwd's inbox, forwarded to tgt]. */
          const outcome = async (
            label: string,
            extra: string,
            from = foreign,
            mailFrom?: string,
          ): Promise<[boolean, boolean]> => {
            const subject = `stack-verify fwd ${label} ${token}`;
            const reply = await deliverInbound(
              fwd.user,
              `${extra}From: ${from}\r\nSubject: ${subject}\r\n`,
              mailFrom === undefined ? {} : { mailFrom },
            );
            if (!reply.startsWith("250")) return [false, false];
            const kept = (await storedHeaders(fwd, subject)) !== undefined;
            const forwarded = (await storedHeaders(tgt, subject, 6_000)) !== undefined;
            return [kept, forwarded];
          };
          const same = (a: [boolean, boolean], b: [boolean, boolean]) => a[0] === b[0] && a[1] === b[1];
          const KEPT_ONLY: [boolean, boolean] = [true, false];
          const BOTH: [boolean, boolean] = [true, true];

          // The pre-2026-10-30 script, then the start-up upgrade, written with a compare-and-swap.
          await admin.putSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT, older);
          note(
            "older script: our dmarc=fail is still forwarded (control)",
            same(await outcome("old-fail", ours("fail")), BOTH),
          );
          const upgraded = upgradeManagedScript(older, trusted, DEV_DOMAIN);
          note("start-up upgrade gives today's script", upgraded === today);
          const read = await admin.getSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT);
          // A save lands between the read and the write: the write is refused and the save stays.
          await admin.putSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT, `${older}# saved meanwhile\n`);
          const lost = await admin.putSieveScriptIfUnchanged(
            fwd.id,
            MANAGED_SIEVE_SCRIPT,
            upgraded ?? "",
            read?.state ?? "",
          );
          const kept = await admin.getSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT);
          note(
            "compare-and-swap: a save in between wins",
            !lost && kept?.content.trimEnd() === `${older}# saved meanwhile`,
          );
          const fresh = await admin.getSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT);
          const wrote = await admin.putSieveScriptIfUnchanged(
            fwd.id,
            MANAGED_SIEVE_SCRIPT,
            upgraded ?? "",
            fresh?.state ?? "",
          );
          const now = await admin.getSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT);
          note(
            "compare-and-swap: with the current state it writes, still active",
            wrote && now?.content.trimEnd() === today.trimEnd() && now.active,
          );

          note("foreign From, our results temperror (dev): kept and forwarded", same(await outcome("plain", ""), BOTH));
          note("foreign From, our id says dmarc=fail: kept only", same(await outcome("fail", ours("fail")), KEPT_ONLY));
          note(
            "foreign From, another id says dmarc=fail: kept and forwarded",
            same(
              await outcome("other", "Authentication-Results: other.example; dmarc=fail header.from=x.example\r\n"),
              BOTH,
            ),
          );
          // The mailbox's own domain without a DMARC pass in our top-most results (dev: temperror, as for no record).
          note("own-domain From, no DMARC pass: kept only", same(await outcome("own", "", own), KEPT_ONLY));
          note(
            "own-subdomain From, no DMARC pass: kept only",
            same(await outcome("sub", "", `someone@sub.${DEV_DOMAIN}`), KEPT_ONLY),
          );
          note(
            "own-domain From, a planted pass below ours: kept only",
            same(await outcome("planted", ours("pass"), own), KEPT_ONLY),
          );
          note(
            "own-domain From, the pass words injected through a quoted MAIL FROM: kept only",
            same(
              await outcome(
                "inject",
                "",
                own,
                `"x; dmarc=pass header.from=${DEV_DOMAIN} policy.dmarc=none"@outside-${token}.example`,
              ),
              KEPT_ONLY,
            ),
          );
          // More than one From (Stalwart writes `dmarc=none header.from=` for these): never a pass for the own domain.
          note(
            "two From headers, one foreign and one own: kept only",
            same(await outcome("two-hdr", "", `someone@evil-${token}.example\r\nFrom: ${own}`), KEPT_ONLY),
          );
          note(
            "a From listing a foreign and an own address: kept only",
            same(await outcome("two-addr", "", `someone@evil-${token}.example, ${own}`), KEPT_ONLY),
          );
          note(
            "spam skip unchanged: X-Spam-Status Yes is kept only",
            same(await outcome("spam", "X-Spam-Status: Yes\r\n"), KEPT_ONLY),
          );
          // Internal mail from the mailbox's own domain has no results header at all: still forwarded.
          const internalSubject = `stack-verify fwd internal ${token}`;
          await alice.sendText({ from: user, to: [fwd.user], subject: internalSubject, text: "Forwarding check." });
          note(
            "internal mail from the own domain: forwarded",
            (await storedHeaders(tgt, internalSubject)) !== undefined,
          );

          // The pass branch can't be produced here (no DNS), so check the regex in Stalwart's own engine: it matches a
          // pass item at a header's end, and its anchored form matches our real header (whose verdict is temperror).
          const passRe = dmarcPassRegex(DEV_DOMAIN);
          const engine = (index: number, regex: string) =>
            `require ["index", "regex", "copy"];\nif header :index ${String(index)} :regex "Authentication-Results" "${regex.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" {\n  redirect :copy "${tgt.user}";\n}\n`;
          await admin.putSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT, engine(2, passRe));
          note(
            "engine: the pass regex matches a pass at a header's end",
            same(await outcome("re-pass", ours("pass")), BOTH),
          );
          note("engine: and not a temperror", same(await outcome("re-temp", ours("temperror")), KEPT_ONLY));
          note(
            "engine: nor a pass for a foreign header.from",
            same(
              await outcome(
                "re-foreign",
                `Authentication-Results: mail.${DEV_DOMAIN}; dmarc=pass header.from=evil-${token}.example policy.dmarc=none\r\n`,
              ),
              KEPT_ONLY,
            ),
          );
          await admin.putSieveScript(
            fwd.id,
            MANAGED_SIEVE_SCRIPT,
            engine(1, passRe.replace("dmarc=pass", "dmarc=temperror")),
          );
          note(
            "engine: the anchored form matches our real top-most header",
            same(await outcome("re-real", "", own), BOTH),
          );
          note(
            "engine: injected words in our real header don't match the anchored pass form",
            await (async () => {
              await admin.putSieveScript(fwd.id, MANAGED_SIEVE_SCRIPT, engine(1, passRe));
              return same(
                await outcome(
                  "re-inject",
                  "",
                  own,
                  `"x; dmarc=pass header.from=${DEV_DOMAIN}"@outside-${token}.example`,
                ),
                KEPT_ONLY,
              );
            })(),
          );

          const failedChecks = results.filter(([, ok]) => !ok).map(([n]) => n);
          if (failedChecks.length > 0) console.log(`      forwarding: failed ${failedChecks.join("; ")}`);
          return failedChecks.length === 0;
        }),
      ),
  );
}
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

// Unknown local recipients: refused during the SMTP conversation, never accepted and dropped. Each probe stops at RCPT.
async function rcptReply(to: string, opts: { submission?: boolean } = {}): Promise<string> {
  const w = opts.submission
    ? await wire(port("STALWART_SUBMISSIONS_PORT", 465), true)
    : await wire(port("STALWART_SMTP_PORT", 25), false);
  try {
    await w.read(/^220 /m);
    w.send("EHLO verify.local");
    await w.read(/^250 /m);
    if (opts.submission) {
      w.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString("base64")}`);
      if (!(await w.read(/^\d{3} /m)).startsWith("235")) throw new Error("submission sign-in refused");
    }
    w.send(`MAIL FROM:<${opts.submission ? user : `verify@sender-${token}.example`}>`);
    await w.read(/^\d{3} /m);
    w.send(`RCPT TO:<${to}>`);
    // Stalwart waits before answering after repeated refused recipients from one address (it slows address
    // harvesting); earlier checks in this run refuse several, so the reply can take longer than the default 5 s.
    const reply = await w.read(/^\d{3} /m, 30_000);
    w.send("QUIT");
    return reply.trim().split("\r\n").at(-1) ?? "";
  } finally {
    w.close();
  }
}
const unknownLocal = `nobody-${token}@${DEV_DOMAIN}`;
await protocolCheck("SMTP 25: unknown local recipient refused at RCPT (550, no catch-all)", async () =>
  (await rcptReply(unknownLocal)).startsWith("550 "),
);
await protocolCheck("SMTP 25: known local recipient accepted at RCPT", async () =>
  (await rcptReply(`bob@${DEV_DOMAIN}`)).startsWith("250 "),
);
await protocolCheck("SMTP 465: unknown local recipient refused at RCPT for a signed-in sender (550)", async () =>
  (await rcptReply(unknownLocal, { submission: true })).startsWith("550 "),
);
await protocolCheck("Catch-all domain: unknown recipient accepted at RCPT", async () => {
  // A throwaway domain whose catch-all is bob's mailbox; removed again whatever happens.
  const admin = stalwartDevAdmin();
  const name = `verify-catchall-${token}.test`;
  const id = await admin.upsertDomain({ name, catchAllAddress: `bob@${DEV_DOMAIN}` });
  try {
    return (await rcptReply(`anything-${token}@${name}`)).startsWith("250 ");
  } finally {
    await admin.destroyDomain(id);
  }
});
await protocolCheck("JMAP submission: unknown local recipient reported as not delivered (550)", async () => {
  const id = await alice.sendText({
    from: user,
    to: [unknownLocal],
    subject: `stack-verify unknown ${token}`,
    text: "Unknown recipient check.",
  });
  const accountId = await alice.accountId();
  type Status = Record<string, { delivered?: string; smtpReply?: string }>;
  const status = await waitFor(async () => {
    const res = await alice.request([["EmailSubmission/get", { accountId, ids: [id] }, "g"]]);
    const list = (res.get("g")?.list ?? []) as { deliveryStatus?: Status }[];
    const s = list[0]?.deliveryStatus?.[unknownLocal];
    return s?.delivered === "no" ? s : undefined;
  }, 10_000);
  return status?.smtpReply?.startsWith("550") === true;
});

console.log(failures === 0 ? "\nstack:verify — all checks passed." : `\nstack:verify — ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
