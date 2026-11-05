// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The training key and the import's spam-sample clean-up (ADR-0030 update 2026-11-05) against the real dev Stalwart,
 * with the real, exactly-scoped key (`TRAINING_KEY_PERMISSIONS`; ADR-0020 "Credential split"). Pinned on every
 * Stalwart upgrade (rule 22):
 *   - every APPEND adds a sample for the account, ham outside Junk, spam in Junk, with `expiresAt` = creation +
 *     `holdSamplesFor` (default 180 days);
 *   - the training key finds one account's samples (`query { filter: { accountId } }`) and destroys the import's ham
 *     samples of a time window, leaving spam samples and other accounts' samples alone;
 *   - it can do nothing else: no sample create or update, no account, domain, credential, classifier, mail, Sieve or
 *     blob access, and the start-up scope check accepts exactly it.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  accountTrainingSamples,
  SPAM_SAMPLE_HOLD_DEFAULT_MS,
  StalwartManagement,
  StalwartTransport,
  verifyStalwartCredential,
} from "@anhourmail/stalwart-client";

import { hashPassword } from "../auth/password";
import { stalwartImportTrainingSamples } from ".";
import { imapSession } from "./int-imap";
import { issueTestKeys } from "./int-keys";

const stalwartUrl = process.env.STALWART_URL;
const admin = process.env.STALWART_DEV_ADMIN_USER;
const adminPassword = process.env.STALWART_DEV_ADMIN_PASSWORD;
if (!stalwartUrl || !admin || !adminPassword) throw new Error("integration tests need the dev Stalwart admin");

const mgmt = new StalwartManagement(
  new StalwartTransport({ baseUrl: stalwartUrl, auth: { type: "basic", username: admin, password: adminPassword } }),
);
const tag = randomUUID().slice(0, 8);
const keys = await issueTestKeys(mgmt, stalwartUrl, `svc-${tag}.test`);
const domain = `trn-${tag}.test`;
const ids: Record<"a" | "b", string> = { a: "", b: "" };

const adminSamples = async (accountId: string) =>
  (
    await mgmt.transport.getAll<{ id: string; accountId?: string; isSpam?: boolean }>("x:SpamTrainingSample", [
      "accountId",
      "isSpam",
    ])
  ).filter((s) => s.accountId === accountId);

afterAll(async () => {
  try {
    for (const id of Object.values(ids)) {
      const left = (await adminSamples(id)).map((s) => s.id);
      if (left.length > 0) await mgmt.transport.set("x:SpamTrainingSample", { destroy: left }).catch(() => undefined);
    }
    for (const u of (await mgmt.listUsers()).filter((x) => x.address.endsWith(`@${domain}`))) {
      await mgmt.destroy("x:Account", u.id);
    }
    for (let i = 0; i < 5; i++) {
      const d = (await mgmt.listDomains()).find((x) => x.name === domain);
      if (
        !d ||
        (await mgmt.destroyDomain(d.id).then(
          () => true,
          () => false,
        ))
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await keys.cleanup();
  }
});

async function appendTo(name: "a" | "b", folders: string[]): Promise<void> {
  const credential = await keys.operations.createImportCredential(ids[name], new Date(Date.now() + 600_000));
  const s = await imapSession();
  try {
    expect(await s.run(`LOGIN "${name}@${domain}" "${credential.secret}"`)).toMatch(/^t1 OK/m);
    for (const folder of folders) {
      const raw = `From: x@old-${tag}.test\r\nSubject: sample ${randomUUID()}\r\nMessage-ID: <${randomUUID()}@old>\r\n\r\nhi\r\n`;
      expect(await s.run(`APPEND "${folder}" () {${String(Buffer.byteLength(raw))}+}\r\n${raw}`)).toMatch(/OK/);
    }
  } finally {
    s.close();
  }
}

describe("spam-training sample clean-up with the training key (ADR-0030)", () => {
  it("is exactly its documented set", async () => {
    expect(await verifyStalwartCredential("training", keys.training)).toBe("key");
  });

  it("finds one account's samples and destroys the import's ham samples of a window only", async () => {
    await keys.provisioning.upsertDomain({ name: domain });
    for (const name of ["a", "b"] as const) {
      ids[name] = await keys.provisioning.upsertUser({
        name,
        domain,
        password: await hashPassword(randomBytes(18).toString("base64url")),
        quotaBytes: 50 * 1024 * 1024,
        suspended: false,
      });
    }
    // Before the window: a ham sample of the person's own.
    await appendTo("a", ["INBOX"]);
    await expect.poll(async () => (await adminSamples(ids.a)).length, { timeout: 10_000 }).toBe(1);
    await new Promise((r) => setTimeout(r, 2100));
    const from = new Date();
    await appendTo("a", ["INBOX", "INBOX", "Junk Mail"]);
    await appendTo("b", ["INBOX"]);
    const to = new Date();
    await expect.poll(async () => (await adminSamples(ids.a)).length, { timeout: 10_000 }).toBe(4);

    const seen = await accountTrainingSamples(keys.training, ids.a);
    expect(seen).toHaveLength(4);
    expect(seen.every((s) => s.accountId === ids.a)).toBe(true);
    expect(seen.filter((s) => s.isSpam)).toHaveLength(1);
    // expiresAt = creation + the default hold (whole seconds).
    for (const s of seen) {
      const created = (s.expiresAt?.getTime() ?? 0) - SPAM_SAMPLE_HOLD_DEFAULT_MS;
      expect(created).toBeGreaterThan(from.getTime() - 10_000);
      expect(created).toBeLessThanOrEqual(to.getTime());
    }

    const cleaner = stalwartImportTrainingSamples(keys.training, { slackMs: 500 });
    expect(await cleaner.removeImported(ids.a, { from, to })).toEqual({ removed: 2 });
    const left = await adminSamples(ids.a);
    // The spam one (Junk: the person's own placement in this test) and the one before the window stay.
    expect(left.map((s) => s.isSpam).sort()).toEqual([false, true]);
    expect(await adminSamples(ids.b)).toHaveLength(1);
    expect(await cleaner.removeImported(ids.a, { from, to })).toEqual({ removed: 0 });
  });

  it("can do nothing else", async () => {
    const t = keys.training.transport;
    const refused = async (using: string[], call: [string, Record<string, unknown>, string]) =>
      t.rawCall(using, [call]).then(
        () => "allowed",
        (err: unknown) => /method error: (\w+)/.exec(err instanceof Error ? err.message : "")?.[1] ?? "error",
      );
    const core = "urn:ietf:params:jmap:core";
    const stalwart = "urn:stalwart:jmap";
    const [sample] = await adminSamples(ids.a);
    expect(
      await Promise.all([
        refused(
          [core, stalwart],
          ["x:SpamTrainingSample/set", { create: { n: { accountId: ids.a, isSpam: true } } }, "c"],
        ),
        refused(
          [core, stalwart],
          ["x:SpamTrainingSample/set", { update: { [sample?.id ?? "x"]: { isSpam: false } } }, "u"],
        ),
        refused([core, stalwart], ["x:Account/get", { ids: [ids.a] }, "a"]),
        refused([core, stalwart], ["x:Domain/get", {}, "d"]),
        refused([core, stalwart], ["x:AppPassword/get", { accountId: ids.a }, "p"]),
        refused([core, stalwart], ["x:SpamClassifier/get", { ids: ["singleton"] }, "s"]),
        refused([core, "urn:ietf:params:jmap:mail"], ["Email/query", { accountId: ids.a }, "e"]),
        refused([core, "urn:ietf:params:jmap:mail"], ["Mailbox/get", { accountId: ids.a }, "m"]),
        refused([core, "urn:ietf:params:jmap:sieve"], ["SieveScript/get", { accountId: ids.a }, "v"]),
      ]),
    ).toEqual(Array.from({ length: 9 }, () => "forbidden"));
  });
});
