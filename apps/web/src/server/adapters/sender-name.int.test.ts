// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The webmail side of names as one source (rule 61; core `people/names.ts`) against the real dev Stalwart (`npm run
 * test:int`): the mailbox's identities already exist under an old name (Stalwart doesn't rename them when the account
 * description changes); the webmail's next read names them from the control plane and renames them on the server with
 * the session's own token; its "Sender name" changes the person's name; an admin's custom display name wins and can't
 * be changed there. The control plane runs on the in-memory adapter; one throwaway `dev.test` mailbox per run.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { systemClock } from "@anhourmail/core";
import { setWebmailSenderName, webmailSenderName, webmailSendingNames } from "@anhourmail/core/people";
import { WebmailSettingsService, WebmailSignaturesService } from "@anhourmail/core/webmail";
import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";

import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailService } from "../webmail/service";
import { WebmailSettings } from "../webmail/settings";
import { stalwartOAuthPort } from "./stalwart-oauth";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const run = randomBytes(4).toString("hex");
const req = { requestId: `int-names-${run}`, ip: null, userAgent: "vitest" };
const local = `int-names-${run}`;
const address = `${local}@dev.test`;
const password = randomBytes(18).toString("base64url");
let stalwartId: string | null = null;

beforeAll(async () => {
  stalwartId = await stalwartDevAdmin().upsertUser({
    name: local,
    domain: "dev.test",
    password: await hashPassword(password),
    quotaBytes: 50 * 1024 * 1024,
    suspended: false,
    description: "Old Name",
  });
});
afterAll(async () => {
  if (stalwartId) await stalwartDevAdmin().destroy("x:Account", stalwartId);
});

/** The identities as the mail server has them, read with a mailbox's own password (what other apps see). */
async function serverIdentities(login = address, secret = password): Promise<{ name: string; email: string }[]> {
  const basic = `Basic ${Buffer.from(`${login}:${secret}`).toString("base64")}`;
  const session = await fetch(`${STALWART_URL}/jmap/session`, { headers: { Authorization: basic } });
  const { primaryAccounts } = (await session.json()) as { primaryAccounts: Record<string, string> };
  const res = await fetch(`${STALWART_URL}/jmap`, {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:submission"],
      methodCalls: [
        ["Identity/get", { accountId: primaryAccounts["urn:ietf:params:jmap:submission"], ids: null }, "i"],
      ],
    }),
  });
  const body = (await res.json()) as { methodResponses: [string, { list?: { name: string; email: string }[] }][] };
  return body.methodResponses[0]?.[1].list ?? [];
}

/** The identity names as the mail server has them for the run's mailbox. */
async function serverNames(): Promise<string[]> {
  return (await serverIdentities()).map((i) => i.name);
}

describe("webmail sender names on the dev Stalwart", () => {
  it("renames existing identities from the control plane, edits the person's name, and keeps an admin's name", async () => {
    // Opened once under the old description: the identity exists with that name.
    expect(await serverNames()).toEqual(["Old Name"]);

    const uow = new MemoryUnitOfWork();
    const deps = { uow, clock: systemClock, platform: PUBLIC_PLATFORM };
    const accountId = randomUUID();
    const mailboxId = randomUUID();
    uow.state.accounts.push({ id: accountId, name: "Names", plan: "plus" });
    uow.state.userEmails.ada = "ada@console.test";
    uow.state.userNames.ada = "Ada Lovelace";
    uow.state.memberships.push({ userId: "ada", accountId, role: "member" });
    uow.state.mailboxes.push({
      id: mailboxId,
      accountId,
      userId: "ada",
      address,
      status: "active",
      quotaBytes: 1,
      stalwartId,
      lastError: null,
      purgeAfter: null,
      createdAt: new Date(),
    });

    const svc = new WebmailService({
      store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
      oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
      stalwartUrl: STALWART_URL,
      access: { state: async () => "ok" as const },
      quota: memorySlidingQuota(),
      sieve: { read: async () => null, write: async () => true },
      confirmedForward: async () => null,
      defer: () => undefined,
      senderName: (a) => webmailSendingNames(deps, a),
    });
    const { sessionId } = await svc.signIn(address, password);
    expect((await svc.identities(sessionId)).map((i) => i.name)).toEqual(["Ada Lovelace"]);
    expect(await serverNames()).toEqual(["Ada Lovelace"]);

    const settings = new WebmailSettings({
      mail: svc,
      settings: new WebmailSettingsService(deps),
      signatures: new WebmailSignaturesService(deps),
      senderNames: {
        get: (a) => webmailSenderName(deps, a),
        set: (a, input, r) => setWebmailSenderName(deps, a, input, r),
      },
      mailer: { send: async () => undefined },
      messageSender: async () => null,
      webmailUrl: WEBMAIL_URL,
      siteHost: PUBLIC_PLATFORM.hosts.site,
    });
    const account = (await svc.session(sessionId))?.accountId ?? "";
    const out = await settings.updateSenderName(sessionId, account, { name: "Ada King" }, req);
    expect(out.sender).toMatchObject({ name: "Ada King", source: "person", editable: true });
    expect(uow.state.userNames.ada).toBe("Ada King");
    expect(await serverNames()).toEqual(["Ada King"]);
    // The worker is asked to write the new description too.
    expect(uow.state.jobs.at(-1)).toMatchObject({ kind: "mailbox.ensure", subjectId: mailboxId });

    // An admin's custom display name: the identities follow it on the next read; the webmail can't change it.
    const row = uow.state.mailboxes.find((m) => m.id === mailboxId);
    if (row) row.displayName = "Front desk";
    expect((await svc.identities(sessionId)).map((i) => i.name)).toEqual(["Front desk"]);
    expect(await serverNames()).toEqual(["Front desk"]);
    await expect(settings.updateSenderName(sessionId, account, { name: "Nope" }, req)).rejects.toThrow(/admin/);
    expect(uow.state.userNames.ada).toBe("Ada King");
    // No name at all (a mailbox without a person or a display name): the identities are cleared, not left stale.
    if (row) {
      row.displayName = null;
      row.userId = null;
    }
    expect((await svc.identities(sessionId)).map((i) => i.name)).toEqual([""]);
    expect(await serverNames()).toEqual([""]);
  });
  it("names a masked alias with no name on the server, and a plain alias with the sender name", async () => {
    const own = `int-names-masked-${run}`;
    const ownAddress = `${own}@dev.test`;
    const secret = randomBytes(18).toString("base64url");
    const maskedLocal = `m${randomBytes(6).toString("hex")}`;
    const id = await stalwartDevAdmin().upsertUser({
      name: own,
      domain: "dev.test",
      password: await hashPassword(secret),
      quotaBytes: 50 * 1024 * 1024,
      suspended: false,
      description: "Old Name",
      aliases: [
        { name: maskedLocal, domain: "dev.test", enabled: true },
        { name: `${own}-hi`, domain: "dev.test", enabled: true },
      ],
    });
    try {
      const uow = new MemoryUnitOfWork();
      const deps = { uow, clock: systemClock, platform: PUBLIC_PLATFORM };
      const accountId = randomUUID();
      const mailboxId = randomUUID();
      uow.state.accounts.push({ id: accountId, name: "Names", plan: "plus" });
      uow.state.userEmails.ada = "ada@console.test";
      uow.state.userNames.ada = "Ada Lovelace";
      uow.state.memberships.push({ userId: "ada", accountId, role: "member" });
      uow.state.mailboxes.push({
        id: mailboxId,
        accountId,
        userId: "ada",
        address: ownAddress,
        status: "active",
        quotaBytes: 1,
        stalwartId: id,
        lastError: null,
        purgeAfter: null,
        createdAt: new Date(),
      });
      for (const [aliasAddress, kind] of [
        [`${maskedLocal}@dev.test`, "masked"],
        [`${own}-hi@dev.test`, "alias"],
      ] as const) {
        uow.state.aliases.push({
          id: randomUUID(),
          accountId,
          mailboxId,
          address: aliasAddress,
          kind,
          enabled: true,
          adminLocked: false,
          description: null,
          createdAt: new Date(),
        });
      }
      const svc = new WebmailService({
        store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
        oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL }),
        stalwartUrl: STALWART_URL,
        access: { state: async () => "ok" as const },
        quota: memorySlidingQuota(),
        sieve: { read: async () => null, write: async () => true },
        confirmedForward: async () => null,
        defer: () => undefined,
        senderName: (a) => webmailSendingNames(deps, a),
      });
      const { sessionId } = await svc.signIn(ownAddress, secret);
      const byEmail = (list: { name: string; email: string }[]) =>
        Object.fromEntries(list.map((i) => [i.email.toLowerCase(), i.name]));
      const want = {
        [ownAddress]: "Ada Lovelace",
        [`${maskedLocal}@dev.test`]: "",
        [`${own}-hi@dev.test`]: "Ada Lovelace",
      };
      expect(byEmail(await svc.identities(sessionId))).toEqual(want);
      expect(byEmail(await serverIdentities(ownAddress, secret))).toEqual(want);
    } finally {
      await stalwartDevAdmin().destroy("x:Account", id);
    }
  });
});
