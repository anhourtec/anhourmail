// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The relay hold on the real pinned dev Stalwart (ADR-0034 update "relay hold"): probes R1–R6, pinned so an upgrade
 * that changes any of them is noticed.
 *
 * A held account is a key in an `x:MemoryLookupKey` namespace and `x:MtaStageRcpt.allowRelaying` refuses outside
 * recipients for it (`key_exists(<namespace>, authenticated_as)` → false), on every authenticated path: SMTP
 * submission and JMAP `EmailSubmission` with a password or an app password. Local recipients are not relaying, so
 * mail to hosted addresses keeps working.
 *
 * - R1 SMTP and JMAP for a listed account whose permissions are a normal customer's (SMTP AUTH allowed).
 * - R2 the ways to sign in under another spelling (an alias, upper case) still match the list.
 * - R3 what an unloaded or failed reload does (direction of failure), and whether `ReloadSettings` keeps the list.
 * - R4 the cost of `ReloadLookupStores` with a few thousand keys.
 * - R5 the provisioning path's permission set can write keys and reload (a key holding only what the hold needs).
 * - R6 (opt-in, `RELAY_HOLD_RESTART_PROBE=1`: restarts the dev Stalwart container) keys survive a restart and are in
 *   force at start without a reload.
 *
 * The expression is written with this run's own namespace, so only this run's throwaway accounts are held; the
 * original `allowRelaying` is written back afterwards. Outside recipients are on a made-up domain that dev routes to
 * Mailpit (no egress). JMAP goes from a documentation-range client address.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StalwartManagement, StalwartTransport } from "@anhourmail/stalwart-client";

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
const domain = `relay-${tag}.test`;
const password = randomBytes(18).toString("base64url");
/**
 * A fresh documentation-range client address for each JMAP request: every refused recipient counts towards Stalwart's
 * abuse ban of the client's address (`x:Security.abuseBanRate`, 35 a day, permanent; R1), so refusals are spread over
 * addresses nobody uses instead of the dev forwarder's one address that every mail-port test shares.
 */
let clientSeq = Math.floor(Math.random() * 200);
const nextClient = () => `198.51.100.${String(1 + (clientSeq++ % 254))}`;
const port = (k: string, d: number) => Number(process.env[k] ?? d);
const P465 = port("STALWART_SUBMISSIONS_PORT", 465);
const P587 = port("STALWART_SUBMISSION_PORT", 587);
const MAILPIT = `http://localhost:${process.env.MAILPIT_UI_PORT ?? "43026"}`;
const addr = (local: string) => `${local}@${domain}`;
const outside = (label: string) => `${label}-${tag}@ext-${tag}.test`;
const namespace = `am-relay-probe-${tag}`;
const RESTART = process.env.RELAY_HOLD_RESTART_PROBE === "1";
const REPO = path.resolve(import.meta.dirname, "../../../..");

const RELAY_REFUSED = "550 5.1.2 Relay not allowed.";
const RCPT_OK = "250 2.1.5 OK";

let keys: TestKeys;
const ids: Record<string, string> = {};
const restore: (() => Promise<void>)[] = [];

beforeAll(async () => {
  keys = await issueTestKeys(mgmt, stalwartUrl, `svc-relay-${tag}.test`);
  await mgmt.upsertDomain({ name: domain });
  const hash = await hashPassword(password);
  for (const local of ["listed", "unlisted", "late", "catch"]) {
    ids[local] = await keys.provisioning.upsertUser({
      name: local,
      domain,
      password: hash,
      quotaBytes: 50 * 1024 * 1024,
      access: "active",
      aliases: local === "listed" ? [{ name: "other", domain, enabled: true }] : [],
    });
  }
  const [stage] = await mgmt.transport.getAll<{ id: string; allowRelaying: unknown }>(
    "x:MtaStageRcpt",
    ["allowRelaying"],
    ["singleton"],
  );
  if (!stage) throw new Error("x:MtaStageRcpt singleton not found");
  restore.push(async () => {
    await mgmt.updateSingleton("x:MtaStageRcpt", { allowRelaying: stage.allowRelaying });
    await mgmt.reloadSettings();
  });
  await mgmt.updateSingleton("x:MtaStageRcpt", {
    allowRelaying: {
      match: { "0": { if: `key_exists('${namespace}', authenticated_as)`, then: "false" } },
      else: "!is_empty(authenticated_as)",
    },
  });
  await mgmt.reloadSettings();
}, 120_000);

afterAll(async () => {
  for (const undo of restore.reverse()) await undo();
  const left = await mgmt.transport.getAll<{ id: string; namespace: string }>("x:MemoryLookupKey", ["namespace"]);
  const ours = left.filter((k) => k.namespace.startsWith(namespace)).map((k) => k.id);
  for (let i = 0; i < ours.length; i += 500) {
    await mgmt.transport.set("x:MemoryLookupKey", { destroy: ours.slice(i, i + 500) });
  }
  await reloadLookups(mgmt);
  for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
    await mgmt.destroy("x:Account", u.id);
  }
  const d = (await mgmt.listDomains()).find((x) => x.name === domain);
  if (d) await mgmt.destroyDomain(d.id);
  await keys.cleanup();
}, 300_000);

const reloadLookups = (m: StalwartManagement) =>
  m.transport.set("x:Action", { create: { a: { "@type": "ReloadLookupStores" } } });

async function addKey(m: StalwartManagement, key: string, ns = namespace): Promise<string> {
  const { created } = await m.transport.set("x:MemoryLookupKey", {
    create: { k: { namespace: ns, key, isGlobPattern: false } },
  });
  const id = created.k?.id;
  if (!id) throw new Error("lookup key not created");
  return id;
}

const plain = (login: string, secret = password) =>
  `AUTH PLAIN ${Buffer.from(`\0${login}\0${secret}`).toString("base64")}`;

/** [AUTH, MAIL, RCPT outside, RCPT local] replies, signed in as `login` on 465. */
async function rcpts(login: string): Promise<string[]> {
  const replies = await smtpExchange(P465, "implicit", [
    "EHLO int-test",
    plain(login),
    `MAIL FROM:<${login}>`,
    `RCPT TO:<${outside("r")}>`,
    `RCPT TO:<${addr("catch")}>`,
    "QUIT",
  ]);
  return replies.slice(2, 6);
}

/**
 * Saves a draft to `to` and submits it over JMAP signed in as `login` with `secret`. Returns `refused:<type>` when the
 * submission isn't created, else the recipients' `smtpReply` from `deliveryStatus` once it is reported.
 */
async function jmapSend(login: string, secret: string, to: string, subject: string): Promise<string> {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${login}:${secret}`).toString("base64")}`,
    "Content-Type": "application/json",
    "X-Forwarded-For": nextClient(),
  };
  const sessionRes = await fetch(`${stalwartUrl}/jmap/session`, { headers });
  if (!sessionRes.ok) return `session:${String(sessionRes.status)}`;
  const session = (await sessionRes.json()) as { primaryAccounts: Record<string, string> };
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
  const from = (identities?.[1].list as { email: string }[] | undefined)?.[0]?.email ?? login;
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
  const sub = res[1];
  if (sub?.[0] === "error") return `error:${String(sub[1].type)}`;
  const refused = (sub?.[1].notCreated as Record<string, { type: string }> | undefined)?.s;
  if (refused) return `refused:${refused.type}`;
  const id = (sub?.[1].created as Record<string, { id: string }> | undefined)?.s?.id ?? "";
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

/** What an outside recipient gets from `login` over JMAP now: `held` (relay refused), `open` (accepted) or the reply. */
async function outsideState(login: string): Promise<string> {
  const reply = await jmapSend(login, password, outside("state"), `state ${tag}`);
  if (reply === RELAY_REFUSED) return "held";
  return reply.startsWith("250 ") ? "open" : reply;
}

/** Mailpit messages to `to`, polled for up to `ms` (dev and CI only; nothing leaves the machine). */
async function caughtFor(to: string, ms = 5_000): Promise<number> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const found = ((await r.json()) as { messages?: unknown[] }).messages ?? [];
    if (found.length > 0 || Date.now() > until) return found.length;
    await new Promise((res) => setTimeout(res, 500));
  }
}

async function waitReady(ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(`${stalwartUrl}/healthz/ready`);
      if (r.ok) {
        // The HTTP side answers a moment before the mail listeners; wait for submission to greet as well.
        const greeting = await smtpExchange(P465, "implicit", ["QUIT"]);
        if (greeting.some((g) => g.startsWith("220"))) return;
      }
    } catch {
      // still starting
    }
    if (Date.now() > until) throw new Error("Stalwart did not come back");
    await new Promise((res) => setTimeout(res, 1000));
  }
}

describe("relay hold on the pinned mail server (ADR-0034, probes R1–R6)", () => {
  it("R1 a listed account: outside recipients refused on 465, 587 and JMAP (password and app password); local kept", async () => {
    const listed = addr("listed");
    await addKey(mgmt, listed);
    await reloadLookups(mgmt);

    // SMTP: AUTH works (normal customer permissions), the outside RCPT is refused, the local one accepted. Every
    // refused RCPT counts towards the abuse ban of the client's address (Stalwart's `rcpt_error` → fail2ban, 35 a day,
    // permanent) and every mail-port test shares the dev forwarder's address, so SMTP refusals are kept to two here.
    const [auth, mail, out, local] = await rcpts(listed);
    expect(auth).toMatch(/^235 /);
    expect(mail).toBe("250 2.1.0 OK");
    expect(out).toBe(RELAY_REFUSED);
    expect(local).toBe(RCPT_OK);
    expect((await rcpts(addr("unlisted"))).slice(2)).toEqual([RCPT_OK, RCPT_OK]);

    // JMAP with the mailbox password: the submission is created, the outside recipient's delivery is refused and
    // nothing reaches Mailpit; a local recipient is delivered.
    const toOut = outside("r1-jmap");
    expect(await jmapSend(listed, password, toOut, `r1 ${tag}`)).toBe(RELAY_REFUSED);
    expect(await jmapSend(listed, password, addr("catch"), `r1 local ${tag}`)).toMatch(/^250 /);

    // JMAP with a `jmap`-scope app password (the mail-app route over HTTPS): the same refusal.
    const app = await keys.operations.createAppPassword(ids.listed ?? "", { description: "relay", scopes: ["jmap"] });
    expect(await jmapSend(listed, app.secret, toOut, `r1 app ${tag}`)).toBe(RELAY_REFUSED);
    expect(await jmapSend(listed, app.secret, addr("catch"), `r1 app local ${tag}`)).toMatch(/^250 /);
    // An `smtp`-scope app password on 587: AUTH works, outside refused.
    const smtpApp = await keys.operations.createAppPassword(ids.listed ?? "", {
      description: "relay smtp",
      scopes: ["smtp"],
    });
    const replies = await smtpExchange(P587, "starttls", [
      "EHLO int-test",
      plain(listed, smtpApp.secret),
      `MAIL FROM:<${listed}>`,
      `RCPT TO:<${outside("r1-app")}>`,
      "QUIT",
    ]);
    expect(replies[4]).toMatch(/^235 /);
    expect(replies[6]).toBe(RELAY_REFUSED);
    expect(await caughtFor(toOut)).toBe(0);
    expect(await caughtFor(outside("r1-app"))).toBe(0);

    // An unlisted account relays (caught by Mailpit).
    const fromUnlisted = outside("r1-unlisted");
    expect(await jmapSend(addr("unlisted"), password, fromUnlisted, `r1 unlisted ${tag}`)).toMatch(/^250 /);
    expect(await caughtFor(fromUnlisted, 20_000)).toBe(1);
  });

  it("R2 signing in by an alias or in upper case still matches the account's own name (JMAP)", async () => {
    const listed = addr("listed");
    // Basic sign-in with an alias (the User role's `authenticateWithAlias`) and in upper case: both sign in, both held.
    for (const login of [addr("other"), listed.toUpperCase()]) {
      expect(await jmapSend(login, password, outside("r2"), `r2 ${tag}`)).toBe(RELAY_REFUSED);
    }
    expect(await caughtFor(outside("r2"), 2_000)).toBe(0);
  });

  it("R3 a key isn't in force until ReloadLookupStores; ReloadSettings keeps the loaded list; removal fails safe", async () => {
    const late = addr("late");
    const id = await addKey(mgmt, late);
    // Written but not reloaded: not held (adding fails open until the reload, so it must come before relaxing access).
    expect(await outsideState(late)).toBe("open");
    // ReloadSettings (every policy write runs one) neither loads it nor drops what is loaded.
    await mgmt.reloadSettings();
    expect(await outsideState(late)).toBe("open");
    expect(await outsideState(addr("listed"))).toBe("held");
    await reloadLookups(mgmt);
    expect(await outsideState(late)).toBe("held");
    // Destroyed but not reloaded: still held (removing fails safe).
    await mgmt.transport.set("x:MemoryLookupKey", { destroy: [id] });
    expect(await outsideState(late)).toBe("held");
    // A reload that can't run (refused for a key without the action's permission) changes nothing loaded.
    await expect(reloadLookups(keys.provisioning)).rejects.toThrow();
    expect(await outsideState(late)).toBe("held");
    // An unusable glob pattern next to real keys doesn't break a reload or the keys already loaded.
    const { created } = await mgmt.transport.set("x:MemoryLookupKey", {
      create: { g: { namespace: `${namespace}-glob`, key: "[", isGlobPattern: true } },
    });
    expect(created.g?.id).toBeTruthy();
    await reloadLookups(mgmt);
    expect(await outsideState(late)).toBe("open");
    expect(await outsideState(addr("listed"))).toBe("held");
  });

  it("R4 ReloadLookupStores with 3,000 keys stays fast and the list still answers per account", async () => {
    const bulk = `${namespace}-bulk`;
    const writeStart = Date.now();
    for (let i = 0; i < 3000; i += 500) {
      const create = Object.fromEntries(
        Array.from({ length: 500 }, (_, j) => [
          `k${String(j)}`,
          { namespace: bulk, key: `bulk-${String(i + j)}-${tag}@${domain}`, isGlobPattern: false },
        ]),
      );
      const { created } = await mgmt.transport.set("x:MemoryLookupKey", { create });
      expect(Object.keys(created)).toHaveLength(500);
    }
    const writeMs = Date.now() - writeStart;
    const reloads: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await reloadLookups(mgmt);
      reloads.push(Date.now() - t);
    }
    expect(await outsideState(addr("listed"))).toBe("held");
    expect(await outsideState(addr("unlisted"))).toBe("open");
    // 2026-11-11 on the dev stack: 3,000 keys written in 0.3 s; each reload 2 ms (research/stalwart.md "Relay hold").
    expect(writeMs, "writing 3,000 keys").toBeLessThan(30_000);
    expect(Math.max(...reloads), `ReloadLookupStores ${reloads.join(" / ")} ms`).toBeLessThan(5_000);
  }, 180_000);

  it("R5 the hold key writes the list and reloads it, and can't run any other action or touch accounts", async () => {
    // The production provisioning key can't (no `sysMemoryLookupKey*`, no `sysActionCreate`).
    await expect(addKey(keys.provisioning, addr("unlisted"))).rejects.toThrow();
    const k = keys.hold;
    const id = await addKey(k, addr("unlisted"));
    await reloadLookups(k);
    expect(await outsideState(addr("unlisted"))).toBe("held");
    await k.transport.set("x:MemoryLookupKey", { destroy: [id] });
    await reloadLookups(k);
    expect(await outsideState(addr("unlisted"))).toBe("open");
    // Stalwart checks a permission per action type: the hold key can't pause the queue or reload settings.
    const action = (type: string) => k.transport.set("x:Action", { create: { a: { "@type": type } } });
    for (const type of ["PauseMtaQueue", "ResumeMtaQueue", "ReloadSettings", "InvalidateCaches"]) {
      await expect(action(type)).rejects.toThrow();
    }
    // Nothing about accounts or the relay expression itself.
    await expect(k.transport.getAll("x:Account", ["name"])).rejects.toThrow();
    await expect(
      k.transport.set("x:MtaStageRcpt", { update: { singleton: { allowRelaying: { match: {}, else: "true" } } } }),
    ).rejects.toThrow();
    const [stage] = await k.transport.getAll<{ id: string; allowRelaying: unknown }>(
      "x:MtaStageRcpt",
      ["allowRelaying"],
      ["singleton"],
    );
    expect(JSON.stringify(stage?.allowRelaying)).toContain(namespace);
    // But the permission covers every namespace, the spam filter's lists included: only the management proxy keeps
    // this key to the hold's namespace in production.
    const spam = await addKey(k, `${tag}.invalid`, "trusted-domains");
    await k.transport.set("x:MemoryLookupKey", { destroy: [spam] });
  });

  it.runIf(RESTART)(
    "R6 keys survive a restart and are in force at start, also one written but never reloaded",
    async () => {
      const late = addr("late");
      await addKey(mgmt, late);
      // `listed` is loaded (R1); `late` is written but not reloaded.
      expect(await outsideState(late)).toBe("open");
      execFileSync("docker", ["compose", "restart", "stalwart"], { cwd: REPO, stdio: "ignore" });
      await waitReady();
      expect(await outsideState(addr("listed"))).toBe("held");
      expect(await outsideState(late)).toBe("held");
      expect(await outsideState(addr("unlisted"))).toBe("open");
    },
    240_000,
  );
});
