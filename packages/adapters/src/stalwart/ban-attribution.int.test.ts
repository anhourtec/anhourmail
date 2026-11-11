// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Which client address the pinned dev Stalwart counts a refusal against (research/stalwart.md "Which address a refusal
 * counts against"; ADR-0034 update "the webmail's client address"). Opt-in (`BAN_PROBE=1`): it changes server-wide
 * settings for a minute — the dev allow-list's private ranges are taken off (and put back: Stalwart deletes an entry
 * once it expires, so they are recreated), the abuse
 * and failed-login ban rates are lowered and the abuse-ban period set — and starts a throwaway client container on the
 * dev mail network (`docker run`). Everything is written back afterwards, and the bans it causes are lifted. Nothing in
 * it can ban the dev forwarder: its own requests carry the right password, and the failed sign-ins run with the
 * allow-list on.
 *
 * - B1 a held account's JMAP submissions to an outside recipient (relay refused), with and without X-Forwarded-For,
 *   over the abuse rate for the client and for the recipient: no address is banned (the submission's SMTP session is
 *   a local one from 127.0.0.1, which is always allowed).
 * - B2 the same for an unknown hosted recipient (`550 5.1.2 Mailbox does not exist.` in `deliveryStatus`).
 * - B3 failed sign-ins on `/jmap` follow X-Forwarded-For: the forwarded address is banned, not the connection's.
 * - B5 a malformed bearer token is refused (401) without counting. (A real token that has expired or was revoked
 *   isn't probed: an access token lives an hour.)
 * - B4 control: the same relay refusals in an SMTP session from a client on the mail network ban that client, for the
 *   abuse-ban period `applyAbuseBanPeriod` set.
 *
 * Outside recipients are on made-up domains that dev routes to Mailpit; nothing leaves the machine (rule 19).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyAbuseBanPeriod, StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
const RUN = process.env.BAN_PROBE === "1";
if (RUN && (!stalwartUrl || !admin || !adminPassword)) {
  throw new Error("the ban probe needs STALWART_URL and the dev Stalwart admin");
}

const mgmt = new StalwartManagement(
  new StalwartTransport({
    baseUrl: stalwartUrl ?? "http://unused.invalid",
    auth: { type: "basic", username: admin ?? "", password: adminPassword ?? "" },
  }),
);
const tag = randomUUID().slice(0, 8);
const domain = `ban-${tag}.test`;
const password = randomBytes(18).toString("base64url");
const namespace = `am-ban-probe-${tag}`;
const held = `held@${domain}`;
const outsideRcpt = `r-${tag}@ext-${tag}.test`;
const MAIL_NETWORK = process.env.STALWART_MAIL_NETWORK ?? "anhourmail_mailnet";
const CLIENT_IMAGE = "alpine/socat:1.8.0.3";
const BAN_PERIOD_MS = 3_600_000;
/** Lowered for the probe: the third refusal (or failed sign-in) from one address in a day bans it. */
const LOW_RATE = { count: 2, period: 86_400_000 };

type Ban = { id: string; address: string; reason: string; expiresAt: string | null };
const restore: (() => Promise<void>)[] = [];
let bansBefore = new Set<string>();

const reloadLookups = () => mgmt.transport.set("x:Action", { create: { a: { "@type": "ReloadLookupStores" } } });
const reloadBans = () => mgmt.transport.set("x:Action", { create: { a: { "@type": "ReloadBlockedIps" } } });
const bans = () => mgmt.transport.getAll<Ban>("x:BlockedIp", ["address", "reason", "expiresAt"]);
const newBans = async () => (await bans()).filter((b) => !bansBefore.has(b.id));

type Allowed = { address: string; reason: string | null };
/** The allow-list entries switched off by this run (Stalwart drops an entry once it expires, so they are recreated). */
let allowed: Allowed[] = [];

/** Takes the allow-list's entries off (`on` false) or puts the ones taken off back. Settings are reloaded. */
async function setAllowList(on: boolean): Promise<void> {
  const have = await mgmt.transport.getAll<{ id: string } & Allowed>("x:AllowedIp", ["address", "reason"]);
  if (on) {
    const missing = allowed.filter((a) => !have.some((h) => h.address === a.address));
    if (missing.length > 0) {
      await mgmt.transport.set("x:AllowedIp", {
        create: Object.fromEntries(missing.map((a, i) => [`a${String(i)}`, { address: a.address, reason: a.reason }])),
      });
    }
  } else {
    if (allowed.length === 0) allowed = have.map((h) => ({ address: h.address, reason: h.reason }));
    if (have.length > 0) await mgmt.transport.set("x:AllowedIp", { destroy: have.map((h) => h.id) });
  }
  await mgmt.reloadSettings();
}

beforeAll(async () => {
  if (!RUN) return;
  bansBefore = new Set((await bans()).map((b) => b.id));
  await mgmt.upsertDomain({ name: domain });
  await mgmt.upsertUser({
    name: "held",
    domain,
    password: await hashPassword(password),
    quotaBytes: 50 * 1024 * 1024,
    access: "active",
    aliases: [],
  });
  // Only this run's account is held: the expression names this run's namespace.
  const [stage] = await mgmt.transport.getAll<{ id: string; allowRelaying: unknown }>(
    "x:MtaStageRcpt",
    ["allowRelaying"],
    ["singleton"],
  );
  if (!stage) throw new Error("x:MtaStageRcpt singleton not found");
  restore.push(async () => {
    await mgmt.updateSingleton("x:MtaStageRcpt", { allowRelaying: stage.allowRelaying });
  });
  await mgmt.updateSingleton("x:MtaStageRcpt", {
    allowRelaying: {
      match: { "0": { if: `key_exists('${namespace}', authenticated_as)`, then: "false" } },
      else: "!is_empty(authenticated_as)",
    },
  });
  await mgmt.transport.set("x:MemoryLookupKey", {
    create: { k: { namespace, key: held, isGlobPattern: false } },
  });
  await reloadLookups();
  const [security] = await mgmt.transport.getAll<{
    id: string;
    abuseBanRate: unknown;
    abuseBanPeriod: unknown;
    authBanRate: unknown;
    authBanPeriod: unknown;
  }>("x:Security", ["abuseBanRate", "abuseBanPeriod", "authBanRate", "authBanPeriod"], ["singleton"]);
  if (!security) throw new Error("x:Security singleton not found");
  restore.push(async () => {
    await mgmt.updateSingleton("x:Security", {
      abuseBanRate: security.abuseBanRate,
      abuseBanPeriod: security.abuseBanPeriod,
      authBanRate: security.authBanRate,
      authBanPeriod: security.authBanPeriod,
    });
  });
  await mgmt.updateSingleton("x:Security", { abuseBanRate: LOW_RATE, authBanRate: LOW_RATE });
  await applyAbuseBanPeriod(mgmt, BAN_PERIOD_MS);
  restore.push(async () => {
    await setAllowList(true);
  });
  await setAllowList(false);
}, 120_000);

afterAll(async () => {
  if (!RUN) return;
  // Every step is tried even when one fails: a server-wide setting must never stay lowered.
  const failures: unknown[] = [];
  for (const undo of restore.reverse()) await undo().catch((err: unknown) => failures.push(err));
  await mgmt.reloadSettings();
  const made = await newBans();
  if (made.length > 0) await mgmt.transport.set("x:BlockedIp", { destroy: made.map((b) => b.id) });
  await reloadBans();
  const keys = await mgmt.transport.getAll<{ id: string; namespace: string }>("x:MemoryLookupKey", ["namespace"]);
  const ours = keys.filter((k) => k.namespace === namespace).map((k) => k.id);
  if (ours.length > 0) await mgmt.transport.set("x:MemoryLookupKey", { destroy: ours });
  await reloadLookups();
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  if (failures.length > 0) throw new AggregateError(failures, "ban probe: not everything was written back");
}, 120_000);

/**
 * Saves a draft to `to` and submits it over JMAP as the held account, with `forwardedFor` as X-Forwarded-For (none when
 * null). Returns the recipient's `smtpReply` from `deliveryStatus`, or `refused:<type>` when nothing was created.
 */
async function jmapSend(to: string, forwardedFor: string | null): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${held}:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
    ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
  };
  const session = (await (await fetch(`${stalwartUrl ?? ""}/jmap/session`, { headers })).json()) as {
    primaryAccounts: Record<string, string>;
  };
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"] ?? "";
  const using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const call = async (methodCalls: unknown[]) =>
    (
      (await (
        await fetch(`${stalwartUrl ?? ""}/jmap`, {
          method: "POST",
          headers,
          body: JSON.stringify({ using, methodCalls }),
        })
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
            from: [{ email: held }],
            to: [{ email: to }],
            subject: `ban probe ${tag}`,
            bodyValues: { b: { value: "probe" } },
            textBody: [{ partId: "b", type: "text/plain" }],
          },
        },
      },
      "e",
    ],
    ["EmailSubmission/set", { accountId, create: { s: { emailId: "#e", identityId } } }, "s"],
  ]);
  const sub = res[1];
  const refused = (sub?.[1].notCreated as Record<string, { type: string }> | undefined)?.s;
  if (refused) return `refused:${refused.type}`;
  const id = (sub?.[1].created as Record<string, { id: string }> | undefined)?.s?.id ?? "";
  for (let i = 0; i < 20; i++) {
    const [got] = await call([["EmailSubmission/get", { accountId, ids: [id], properties: ["deliveryStatus"] }, "g"]]);
    const status = (got?.[1].list as { deliveryStatus?: Record<string, { smtpReply: string }> | null }[])[0]
      ?.deliveryStatus;
    if (status && Object.keys(status).length > 0) return Object.values(status)[0]?.smtpReply ?? "";
    await new Promise((r) => setTimeout(r, 300));
  }
  return "no delivery status";
}

/**
 * An SMTP session on 465 from a throwaway client container on the dev mail network, signed in as the held account,
 * asking for `rcpts` one at a time. Returns the client's address and the transcript.
 */
async function smtpFromContainer(rcpts: string[]): Promise<{ ip: string; transcript: string }> {
  const auth = Buffer.from(`\0${held}\0${password}`).toString("base64");
  const lines = [
    "EHLO probe.example.org",
    `AUTH PLAIN ${auth}`,
    `MAIL FROM:<${held}>`,
    ...rcpts.map((r) => `RCPT TO:<${r}>`),
    "QUIT",
  ];
  // Stalwart waits a few seconds before answering a refused recipient: give each line time.
  const script = `hostname -i; (${lines.map((l) => `printf '%s\\r\\n' '${l}'; sleep 7`).join("; ")}) | socat -T60 - OPENSSL:stalwart:465,verify=0 2>&1 || true`;
  // Asynchronous, so the event loop keeps serving this test's own HTTP connections meanwhile.
  const { stdout: out } = await promisify(execFile)(
    "docker",
    ["run", "--rm", "--network", MAIL_NETWORK, "--entrypoint", "sh", CLIENT_IMAGE, "-c", script],
    { encoding: "utf8", timeout: 120_000 },
  );
  const [ip = "", ...rest] = out.split("\n");
  return { ip: ip.trim(), transcript: rest.join("\n") };
}

describe.skipIf(!RUN)("which address a refusal counts against (opt-in: BAN_PROBE=1)", () => {
  it("B1: a JMAP submission's refused outside recipients ban no address, forwarded or not", async () => {
    // Five refusals of one recipient and of each client address: over the lowered rate on every count.
    for (const xff of ["203.0.113.71", "203.0.113.71", "203.0.113.71", null, null]) {
      expect(await jmapSend(outsideRcpt, xff)).toBe("550 5.1.2 Relay not allowed.");
    }
    expect(await newBans()).toEqual([]);
  }, 120_000);

  it("B2: nor do a JMAP submission's unknown hosted recipients", async () => {
    for (const xff of ["203.0.113.72", "203.0.113.72", "203.0.113.72", null]) {
      expect(await jmapSend(`nobody-${tag}@${domain}`, xff)).toMatch(/^550 5\.1\.2 /);
    }
    expect(await newBans()).toEqual([]);
  }, 120_000);

  it("B3: a failed sign-in on /jmap counts against the forwarded address, not the connection's", async () => {
    const forwarded = "203.0.113.73";
    // With the allow-list on: were the header ignored, the failures would count against the dev forwarder, which is
    // then exempt (the test fails instead of banning the address every dev request comes from).
    await setAllowList(true);
    try {
      for (let i = 0; i < 4; i++) {
        await fetch(`${stalwartUrl ?? ""}/jmap/session`, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${held}:wrong-${String(i)}`).toString("base64")}`,
            "X-Forwarded-For": forwarded,
          },
        });
      }
    } finally {
      await setAllowList(false);
    }
    const made = await newBans();
    expect(made.map((b) => [b.address, b.reason])).toEqual([[forwarded, "authFailure"]]);
    // The failed-login ban keeps its own period (unset: permanent); only the abuse ban's was set.
    expect(made[0]?.expiresAt).toBeNull();
  }, 60_000);

  it("B5: a malformed bearer token is refused without counting as a failed sign-in", async () => {
    const forwarded = "203.0.113.74";
    await setAllowList(true);
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${stalwartUrl ?? ""}/jmap/session`, {
          headers: { Authorization: `Bearer not-a-token-${tag}-${String(i)}`, "X-Forwarded-For": forwarded },
        });
        statuses.push(res.status);
      }
    } finally {
      await setAllowList(false);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses.every((st) => st === 401)).toBe(true);
    expect((await newBans()).filter((b) => b.address === forwarded)).toEqual([]);
  }, 60_000);

  it("B4 (control): the same refusals in an SMTP session ban that client, for the abuse-ban period", async () => {
    const before = Date.now();
    const { ip, transcript } = await smtpFromContainer([1, 2, 3, 4].map((i) => `c${String(i)}-${tag}@ext-${tag}.test`));
    expect(transcript).toContain("235 ");
    expect(transcript).toContain("550 5.1.2 Relay not allowed.");
    const ban = (await newBans()).find((b) => b.address === ip);
    expect(ban?.reason).toBe("rcptToFailure");
    const expires = new Date(ban?.expiresAt ?? 0).getTime();
    expect(expires).toBeGreaterThan(before + BAN_PERIOD_MS - 120_000);
    expect(expires).toBeLessThan(Date.now() + BAN_PERIOD_MS + 120_000);
  }, 180_000);
});
