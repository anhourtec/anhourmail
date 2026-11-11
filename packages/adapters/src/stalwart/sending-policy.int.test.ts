// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trust tiers on the mail server (ADR-0034 build slice 1, probes P1–P4), pinned on the real pinned dev Stalwart so an
 * upgrade that changes any of them is noticed. No product code: what the later slices build on.
 *
 * - P1 `smtp_blocked` (`CUSTOMER_DENIALS` + `emailSend` only, written with the production provisioning key): SMTP AUTH
 *   on 465 and 587 is refused, JMAP submission still sends, IMAP reads, mail to it is delivered.
 * - P2 an `x:MtaInboundThrottle` keyed `{ authenticatedAs }`: answers at MAIL FROM, counts MAIL transactions (not
 *   recipients, and a MAIL FROM that never reached DATA counts too), shared by 465, 587 and JMAP submission.
 * - P3 `x:MtaStageRcpt.maxRecipients` for an authenticated session: the 51st RCPT is refused while port 25 keeps 100.
 * - P4 MTA-stage expressions **can** read `x:MemoryLookupKey` (`key_exists`) and `x:MemoryLookupKeyValue` (`key_get`),
 *   but only after `ReloadLookupStores`: adding or removing a key changes nothing until then. With it, an
 *   `allowRelaying` branch refuses outside recipients for listed accounts only (local delivery kept, SMTP and JMAP
 *   alike) and a throttle's `match` limits listed accounts only.
 *
 * Every expression changed here is scoped to this run's own throwaway accounts (`authenticated_as == …` or a run-scoped
 * lookup namespace), and the originals are written back afterwards, so other suites and the dev stack see no change.
 * External recipients are on a made-up domain that dev routes to Mailpit (no egress). JMAP goes from a
 * documentation-range client address; AUTH refusals for a missing permission don't count as failed sign-ins.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUSTOMER_PERMISSIONS, StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { issueTestKeys, type TestKeys } from "./int-keys";
import { smtpExchange } from "./int-smtp";

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
const domain = `tier-${tag}.test`;
const password = randomBytes(18).toString("base64url");
const clientAddress = `203.0.113.${String(1 + Math.floor(Math.random() * 254))}`;
const port = (k: string, d: number) => Number(process.env[k] ?? d);
const P465 = port("STALWART_SUBMISSIONS_PORT", 465);
const P587 = port("STALWART_SUBMISSION_PORT", 587);
const P25 = port("STALWART_SMTP_PORT", 25);
const P993 = port("STALWART_IMAPS_PORT", 993);
const MAILPIT = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;
const addr = (local: string) => `${local}@${domain}`;
/** A fresh outside recipient (routed to Mailpit in dev); fresh each time so the default sender→rcpt throttle never bites. */
const outside = (label: string) => `${label}-${tag}@ext-${tag}.test`;
const namespace = `am-tier-probe-${tag}`;

let keys: TestKeys;
const ids: Record<string, string> = {};
/** Undo steps for every global object this file touches, run last-in first-out. */
const restore: (() => Promise<void>)[] = [];

type StageRcpt = { id: string; maxRecipients: unknown; allowRelaying: unknown };

beforeAll(async () => {
  keys = await issueTestKeys(mgmt, stalwartUrl, `svc-tier-${tag}.test`);
  // Unknown local recipients go to `catch@` so port 25 can be given 52 distinct, valid recipients.
  await mgmt.upsertDomain({ name: domain, catchAllAddress: addr("catch") });
  const hash = await hashPassword(password);
  for (const local of ["held", "counted", "capped", "listed", "unlisted", "catch"]) {
    ids[local] = await keys.provisioning.upsertUser({
      name: local,
      domain,
      password: hash,
      quotaBytes: 50 * 1024 * 1024,
    });
  }
  const [stage] = await mgmt.transport.getAll<StageRcpt>(
    "x:MtaStageRcpt",
    ["maxRecipients", "allowRelaying"],
    ["singleton"],
  );
  if (!stage) throw new Error("x:MtaStageRcpt singleton not found");
  restore.push(async () => {
    await mgmt.updateSingleton("x:MtaStageRcpt", {
      maxRecipients: stage.maxRecipients,
      allowRelaying: stage.allowRelaying,
    });
    await mgmt.reloadSettings();
  });
}, 120_000);

afterAll(async () => {
  for (const undo of restore.reverse()) await undo();
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  await keys.cleanup();
}, 120_000);

const plainAuth = (address: string) => `AUTH PLAIN ${Buffer.from(`\0${address}\0${password}`).toString("base64")}`;
/** Replies after the greeting, EHLO and AUTH (STARTTLS adds two more first). */
const afterAuth = (replies: string[], mode: "implicit" | "starttls" = "implicit") =>
  replies.slice(mode === "starttls" ? 5 : 3);
/** The reply to AUTH itself. */
const authReply = (replies: string[], mode: "implicit" | "starttls" = "implicit") =>
  replies[mode === "starttls" ? 4 : 2];
const message = (from: string, to: string[], subject: string) => [
  `MAIL FROM:<${from}>`,
  ...to.map((t) => `RCPT TO:<${t}>`),
  "DATA",
  `From: ${from}\r\nTo: ${to.join(", ")}\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@${domain}>\r\n\r\nhello\r\n.`,
];
const code = (reply: string | undefined) => (reply ?? "").slice(0, 3);
const reloadLookups = () => mgmt.transport.set("x:Action", { create: { a: { "@type": "ReloadLookupStores" } } });

async function setStageRcpt(field: "maxRecipients" | "allowRelaying", expression: object): Promise<void> {
  await mgmt.updateSingleton("x:MtaStageRcpt", { [field]: expression });
  await mgmt.reloadSettings();
}

async function addThrottle(match: string, count: number): Promise<void> {
  const { created } = await mgmt.transport.set("x:MtaInboundThrottle", {
    create: {
      t: {
        description: `tier probe ${tag} ${String(restore.length)}`,
        enable: true,
        key: { authenticatedAs: true },
        match: { match: {}, else: match },
        rate: { count, period: 3_600_000 },
      },
    },
  });
  const id = created.t?.id;
  if (!id) throw new Error("throttle not created");
  restore.push(async () => {
    await mgmt.transport.set("x:MtaInboundThrottle", { destroy: [id] });
    await mgmt.reloadSettings();
  });
  await mgmt.reloadSettings();
}

async function addLookupKey(key: string): Promise<string> {
  const { created } = await mgmt.transport.set("x:MemoryLookupKey", {
    create: { k: { namespace, key, isGlobPattern: false } },
  });
  const id = created.k?.id;
  if (!id) throw new Error("lookup key not created");
  restore.push(async () => {
    await mgmt.transport.set("x:MemoryLookupKey", { destroy: [id] }).catch(() => undefined);
    await reloadLookups();
  });
  return id;
}

/**
 * Saves a draft to `to` and submits it over JMAP (as the webmail BFF does). Returns `refused:<type> <description>` when
 * the submission isn't created, else each recipient's `smtpReply` from `deliveryStatus` (read after a moment).
 */
async function jmapSend(from: string, to: string, subject: string): Promise<string> {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${from}:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
    "X-Forwarded-For": clientAddress,
  };
  const session = (await (await fetch(`${stalwartUrl}/jmap/session`, { headers })).json()) as {
    primaryAccounts: Record<string, string>;
  };
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"] ?? "";
  const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const call = async (methodCalls: unknown[]) =>
    (
      (await (
        await fetch(`${stalwartUrl}/jmap`, { method: "POST", headers, body: JSON.stringify({ using, methodCalls }) })
      ).json()) as { methodResponses: [string, Record<string, unknown>, string][] }
    ).methodResponses;
  const [mailboxes, identities] = await call([
    ["Mailbox/get", { accountId, properties: ["role"] }, "m"],
    ["Identity/get", { accountId }, "i"],
  ]);
  const drafts = (mailboxes?.[1].list as { id: string; role: string | null }[]).find((m) => m.role === "drafts")?.id;
  const identityId = (identities?.[1].list as { id: string }[] | undefined)?.[0]?.id ?? "";
  const res = await call([
    [
      "Email/set",
      {
        accountId,
        create: {
          e: {
            mailboxIds: { [drafts ?? ""]: true },
            from: [{ email: from }],
            to: [{ email: to }],
            subject,
            bodyValues: { b: { value: "hello" } },
            textBody: [{ partId: "b", type: "text/plain" }],
          },
        },
      },
      "e",
    ],
    ["EmailSubmission/set", { accountId, create: { s: { emailId: "#e", identityId } } }, "s"],
  ]);
  const sub = res[1]?.[1] ?? {};
  const refused = (sub.notCreated as Record<string, { type: string; description?: string }> | undefined)?.s;
  if (refused) return `refused:${refused.type} ${refused.description ?? ""}`;
  const id = (sub.created as Record<string, { id: string }> | undefined)?.s?.id ?? "";
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const [got] = await call([["EmailSubmission/get", { accountId, ids: [id], properties: ["deliveryStatus"] }, "g"]]);
    const status = (got?.[1].list as { deliveryStatus?: Record<string, { smtpReply: string }> | null }[])[0]
      ?.deliveryStatus;
    if (status && Object.keys(status).length > 0) {
      return Object.values(status)
        .map((s) => s.smtpReply)
        .join(" | ");
    }
  }
  return "no delivery status";
}

/** Mailpit messages to `to`, polled up to `ms` (dev and CI only; nothing leaves the machine). */
async function caughtFor(to: string, ms = 20_000): Promise<number> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const found = ((await r.json()) as { messages?: unknown[] }).messages ?? [];
    if (found.length > 0 || Date.now() > until) return found.length;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** IMAP sign-in, then how many messages INBOX holds (polled up to `ms` until at least `atLeast`); null if refused. */
async function imapInboxCount(address: string, atLeast = 0, ms = 15_000): Promise<number | null> {
  const until = Date.now() + ms;
  for (;;) {
    const replies = await smtpExchange(P993, "implicit", [
      `a1 LOGIN "${address}" "${password}"`,
      "a2 SELECT INBOX",
      "a3 LOGOUT",
    ]);
    if (!replies.some((r) => /^a1 OK/m.test(r))) return null;
    const exists = Number(/\* (\d+) EXISTS/.exec(replies.join("\n"))?.[1] ?? "-1");
    if (exists >= atLeast || Date.now() > until) return exists;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

describe("trust tiers on the pinned mail server (ADR-0034 P1–P4)", () => {
  it("P1 smtp_blocked: SMTP AUTH refused on 465 and 587; JMAP submission, IMAP and delivery to it keep working", async () => {
    const held = addr("held");
    // The production provisioning key may write this state (no new management permission needed).
    await keys.provisioning.transport.set("x:Account", {
      update: {
        [ids.held ?? ""]: {
          permissions: {
            ...CUSTOMER_PERMISSIONS,
            disabledPermissions: { ...CUSTOMER_PERMISSIONS.disabledPermissions, emailSend: true },
          },
        },
      },
    });
    const refusal = "550 5.7.1 Your account is not authorized to use this service.";
    expect(authReply(await smtpExchange(P465, "implicit", ["EHLO int-test", plainAuth(held), "QUIT"]))).toBe(refusal);
    expect(
      authReply(await smtpExchange(P587, "starttls", ["EHLO int-test", plainAuth(held), "QUIT"]), "starttls"),
    ).toBe(refusal);
    const to = outside("p1");
    expect(await jmapSend(held, to, `p1 ${tag}`)).toMatch(/^250 /);
    expect(await caughtFor(to)).toBe(1);
    const inbound = await smtpExchange(P25, "plain", [
      "EHLO sender.test",
      ...message(`someone-${tag}@sender-${tag}.test`, [held], `p1 in ${tag}`),
      "QUIT",
    ]);
    expect(inbound.some((r) => r.startsWith("250 2.0.0 Message queued"))).toBe(true);
    expect(await imapInboxCount(held, 1)).toBe(1);
  });

  it("P2 authenticatedAs throttle: 452 4.4.5 at MAIL FROM, counts MAIL transactions across 465, 587 and JMAP", async () => {
    const counted = addr("counted");
    await addThrottle(`authenticated_as == '${counted}'`, 3);
    // 1: a JMAP submission (the webmail's path) counts.
    expect(await jmapSend(counted, outside("p2a"), `p2a ${tag}`)).toMatch(/^250 /);
    // 2: one message with two recipients counts once (messages, not recipients).
    const two = afterAuth(
      await smtpExchange(P465, "implicit", [
        "EHLO int-test",
        plainAuth(counted),
        ...message(counted, [outside("p2b"), outside("p2c")], `p2b ${tag}`),
        "QUIT",
      ]),
    );
    expect(two.map(code)).toEqual(["250", "250", "250", "354", "250", "221"]);
    // 3: a MAIL FROM that never reaches DATA counts too (587 shares the allowance with 465).
    const reset = afterAuth(
      await smtpExchange(P587, "starttls", [
        "EHLO int-test",
        plainAuth(counted),
        `MAIL FROM:<${counted}>`,
        "RSET",
        "QUIT",
      ]),
      "starttls",
    );
    expect(reset.map(code)).toEqual(["250", "250", "221"]);
    // 4: over the limit — refused at MAIL FROM, nothing after it gets in.
    const over = afterAuth(
      await smtpExchange(P465, "implicit", [
        "EHLO int-test",
        plainAuth(counted),
        ...message(counted, [outside("p2d")], `p2d ${tag}`),
        "QUIT",
      ]),
    );
    expect(over[0]).toBe("452 4.4.5 Rate limit exceeded, try again later.");
    expect(code(over[1])).toBe("503");
    // 5: JMAP over the limit: the submission isn't created; the draft stays.
    expect(await jmapSend(counted, outside("p2e"), `p2e ${tag}`)).toBe(
      "refused:forbiddenMailFrom Server rejected MAIL-FROM: 452 4.4.5 Rate limit exceeded, try again later.",
    );
    // Other accounts are not affected by the scoped throttle.
    expect(await jmapSend(addr("capped"), outside("p2f"), `p2f ${tag}`)).toMatch(/^250 /);
  });

  it("P3 maxRecipients for an authenticated session: the 51st RCPT gets 455 4.5.3 while port 25 keeps 100", async () => {
    const capped = addr("capped");
    await setStageRcpt("maxRecipients", {
      match: { "0": { if: `authenticated_as == '${capped}'`, then: "50" } },
      else: "100",
    });
    const rcpts = Array.from({ length: 52 }, (_, i) => `RCPT TO:<${outside(`p3-${String(i)}`)}>`);
    const submitted = afterAuth(
      await smtpExchange(P465, "implicit", [
        "EHLO int-test",
        plainAuth(capped),
        `MAIL FROM:<${capped}>`,
        ...rcpts,
        "QUIT",
      ]),
    ).slice(1, 53);
    expect(submitted.slice(0, 50).every((r) => r === "250 2.1.5 OK")).toBe(true);
    expect(submitted.slice(50)).toEqual(["455 4.5.3 Too many recipients.", "455 4.5.3 Too many recipients."]);
    // Port 25 (unauthenticated, from another server): 52 local recipients (the catch-all) all accepted.
    const local = Array.from({ length: 52 }, (_, i) => `RCPT TO:<n${String(i)}-${tag}@${domain}>`);
    const inbound = (
      await smtpExchange(P25, "plain", [
        "EHLO sender.test",
        `MAIL FROM:<someone-${tag}@sender-${tag}.test>`,
        ...local,
        "QUIT",
      ])
    ).slice(3, 55);
    expect(inbound).toHaveLength(52);
    expect(inbound.every((r) => r === "250 2.1.5 OK")).toBe(true);
  });

  it("P4 MTA expressions read x:MemoryLookupKey after ReloadLookupStores: per-account caps, relay holds, throttles", async () => {
    const listed = addr("listed");
    const unlisted = addr("unlisted");
    const threeRcpts = (who: string) =>
      smtpExchange(P465, "implicit", [
        "EHLO int-test",
        plainAuth(who),
        `MAIL FROM:<${who}>`,
        ...[1, 2, 3].map((n) => `RCPT TO:<${outside(`p4-${String(n)}`)}>`),
        "QUIT",
      ]).then((r) => afterAuth(r).slice(1, 4).map(code).join(","));
    const capped = "250,250,455";
    const open = "250,250,250";

    const keyId = await addLookupKey(listed);
    await setStageRcpt("maxRecipients", {
      match: { "0": { if: `key_exists('${namespace}', authenticated_as)`, then: "2" } },
      else: "100",
    });
    // A key written through management isn't seen until the lookup stores are reloaded (ReloadSettings isn't enough).
    expect(await threeRcpts(listed)).toBe(open);
    await reloadLookups();
    expect(await threeRcpts(listed)).toBe(capped);
    expect(await threeRcpts(unlisted)).toBe(open);
    // Removal likewise only counts after the reload.
    await mgmt.transport.set("x:MemoryLookupKey", { destroy: [keyId] });
    expect(await threeRcpts(listed)).toBe(capped);
    await reloadLookups();
    expect(await threeRcpts(listed)).toBe(open);

    // Key-value lookups too: `key_get(namespace, key)` returns the stored value.
    const { created } = await mgmt.transport.set("x:MemoryLookupKeyValue", {
      create: { k: { namespace: `${namespace}-kv`, key: listed, value: "2", isGlobPattern: false } },
    });
    const kvId = created.k?.id ?? "";
    restore.push(async () => {
      await mgmt.transport.set("x:MemoryLookupKeyValue", { destroy: [kvId] }).catch(() => undefined);
      await reloadLookups();
    });
    await reloadLookups();
    await setStageRcpt("maxRecipients", {
      match: { "0": { if: `key_get('${namespace}-kv', authenticated_as) == '2'`, then: "2" } },
      else: "100",
    });
    expect(await threeRcpts(listed)).toBe(capped);
    expect(await threeRcpts(unlisted)).toBe(open);
    await setStageRcpt("maxRecipients", { match: {}, else: "100" });

    // A relay hold for listed accounts: outside recipients refused at RCPT, local delivery kept, on SMTP and JMAP.
    await addLookupKey(listed);
    await reloadLookups();
    await setStageRcpt("allowRelaying", {
      match: { "0": { if: `key_exists('${namespace}', authenticated_as)`, then: "false" } },
      else: "!is_empty(authenticated_as)",
    });
    const relay = (who: string) =>
      smtpExchange(P465, "implicit", [
        "EHLO int-test",
        plainAuth(who),
        `MAIL FROM:<${who}>`,
        `RCPT TO:<${outside("p4-relay")}>`,
        `RCPT TO:<${addr("catch")}>`,
        "QUIT",
      ]).then((r) => afterAuth(r).slice(1, 3));
    expect(await relay(listed)).toEqual(["550 5.1.2 Relay not allowed.", "250 2.1.5 OK"]);
    expect(await relay(unlisted)).toEqual(["250 2.1.5 OK", "250 2.1.5 OK"]);
    expect(await jmapSend(listed, outside("p4-jmap"), `p4 jmap ${tag}`)).toBe("550 5.1.2 Relay not allowed.");
    expect(await jmapSend(listed, addr("catch"), `p4 local ${tag}`)).toMatch(/^250 /);

    // A throttle whose `match` reads the list limits listed accounts only.
    await addThrottle(`key_exists('${namespace}', authenticated_as)`, 1);
    const mailFrom = (who: string) =>
      smtpExchange(P465, "implicit", ["EHLO int-test", plainAuth(who), `MAIL FROM:<${who}>`, "RSET", "QUIT"]).then(
        (r) => afterAuth(r)[0],
      );
    expect(await mailFrom(listed)).toBe("250 2.1.0 OK");
    expect(await mailFrom(listed)).toBe("452 4.4.5 Rate limit exceeded, try again later.");
    expect(await mailFrom(unlisted)).toBe("250 2.1.0 OK");
    expect(await mailFrom(unlisted)).toBe("250 2.1.0 OK");
  });
});
