// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The mail server's sending ceiling for every authenticated sender (ADR-0034 §4, build slice 13) on the pinned dev
 * Stalwart: `applySendingPolicy` with the standard tier's real numbers writes two `authenticatedAs` throttles and the
 * authenticated RCPT cap, is idempotent, and `sendingPolicyDrift` reads it back clean; a customer account's 51st MAIL
 * FROM in an hour gets `452 4.4.5` and its 51st recipient `455 4.5.3`, while an exempt system account (the
 * transactional sender) is not limited by it.
 *
 * The policy here exempts this run's throwaway domain instead of the platform domain, so its `no-reply` can be tested;
 * whatever the dev stack had before (the dev plan's own policy, or nothing) is written back afterwards.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applySendingPolicy,
  SENDING_THROTTLE_DESCRIPTIONS,
  sendingPolicyDrift,
  StalwartManagement,
  StalwartTransport,
} from "@anhourmail/stalwart-client";
import { standardSendingPolicy, TRUST_TIERS } from "@anhourmail/shared/sending";

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
const domain = `ceiling-${tag}.test`;
const password = randomBytes(18).toString("base64url");
const P587 = Number(process.env.STALWART_SUBMISSION_PORT ?? 587);
const addr = (local: string) => `${local}@${domain}`;
/** Fresh outside recipients (dev routes them to Mailpit; nothing here reaches DATA). */
const outside = (label: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${label}-${String(i)}-${tag}@ext-${tag}.test`);
const policy = standardSendingPolicy(domain);
const limits = TRUST_TIERS.standard.limits;

type Throttle = { id: string; description?: string } & Record<string, unknown>;
let keys: TestKeys;
const restore: (() => Promise<void>)[] = [];

beforeAll(async () => {
  keys = await issueTestKeys(mgmt, stalwartUrl, `svc-ceiling-${tag}.test`);
  await mgmt.upsertDomain({ name: domain });
  const hash = await hashPassword(password);
  for (const local of ["counted", "capped", "no-reply"]) {
    await keys.provisioning.upsertUser({ name: local, domain, password: hash, quotaBytes: 10 * 1024 * 1024 });
  }
  // What the dev stack has now (the dev plan's ceiling, or none), written back exactly afterwards.
  const ours = new Set<string>(Object.values(SENDING_THROTTLE_DESCRIPTIONS));
  const before = (
    await mgmt.transport.getAll<Throttle>("x:MtaInboundThrottle", ["description", "enable", "key", "match", "rate"])
  ).filter((t) => ours.has(t.description ?? ""));
  const [stage] = await mgmt.transport.getAll<{ id: string; maxRecipients: unknown }>(
    "x:MtaStageRcpt",
    ["maxRecipients"],
    ["singleton"],
  );
  restore.push(async () => {
    const now = (await mgmt.transport.getAll<Throttle>("x:MtaInboundThrottle", ["description"])).filter((t) =>
      ours.has(t.description ?? ""),
    );
    if (now.length > 0) await mgmt.transport.set("x:MtaInboundThrottle", { destroy: now.map((t) => t.id) });
    if (before.length > 0) {
      await mgmt.transport.set("x:MtaInboundThrottle", {
        create: Object.fromEntries(before.map(({ id: _id, ...t }, i) => [`r${String(i)}`, t])),
      });
    }
    await mgmt.updateSingleton("x:MtaStageRcpt", { maxRecipients: stage?.maxRecipients });
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
const code = (reply: string | undefined) => (reply ?? "").slice(0, 3);

/** `n` MAIL FROM + RSET transactions on 587 (each counts once, P2); the MAIL FROM replies. */
async function transactions(sender: string, n: number): Promise<string[]> {
  const lines = Array.from({ length: n }, () => [`MAIL FROM:<${sender}>`, "RSET"]).flat();
  // Greeting, EHLO, STARTTLS, EHLO, AUTH first; then MAIL/RSET pairs.
  const replies = await smtpExchange(P587, "starttls", ["EHLO int-test", plainAuth(sender), ...lines, "QUIT"]);
  return replies
    .slice(5)
    .filter((_, i) => i % 2 === 0)
    .slice(0, n);
}

/** One MAIL FROM with `n` recipients on 587, then RSET; the RCPT replies. */
async function recipients(sender: string, n: number, label: string): Promise<string[]> {
  const rcpts = outside(label, n).map((r) => `RCPT TO:<${r}>`);
  const replies = await smtpExchange(P587, "starttls", [
    "EHLO int-test",
    plainAuth(sender),
    `MAIL FROM:<${sender}>`,
    ...rcpts,
    "RSET",
    "QUIT",
  ]);
  return replies.slice(6, 6 + n);
}

describe("the authenticated-sender ceiling on the mail server", () => {
  it("is written once, then nothing changes on a second run, and reads back clean", async () => {
    const first = await applySendingPolicy(mgmt, policy);
    expect(first.created + first.updated).toBeGreaterThan(0);
    expect(await applySendingPolicy(mgmt, policy)).toEqual({
      created: 0,
      updated: 0,
      removed: 0,
      recipientsChanged: false,
    });
    expect(await sendingPolicyDrift(mgmt, policy)).toEqual([]);
    // The worker's provisioning key can't read it (no `sysMtaInboundThrottleGet`): the reconciler reports the check as
    // not run with it (an ops follow-up gives the reconciler's key the two read permissions).
    await expect(sendingPolicyDrift(keys.provisioning, policy)).rejects.toThrow();
  }, 60_000);

  it("refuses a customer's message beyond the hourly allowance at MAIL FROM (452 4.4.5)", async () => {
    const replies = await transactions(addr("counted"), limits.messagesPerHour + 1);
    expect(replies.slice(0, limits.messagesPerHour).every((r) => code(r) === "250")).toBe(true);
    expect(replies[limits.messagesPerHour]).toBe("452 4.4.5 Rate limit exceeded, try again later.");
  }, 90_000);

  it("caps a customer's recipients per message (455 4.5.3 on the one past the cap)", async () => {
    const replies = await recipients(addr("capped"), limits.recipientsPerMessage + 1, "cap");
    expect(replies.slice(0, limits.recipientsPerMessage).every((r) => code(r) === "250")).toBe(true);
    expect(code(replies[limits.recipientsPerMessage])).toBe("455");
  }, 90_000);

  it("leaves the exempt transactional sender alone: past the hourly allowance and the recipient cap", async () => {
    const sender = addr("no-reply");
    const mail = await transactions(sender, limits.messagesPerHour + 1);
    expect(mail.every((r) => code(r) === "250")).toBe(true);
    const rcpts = await recipients(sender, limits.recipientsPerMessage + 1, "exempt");
    expect(rcpts.every((r) => code(r) === "250")).toBe(true);
  }, 120_000);

  it("reports drift by name when someone changes it", async () => {
    const [hour] = (await mgmt.transport.getAll<Throttle>("x:MtaInboundThrottle", ["description"])).filter(
      (t) => t.description === SENDING_THROTTLE_DESCRIPTIONS.hour,
    );
    if (!hour) throw new Error("hourly throttle missing");
    await mgmt.transport.set("x:MtaInboundThrottle", {
      // A partial update of the numbers (what a hand edit in the admin would do).
      update: { [hour.id]: { rate: { count: limits.messagesPerHour * 10, period: 3_600_000 } } },
    });
    await mgmt.updateSingleton("x:MtaStageRcpt", { maxRecipients: { match: {}, else: "100" } });
    expect(await sendingPolicyDrift(mgmt, policy)).toEqual(["throttle-hour-changed", "max-recipients-changed"]);
    const fixed = await applySendingPolicy(mgmt, policy);
    expect(fixed).toMatchObject({ updated: 1, recipientsChanged: true });
    expect(await sendingPolicyDrift(mgmt, policy)).toEqual([]);
  }, 60_000);
});
