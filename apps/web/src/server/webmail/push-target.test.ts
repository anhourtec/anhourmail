// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";

import { PinnedMailboxMissingError, withPinnedMailbox } from "./pin";
import { type PushEvent, PushHub } from "./push-hub";
import { pushTargetFrom } from "./push-target";
import {
  WebmailBlockedError,
  WebmailDelegationRefusedError,
  WebmailOwnMailboxOnlyError,
  WebmailService,
  WebmailSignedOutError,
  WebmailUnavailableError,
} from "./service";
import { memoryKv, type MailboxTokens, type WebmailSession, WebmailSessionStore } from "./session-store";
import { fixedTrust } from "./__tests__/trust";

const entry = (username: string, accountId: string): MailboxTokens => ({
  username,
  accountId,
  accessToken: `at-${username}`,
  refreshToken: "rt",
  expiresAt: Date.now() + 3_600_000,
});

function setup() {
  const store = new WebmailSessionStore(memoryKv(), createKeyRing([{ id: "k", key: randomBytes(32) }]));
  const svc = new WebmailService({
    store,
    oauth: {
      signIn: () => Promise.reject(new Error("unused")),
      refresh: () => Promise.reject(new Error("unused")),
    },
    stalwartUrl: "http://stalwart:8080",
    access: { state: async () => "ok" as const },
    quota: memorySlidingQuota(),
    trust: fixedTrust(),
    sieve: { read: async () => null, write: async () => true },
    confirmedForward: async () => null,
  });
  return { store, svc };
}

const until = async (cond: () => boolean) => {
  const end = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("pushTargetFrom", () => {
  it("reads the session unpinned, whatever pin the caller runs under", async () => {
    const { store, svc } = setup();
    const s: WebmailSession = { ...entry("a@x.test", "A"), createdAt: Date.now(), others: [entry("b@x.test", "B")] };
    const id = await store.create(s);
    const target = pushTargetFrom(() => svc);
    const r = await withPinnedMailbox("b@x.test", () => target(id, { connect: false }), "own");
    expect(r).toMatchObject({ kind: "ok", target: { username: "a@x.test", accountId: "A" } });
  });

  it("maps the BFF's errors to the hub's outcomes", async () => {
    const cases: [Error, string][] = [
      [new WebmailSignedOutError("x"), "signedout"],
      [new WebmailBlockedError("x"), "signedout"],
      [new WebmailOwnMailboxOnlyError("x"), "moved"],
      [new WebmailDelegationRefusedError("x"), "moved"],
      [new PinnedMailboxMissingError("x"), "moved"],
      [new WebmailUnavailableError("x"), "unavailable"],
      [new Error("redis"), "unavailable"],
    ];
    for (const [err, kind] of cases) {
      const target = pushTargetFrom(() => ({ pushTarget: () => Promise.reject(err) }));
      expect(await target("s", { connect: true })).toEqual({ kind });
    }
    expect(await pushTargetFrom(() => ({ pushTarget: async () => null }))("s", { connect: false })).toEqual({
      kind: "signedout",
    });
  });

  it("a channel opened under an own pin ends at the next check once that mailbox leaves the session", async () => {
    const { store, svc } = setup();
    const b = entry("b@x.test", "B");
    const id = await store.create({ ...entry("a@x.test", "A"), createdAt: Date.now(), others: [b] });
    const hub = new PushHub({
      target: pushTargetFrom(() => svc),
      connect: () => ({ close: () => undefined, open: true }),
      // Real timers: they keep the async context they were created in (the pinned request).
      limits: { checkMs: 20 },
    });
    const events: PushEvent[] = [];
    // As if a request pinned to b@ had opened it (the route refuses that now; the hub mustn't rely on it).
    withPinnedMailbox(
      "b@x.test",
      () => hub.subscribe(id, { ...b, accessToken: b.accessToken }, (e) => events.push(e)),
      "own",
    );
    const s = await store.read(id);
    if (!s) throw new Error("no session");
    await store.write(id, { ...s, others: [] });
    await until(() => events.length > 0);
    expect(events).toEqual([{ type: "end", reason: "moved" }]);
    expect(hub.stats().channels).toBe(0);
    hub.closeAll();
  });
});
