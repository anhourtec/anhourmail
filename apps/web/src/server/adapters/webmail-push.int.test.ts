// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webmail push against the real dev Stalwart (`npm run test:int`, 05-webmail.md "Push"): the upstream JMAP WebSocket
 * opened with a webmail session's token, `StateChange`s for the push types only, the hub fanning them out, and a
 * password change: Stalwart keeps the open socket, and the next reopen with a fresh token ends the session's streams.
 * Uses a throwaway `dev.test` mailbox, removed afterwards.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "@anhourmail/adapters/auth";
import { openPushChannel, type StateChange } from "@anhourmail/jmap-client/push";
import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { stalwartDevAdmin } from "@anhourmail/stalwart-client";

import { type PushEvent, PushHub, type PushTargetResult } from "../webmail/push-hub";
import { memoryKv, WebmailSessionStore } from "../webmail/session-store";
import { WebmailService } from "../webmail/service";
import { stalwartOAuthPort } from "./stalwart-oauth";
import { fixedTrust } from "../webmail/__tests__/trust";

const STALWART_URL = process.env.STALWART_URL ?? "http://127.0.0.1:43080";
const WEBMAIL_URL = process.env.WEBMAIL_URL ?? "http://localhost:43300";
const NAME = `int-push-${randomBytes(4).toString("hex")}`;
const ADDRESS = `${NAME}@dev.test`;
const PASSWORD = randomBytes(18).toString("base64url");
let accountId: string | null = null;

beforeAll(async () => {
  accountId = await stalwartDevAdmin().upsertUser({
    name: NAME,
    domain: "dev.test",
    password: await hashPassword(PASSWORD),
    quotaBytes: 10 * 1024 * 1024,
  });
});
afterAll(async () => {
  if (accountId) await stalwartDevAdmin().destroy("x:Account", accountId);
});

function service(refreshSkewMs?: number) {
  return new WebmailService({
    store: new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "t", key: randomBytes(32) }])),
    oauth: stalwartOAuthPort({ stalwartUrl: STALWART_URL, webmailUrl: WEBMAIL_URL, fallbackIp: "127.0.0.1" }),
    stalwartUrl: STALWART_URL,
    access: { state: async () => "ok" as const },
    quota: memorySlidingQuota(),
    trust: fixedTrust(),
    sieve: { read: async () => null, write: async () => true },
    confirmedForward: async () => null,
    defer: () => undefined,
    ...(refreshSkewMs === undefined ? {} : { refreshSkewMs }),
  });
}

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
type Responses = { methodResponses: [string, Record<string, unknown>, string][] };

/** A change in the mailbox: a draft saved and deleted again (Email and Mailbox states both move). */
async function touchMail(svc: WebmailService, sessionId: string, mailAccount: string) {
  const call = async (methodCalls: [string, Record<string, unknown>, string][]) =>
    ((await svc.jmap(sessionId, { using: USING, methodCalls })).body as Responses).methodResponses;
  const boxes = await call([["Mailbox/get", { accountId: mailAccount, properties: ["role"] }, "m"]]);
  const list = (boxes[0]?.[1].list ?? []) as { id: string; role: string | null }[];
  const drafts = list.find((m) => m.role === "drafts")?.id;
  if (!drafts) throw new Error("no Drafts folder");
  const made = await call([
    [
      "Email/set",
      {
        accountId: mailAccount,
        create: { d: { mailboxIds: { [drafts]: true }, keywords: { $draft: true }, subject: "push" } },
      },
      "c",
    ],
  ]);
  const id = (made[0]?.[1].created as Record<string, { id: string }> | undefined)?.d?.id;
  if (id) await call([["Email/set", { accountId: mailAccount, destroy: [id] }, "x"]]);
}

describe("webmail push on the dev Stalwart", () => {
  it("opens the JMAP WebSocket with the session's token and hears state changes for the push types", async () => {
    const svc = service();
    const { sessionId } = await svc.signIn(ADDRESS, PASSWORD);
    const target = await svc.pushTarget(sessionId, { connect: true });
    if (!target) throw new Error("no target");
    const changes: StateChange[] = [];
    let opened = false;
    let closed = false;
    const ch = openPushChannel({
      url: svc.pushUrl,
      authorization: `Bearer ${target.accessToken}`,
      dataTypes: ["Email", "Mailbox"],
      onOpen: () => {
        opened = true;
      },
      onStateChange: (c) => changes.push(c),
      onClose: () => {
        closed = true;
      },
    });
    try {
      await until(() => opened);
      await touchMail(svc, sessionId, target.accountId);
      await until(() => changes.some((c) => c[target.accountId]?.Mailbox !== undefined));
      // Only the asked-for types, only this account.
      for (const c of changes) {
        expect(Object.keys(c)).toEqual([target.accountId]);
        for (const type of Object.keys(c[target.accountId] ?? {})) expect(["Email", "Mailbox"]).toContain(type);
      }
      expect(closed).toBe(false);
    } finally {
      ch.close();
    }
  });

  it("a bad token never opens a channel", async () => {
    let result: { code: number; opened: boolean } | null = null;
    openPushChannel({
      url: service().pushUrl,
      authorization: "Bearer not-a-token",
      onStateChange: () => undefined,
      onClose: (info) => {
        result = info;
      },
    });
    await until(() => result !== null);
    expect(result).toMatchObject({ opened: false });
  });

  it("the hub fans changes out; after a password change the reopen ends the session's streams", async () => {
    // Every use refreshes (a 2-hour skew on 1-hour tokens): the reopen meets the revoked refresh token.
    const svc = service(2 * 3_600_000);
    const { sessionId } = await svc.signIn(ADDRESS, PASSWORD);
    const first = await svc.pushTarget(sessionId, { connect: false });
    if (!first) throw new Error("no target");
    const ctl: { reopen: (() => void) | null } = { reopen: null };
    const hub = new PushHub({
      target: async (id, opts): Promise<PushTargetResult> => {
        try {
          const t = await svc.pushTarget(id, opts);
          return t ? { kind: "ok", target: t } : { kind: "signedout" };
        } catch {
          return { kind: "unavailable" };
        }
      },
      connect: (t, handlers) => {
        const ch = openPushChannel({
          url: svc.pushUrl,
          authorization: `Bearer ${t.accessToken}`,
          dataTypes: ["Email", "Mailbox"],
          ...handlers,
        });
        // Stands in for the hourly reopen: drop the socket as if it ended.
        ctl.reopen = () => {
          ch.close();
          handlers.onClose({ code: 1006, opened: true });
        };
        return ch;
      },
    });
    const events: PushEvent[] = [];
    const sub = hub.subscribe(sessionId, first, (e) => events.push(e));
    expect(sub).not.toBeNull();
    try {
      await until(() => events.some((e) => e.type === "ready"));
      await touchMail(svc, sessionId, first.accountId);
      await until(() => events.some((e) => e.type === "state" && e.changed.Mailbox !== undefined));

      // Password changed (by an admin, say): every OAuth token of the account stops, but the open socket stays.
      if (!accountId) throw new Error("no account");
      await stalwartDevAdmin().replacePassword(accountId, await hashPassword(randomBytes(18).toString("base64url")));
      await new Promise((r) => setTimeout(r, 1_000));
      expect(hub.stats().up).toBe(1);
      // The reopen needs a fresh token: the refresh is refused, the session ends, and so do its streams.
      ctl.reopen?.();
      await until(() => events.some((e) => e.type === "end"));
      expect(events.at(-1)).toEqual({ type: "end", reason: "signedout" });
      expect(await svc.session(sessionId)).toBeNull();
      expect(hub.stats()).toEqual({ channels: 0, streams: 0, up: 0 });
    } finally {
      sub?.unsubscribe();
      hub.closeAll();
    }
  });
});
