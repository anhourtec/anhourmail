// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WebmailAccess } from "@anhourmail/core/webmail";
import { createKeyRing } from "@anhourmail/server/keyring";
import { memorySlidingQuota } from "@anhourmail/server/rate-limit";
import { setLogSinkForTests } from "@anhourmail/server/log";

import { ALLOWED_METHODS, checkJmapRequest, isLimitError, MAX_CALLS } from "./jmap-policy";
import { QueueFullError, UserQueue, withLimitRetry } from "./queue";
import { sanitizeMessageHtml } from "./sanitize";
import {
  GrantRefusedError,
  type OAuthPort,
  WebmailBlockedError,
  WebmailBusyError,
  WebmailService,
  WebmailSignedOutError,
  WebmailSignInError,
  WebmailUnavailableError,
} from "./service";
import { isSessionId, memoryKv, type WebmailSession, WebmailSessionStore } from "./session-store";
import { buildMessageView, isJmapId, type JmapEmail, safeFilename } from "./view";

const ring = () => createKeyRing([{ id: "k1", key: randomBytes(32) }]);
const MAIL = "urn:ietf:params:jmap:mail";
const CORE = "urn:ietf:params:jmap:core";

beforeEach(() => {
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setLogSinkForTests(null);
});

const session = (over: Partial<WebmailSession> = {}): WebmailSession => ({
  username: "a@x.test",
  accountId: "acc1",
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: 10_000_000,
  createdAt: 0,
  ...over,
});

describe("WebmailSessionStore", () => {
  it("keeps tokens sealed in the store and only a hash of the id as the key", async () => {
    const kv = memoryKv(() => 0);
    const store = new WebmailSessionStore(kv, ring(), { now: () => 0 });
    const id = await store.create(session());
    expect(isSessionId(id)).toBe(true);
    const [key = "", value = ""] = [...kv.raw()][0] ?? [];
    expect(key.startsWith("am:wm:s:")).toBe(true);
    expect(key).not.toContain(id);
    expect(value).not.toContain("at-1");
    expect(value).not.toContain("rt-1");
    expect(await store.read(id)).toEqual({ ...session(), version: 1 });
    expect(store.cookieMaxAgeSec).toBe(30 * 86_400);
  });

  it("refuses unknown, malformed, tampered and too-old sessions", async () => {
    let now = 0;
    const kv = memoryKv(() => now);
    const store = new WebmailSessionStore(kv, ring(), { now: () => now, maxAgeMs: 1000, idleTtlSec: 3600 });
    const id = await store.create(session());
    expect(await store.read("nope")).toBeNull();
    expect(await store.read("A".repeat(43))).toBeNull();
    // Another key ring can't read it (and the record is dropped).
    const other = new WebmailSessionStore(kv, ring(), { now: () => now });
    expect(await other.read(id)).toBeNull();
    expect(kv.size()).toBe(0);
    const id2 = await store.create(session());
    now = 1000;
    expect(await store.read(id2)).toBeNull();
    // Past its absolute lifetime, a write deletes instead.
    expect(await store.write(id2, session())).toBe(false);
    expect(kv.size()).toBe(0);
    await store.destroy("bad");
  });

  it("expires idle sessions and destroys on sign-out", async () => {
    let now = 0;
    const kv = memoryKv(() => now);
    const store = new WebmailSessionStore(kv, ring(), { now: () => now, idleTtlSec: 10 });
    const id = await store.create(session());
    now = 9_000;
    expect(await store.read(id)).not.toBeNull();
    now = 10_001;
    expect(await store.read(id)).toBeNull();
    const id2 = await store.create(session({ createdAt: now }));
    await store.destroy(id2);
    expect(await store.read(id2)).toBeNull();
  });
});

describe("JMAP allow-list", () => {
  const ok = (calls: unknown[], using: unknown = [CORE, MAIL]) =>
    checkJmapRequest({ using, methodCalls: calls }, "acc1");

  it("accepts the webmail's methods for the signed-in account", () => {
    const r = ok([
      ["Mailbox/get", { accountId: "acc1" }, "m"],
      ["Email/query", { accountId: "acc1", filter: {} }, "q"],
    ]);
    expect(r.ok).toBe(true);
    expect(ALLOWED_METHODS.has("Email/set")).toBe(true);
  });

  it("refuses admin methods, other capabilities, other accounts and malformed requests", () => {
    expect(ok([["x:Account/get", { accountId: "acc1" }, "a"]])).toEqual({
      ok: false,
      message: "Method not available: x:Account/get",
    });
    expect(ok([["EmailSubmission/set", { accountId: "acc1" }, "a"]]).ok).toBe(false);
    expect(ok([["Mailbox/get", { accountId: "acc1" }, "a"]], [CORE, "urn:stalwart:jmap"]).ok).toBe(false);
    expect(ok([["Mailbox/get", { accountId: "acc2" }, "a"]])).toEqual({ ok: false, message: "Unknown account." });
    expect(ok([["Mailbox/get", {}, "a"]]).ok).toBe(false);
    expect(ok([["Mailbox/get", { accountId: "acc1" }]]).ok).toBe(false);
    expect(ok([["Mailbox/get", { accountId: "acc1" }, "x".repeat(65)]]).ok).toBe(false);
    expect(ok([]).ok).toBe(false);
    expect(ok([["Mailbox/get", { accountId: "acc1" }, "a"]], []).ok).toBe(false);
    expect(ok([["Mailbox/get", { accountId: "acc1" }, "a"]], "core").ok).toBe(false);
    expect(checkJmapRequest(null, "acc1").ok).toBe(false);
    expect(checkJmapRequest([], "acc1").ok).toBe(false);
    const many = Array.from({ length: MAX_CALLS + 1 }, (_, i) => [
      "Mailbox/get",
      { accountId: "acc1" },
      `c${String(i)}`,
    ]);
    expect(ok(many).ok).toBe(false);
  });

  it("refuses contacts through the generic proxy (they go through the dedicated contacts endpoints)", () => {
    const CONTACTS = "urn:ietf:params:jmap:contacts";
    expect(ok([["AddressBook/get", { accountId: "acc1" }, "a"]], [CORE, CONTACTS]).ok).toBe(false);
    for (const m of ["AddressBook/get", "AddressBook/set", "ContactCard/get", "ContactCard/query", "ContactCard/set"]) {
      expect(ok([[m, { accountId: "acc1" }, "a"]])).toEqual({ ok: false, message: `Method not available: ${m}` });
    }
  });

  it("lets Email/set change keywords and folders, and destroy (checked later), but never create", () => {
    const set = (args: Record<string, unknown>) =>
      checkJmapRequest(
        { using: [CORE, MAIL], methodCalls: [["Email/set", { accountId: "acc1", ...args }, "s"]] },
        "acc1",
      );
    const allowed = (args: Record<string, unknown>) => set(args).ok;
    // Keywords: read, flag, pin, junk.
    expect(
      allowed({ update: { e1: { "keywords/$seen": true, "keywords/$flagged": null, "keywords/$pinned": true } } }),
    ).toBe(true);
    // Moves: archive, trash, junk, any folder.
    expect(allowed({ update: { e1: { "mailboxIds/in": null, "mailboxIds/arch": true } } })).toBe(true);
    expect(allowed({ update: { e1: { mailboxIds: { trash: true } } }, ifInState: "s1" })).toBe(true);
    // Destroy is allowed here; the service checks the ids are in Trash or Junk.
    const d = set({ destroy: ["e1", "e2"] });
    expect(d.ok && d.destroyIds).toEqual(["e1", "e2"]);
    // Refusals.
    for (const bad of [
      { create: { x: { mailboxIds: { a: true } } } },
      { update: { e1: { "keywords/$seen": true } }, create: {} },
      { update: { e1: { subject: "x" } } },
      { update: { e1: { "bodyValues/1": { value: "x" } } } },
      { update: { e1: { keywords: { $seen: true } } } },
      { update: { e1: { "keywords/$seen": "yes" } } },
      { update: { e1: { "mailboxIds/a b": true } } },
      { update: { e1: { mailboxIds: {} } } },
      { update: { e1: { mailboxIds: { trash: false } } } },
      { update: { e1: {} } },
      { update: {} },
      { update: { "bad id": { "keywords/$seen": true } } },
      { update: [] },
      { destroy: [] },
      { destroy: ["ok", "../x"] },
      { destroy: "e1" },
      { destroy: Array.from({ length: 501 }, (_, i) => `e${String(i)}`) },
      { "#update": { resultOf: "q", name: "Email/query", path: "/ids" } },
      { "#destroy": { resultOf: "q", name: "Email/query", path: "/ids" } },
      {},
    ]) {
      expect(allowed(bad)).toBe(false);
    }
  });

  it("never lets the proxy turn a message into a draft or touch the BFF's draft marker", () => {
    const set = (update: Record<string, unknown>) =>
      checkJmapRequest(
        { using: [CORE, MAIL], methodCalls: [["Email/set", { accountId: "acc1", update: { e1: update } }, "s"]] },
        "acc1",
        { draftsId: "dr" },
      ).ok;
    expect(set({ "keywords/$draft": true })).toBe(false);
    expect(set({ "keywords/$am-composed": true })).toBe(false);
    expect(set({ "keywords/$am-composed": null })).toBe(false);
    expect(set({ "mailboxIds/dr": true })).toBe(false);
    expect(set({ mailboxIds: { dr: true } })).toBe(false);
    expect(set({ mailboxIds: { in: true, dr: true } })).toBe(false);
    // Taking things out of Drafts or clearing $draft is fine (discard, undo of a move).
    expect(set({ "mailboxIds/dr": null, "mailboxIds/tr": true })).toBe(true);
    expect(set({ "keywords/$draft": null })).toBe(true);
    // Without knowing the Drafts id, $draft and the marker are still refused.
    expect(
      checkJmapRequest(
        {
          using: [CORE, MAIL],
          methodCalls: [["Email/set", { accountId: "acc1", update: { e1: { "keywords/$draft": true } } }, "s"]],
        },
        "acc1",
      ).ok,
    ).toBe(false);
  });

  it("never lets the proxy send mail, upload or manage identities", () => {
    for (const name of [
      "EmailSubmission/set",
      "EmailSubmission/get",
      "Identity/set",
      "Mailbox/set",
      "Email/import",
      "Email/copy",
    ]) {
      expect(ok([[name, { accountId: "acc1" }, "x"]]).ok).toBe(false);
    }
    expect(ok([["Identity/get", { accountId: "acc1" }, "x"]], [CORE, "urn:ietf:params:jmap:submission"]).ok).toBe(
      false,
    );
  });

  it("recognises Stalwart's concurrency limit error", () => {
    expect(isLimitError(400, { type: "urn:ietf:params:jmap:error:limit", limit: "maxConcurrentRequests" })).toBe(true);
    expect(isLimitError(400, { type: "urn:ietf:params:jmap:error:notRequest" })).toBe(false);
    expect(isLimitError(200, null)).toBe(false);
  });
});

describe("UserQueue", () => {
  it("runs at most 4 requests per user at once and queues the rest in order", async () => {
    const q = new UserQueue(4, 64);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) =>
      q.run("u", async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        order.push(i);
        active -= 1;
        return i;
      }),
    );
    // Another user is never blocked by the first.
    expect(await q.run("other", async () => "free")).toBe("free");
    await Promise.resolve();
    expect(q.stats("u")).toEqual({ active: 4, waiting: 6 });
    while (releases.length > 0 || order.length < 10) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(4);
    expect(q.stats("u")).toEqual({ active: 0, waiting: 0 });
  });

  it("refuses when the backlog is full, and frees the slot when a task throws", async () => {
    const q = new UserQueue(1, 1);
    let release: () => void = () => undefined;
    const first = q.run("u", () => new Promise<void>((r) => (release = r)));
    const second = q.run("u", async () => "second");
    await expect(q.run("u", async () => "third")).rejects.toBeInstanceOf(QueueFullError);
    release();
    await first;
    expect(await second).toBe("second");
    await expect(q.run("u", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await q.run("u", async () => "after")).toBe("after");
  });

  it("retries limit errors with backoff and gives up after the last try", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    let n = 0;
    const value = await withLimitRetry(
      async () => (++n < 3 ? { retry: true as const } : { retry: false as const, value: "done" }),
      { sleep, random: () => 0.5, baseMs: 100 },
    );
    expect(value).toBe("done");
    expect(waits).toEqual([100, 200]);
    expect(await withLimitRetry(async () => ({ retry: true as const }), { sleep, tries: 2 })).toBeNull();
  });
});

describe("message view", () => {
  const email = (over: Partial<JmapEmail> = {}): JmapEmail => ({
    id: "e1",
    threadId: "t1",
    mailboxIds: { in: true },
    keywords: {},
    from: [{ name: "A", email: "a@x.test" }],
    to: null,
    cc: null,
    replyTo: null,
    subject: null,
    sentAt: null,
    receivedAt: "2026-10-22T00:00:00Z",
    htmlBody: [{ partId: "1", blobId: "b1", size: 10, name: null, type: "text/html", disposition: null, cid: null }],
    textBody: [{ partId: "2", blobId: "b2", size: 10, name: null, type: "text/plain", disposition: null, cid: null }],
    attachments: [
      {
        partId: "3",
        blobId: "b3",
        size: 99,
        name: "a.pdf",
        type: "application/pdf",
        disposition: "attachment",
        cid: null,
      },
      { partId: "4", blobId: "b4", size: 9, name: "logo.png", type: "image/png", disposition: "inline", cid: "<logo>" },
    ],
    bodyValues: {
      "1": { value: '<p>Hi</p><img src="https://t.example/a.png" width="10" height="10"><img src="cid:logo">' },
      "2": { value: "Hi", isTruncated: true },
    },
    ...over,
  });

  it("sanitises HTML, lists real attachments and hides inline cid images", () => {
    const v = buildMessageView(email(), (h) =>
      sanitizeMessageHtml(h, new Map([["logo", "data:image/png;base64,AAAA"]])),
    );
    expect(v.html).toContain("<p>Hi</p>");
    expect(v.html).toContain('src="data:image/png;base64,AAAA"');
    expect(v.text).toBeNull();
    expect(v.blockedImages).toBe(1);
    expect(v.truncated).toBe(true);
    expect(v.attachments).toEqual([{ blobId: "b3", name: "a.pdf", type: "application/pdf", size: 99, kind: "file" }]);
    const spoof = buildMessageView(
      email({
        attachments: [
          {
            partId: "3",
            blobId: "b3",
            size: 1,
            name: "cv\u202Efdp.exe",
            type: "x",
            disposition: "attachment",
            cid: null,
          },
        ],
      }),
      sanitizeMessageHtml,
    );
    expect(spoof.attachments[0]?.name).toBe("cv_fdp.exe");
    expect(v.subject).toBe("");
    expect(v.to).toEqual([]);
  });

  it("falls back to the text body", () => {
    const v = buildMessageView(email({ htmlBody: null, attachments: null }), sanitizeMessageHtml);
    expect(v.html).toBeNull();
    expect(v.text).toBe("Hi");
    expect(v.attachments).toEqual([]);
  });

  it("makes download names safe and checks JMAP ids", () => {
    expect(safeFilename('../../etc/pa"ss\u0001wd')).toBe("_.._etc_pa_ss_wd");
    expect(safeFilename("...")).toBe("attachment");
    expect(safeFilename("invoice\u202Efdp.exe")).toBe("invoice_fdp.exe");
    expect(safeFilename("a\u200Bb\u2028c\u2029d\u2066e")).toBe("a_b_c_d_e");
    expect(isJmapId("Ab_-9")).toBe(true);
    expect(isJmapId("a/b")).toBe(false);
    expect(isJmapId("")).toBe(false);
  });
});

// ---- the BFF service --------------------------------------------------------------------------------------

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(
  opts: {
    upstream?: Upstream;
    allowed?: (a: string) => boolean;
    state?: (a: string) => WebmailAccess;
    oauth?: Partial<OAuthPort>;
  } = {},
) {
  let now = 1_000_000;
  const kv = memoryKv(() => now);
  const store = new WebmailSessionStore(kv, ring(), { now: () => now });
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const upstream: Upstream =
    opts.upstream ??
    ((url) =>
      url.endsWith("/jmap/session")
        ? Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } })
        : Response.json({ methodResponses: [["Mailbox/get", { list: [] }, "m"]] }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return upstream(url, init ?? {});
  }) as typeof fetch;
  let refreshes = 0;
  const oauth: OAuthPort = {
    signIn: async (name, secret) => {
      if (secret !== "right") throw new GrantRefusedError("no");
      return { accessToken: `at-${name}`, refreshToken: "rt", expiresAt: now + 3_600_000 };
    },
    refresh: async () => {
      refreshes += 1;
      return { accessToken: `at-r${String(refreshes)}`, refreshToken: "rt2", expiresAt: now + 3_600_000 };
    },
    ...opts.oauth,
  };
  const allowed = opts.allowed ?? (() => true);
  const svc = new WebmailService({
    store,
    oauth,
    stalwartUrl: "http://stalwart:8080/",
    access: { state: async (a) => opts.state?.(a) ?? (allowed(a) ? "ok" : "suspended") },
    quota: memorySlidingQuota(),
    sieve: { read: async () => null, write: async () => undefined },
    confirmedForward: async () => null,
    fetch: fetchImpl,
    now: () => now,
    sleep: async () => undefined,
  });
  return {
    svc,
    store,
    kv,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    refreshes: () => refreshes,
  };
}

const body = {
  using: [CORE, MAIL],
  methodCalls: [["Mailbox/get", { accountId: "acc1" }, "m"]] as [string, Record<string, unknown>, string][],
};

describe("WebmailService", () => {
  it("signs in once with the password, stores tokens server-side and proxies with the bearer token", async () => {
    const t = setup();
    const { sessionId, session: s } = await t.svc.signIn("a@x.test", "right");
    expect(s).toMatchObject({ username: "a@x.test", accountId: "acc1" });
    expect(t.calls[0]).toMatchObject({ url: "http://stalwart:8080/jmap/session", auth: "Bearer at-a@x.test" });
    const res = await t.svc.jmap(sessionId, body);
    expect(res.status).toBe(200);
    expect(t.calls[1]).toMatchObject({ url: "http://stalwart:8080/jmap/", auth: "Bearer at-a@x.test" });
    expect(JSON.parse(t.calls[1]?.body ?? "{}")).toEqual(body);
    // The password never reaches storage.
    expect([...t.kv.raw().values()].join("")).not.toContain("right");
  });

  it("gives the same refusal for a wrong password, and maps outages", async () => {
    const t = setup();
    await expect(t.svc.signIn("a@x.test", "wrong")).rejects.toBeInstanceOf(WebmailSignInError);
    const down = setup({ oauth: { signIn: () => Promise.reject(new Error("ECONNREFUSED")) } });
    await expect(down.svc.signIn("a@x.test", "right")).rejects.toBeInstanceOf(WebmailUnavailableError);
    const noSession = setup({ upstream: () => new Response("", { status: 500 }) });
    await expect(noSession.svc.signIn("a@x.test", "right")).rejects.toBeInstanceOf(WebmailUnavailableError);
    const noAccount = setup({ upstream: () => Response.json({ username: "a@x.test", primaryAccounts: {} }) });
    await expect(noAccount.svc.signIn("a@x.test", "right")).rejects.toBeInstanceOf(WebmailUnavailableError);
    const unreachable = setup({ upstream: () => Promise.reject(new Error("down")) });
    await expect(unreachable.svc.signIn("a@x.test", "right")).rejects.toBeInstanceOf(WebmailUnavailableError);
  });

  it("checks a password with the mail server without keeping a session, and maps refusals and outages", async () => {
    const t = setup();
    await t.svc.checkPassword("a@x.test", "right");
    expect(t.kv.size()).toBe(0);
    await expect(t.svc.checkPassword("a@x.test", "wrong")).rejects.toBeInstanceOf(WebmailSignInError);
    const busy = setup({ oauth: { signIn: () => Promise.reject(new WebmailBusyError("throttled")) } });
    await expect(busy.svc.checkPassword("a@x.test", "right")).rejects.toBeInstanceOf(WebmailBusyError);
    const down = setup({ oauth: { signIn: () => Promise.reject(new Error("ECONNREFUSED")) } });
    await expect(down.svc.checkPassword("a@x.test", "right")).rejects.toBeInstanceOf(WebmailUnavailableError);
  });

  it("moves the session to a new id with fresh tokens after a password change, active mailbox or not", async () => {
    let n = 0;
    const t = setup({
      oauth: {
        signIn: async (name, secret) => {
          if (secret !== "right" && secret !== "new-one") throw new GrantRefusedError("no");
          n += 1;
          return { accessToken: `at-${name}-${String(n)}`, refreshToken: `rt-${String(n)}`, expiresAt: 9e12 };
        },
      },
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const renewed = await t.svc.renewMailbox(sessionId, "a@x.test", "new-one");
    expect(renewed).not.toBe(sessionId);
    expect(await t.store.read(sessionId)).toBeNull(); // the old id (and any copied cookie) no longer works
    expect(await t.svc.session(renewed)).toMatchObject({ username: "a@x.test", accessToken: "at-a@x.test-2" });
    // Not the active one: its entry among the others is renewed, the active one is left alone.
    const s = await t.store.read(renewed);
    if (!s) throw new Error("no session");
    await t.store.write(renewed, { ...s, username: "b@x.test", others: [{ ...s, accessToken: "old" }] });
    const again = await t.svc.renewMailbox(renewed, "a@x.test", "new-one");
    const after = await t.store.read(again);
    expect(after?.username).toBe("b@x.test");
    expect(after?.createdAt).toBe(s.createdAt); // the absolute lifetime doesn't restart
    expect(after?.others?.[0]).toMatchObject({ username: "a@x.test", accessToken: "at-a@x.test-3" });
    await expect(t.svc.renewMailbox(again, "a@x.test", "wrong")).rejects.toBeInstanceOf(WebmailSignInError);
    await expect(t.svc.renewMailbox(sessionId, "a@x.test", "new-one")).rejects.toBeInstanceOf(WebmailSignedOutError);
  });

  it("refuses a suspended or deleted mailbox at sign-in, even with the right password", async () => {
    const t = setup({ allowed: () => false });
    await expect(t.svc.signIn("a@x.test", "right")).rejects.toBeInstanceOf(WebmailBlockedError);
    expect(t.kv.size()).toBe(0);
  });

  it("refuses a mailbox whose person staff suspended, saying why, and reports reasons for refused sign-ins", async () => {
    let state: WebmailAccess = "person_suspended";
    const t = setup({ state: () => state });
    const err: unknown = await t.svc.signIn("a@x.test", "right").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebmailBlockedError);
    expect((err as WebmailBlockedError).reason).toBe("person_suspended");
    expect(t.kv.size()).toBe(0);
    expect(await t.svc.blockedReason("a@x.test")).toBe("person_suspended");
    state = "deleting";
    expect(await t.svc.blockedReason("a@x.test")).toBe("deleting");
    state = "ok";
    expect(await t.svc.blockedReason("a@x.test")).toBeNull();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    state = "person_suspended";
    const ended: unknown = await t.svc.jmap(sessionId, body).catch((e: unknown) => e);
    expect((ended as WebmailBlockedError).reason).toBe("person_suspended");
    expect(t.kv.size()).toBe(0);
  });

  it("ends a live session as soon as the mailbox is suspended, on every kind of use", async () => {
    let allowed = true;
    const t = setup({ allowed: () => allowed });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    allowed = false;
    await expect(t.svc.jmap(sessionId, body)).rejects.toBeInstanceOf(WebmailBlockedError);
    // Dropped: the session is gone even if the mailbox comes back.
    allowed = true;
    expect(await t.svc.session(sessionId)).toBeNull();
    await expect(t.svc.jmap(sessionId, body)).rejects.toBeInstanceOf(WebmailSignedOutError);

    allowed = true;
    const second = await t.svc.signIn("a@x.test", "right");
    allowed = false;
    await expect(t.svc.download(second.sessionId, "acc1", "b1", "x")).rejects.toBeInstanceOf(WebmailBlockedError);
    allowed = true;
    const third = await t.svc.signIn("a@x.test", "right");
    t.advance(3_600_000); // a refresh would be due
    allowed = false;
    await expect(t.svc.session(third.sessionId)).rejects.toBeInstanceOf(WebmailBlockedError);
    expect(t.refreshes()).toBe(0);
  });

  it("doesn't resurrect a session signed out while its refresh was in flight", async () => {
    let release: () => void = () => undefined;
    const t = setup({
      oauth: {
        refresh: () =>
          new Promise((resolve) => {
            release = () => {
              resolve({ accessToken: "late", refreshToken: "rt9", expiresAt: 99_999_999_999 });
            };
          }),
      },
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    t.advance(3_600_000);
    const pending = t.svc.session(sessionId);
    await new Promise((r) => setTimeout(r, 0));
    await t.svc.signOut(sessionId);
    release();
    expect(await pending).toBeNull();
    expect(t.kv.size()).toBe(0);
    expect(await t.svc.session(sessionId)).toBeNull();
  });

  it("reports Stalwart throttling at sign-in as busy, not as a wrong password", async () => {
    const t = setup({ oauth: { signIn: () => Promise.reject(new WebmailBusyError("throttled")) } });
    await expect(t.svc.signIn("a@x.test", "right")).rejects.toBeInstanceOf(WebmailBusyError);
  });

  it("ends the session when Stalwart refuses the token with 403 (suspended on the mail server)", async () => {
    const t = setup({
      upstream: (url) =>
        url.endsWith("/jmap/session")
          ? Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } })
          : new Response("", { status: 403 }),
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await expect(t.svc.jmap(sessionId, body)).rejects.toBeInstanceOf(WebmailBlockedError);
    expect(t.kv.size()).toBe(0);
  });

  it("refreshes an expiring token once for concurrent callers, and signs out on a revoked grant", async () => {
    const t = setup();
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    t.advance(3_600_000 - 30_000);
    const [a, b] = await Promise.all([t.svc.session(sessionId), t.svc.session(sessionId)]);
    expect(a?.accessToken).toBe("at-r1");
    expect(b?.accessToken).toBe("at-r1");
    expect(t.refreshes()).toBe(1);

    const revoked = setup({ oauth: { refresh: () => Promise.reject(new GrantRefusedError("revoked")) } });
    const s2 = await revoked.svc.signIn("a@x.test", "right");
    revoked.advance(3_600_000);
    expect(await revoked.svc.session(s2.sessionId)).toBeNull();
    expect(revoked.kv.size()).toBe(0);
  });

  it("keeps a still-valid token when refresh is unavailable, and fails once it has expired", async () => {
    const t = setup({ oauth: { refresh: () => Promise.reject(new Error("down")) } });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    t.advance(3_600_000 - 30_000);
    expect((await t.svc.session(sessionId))?.accessToken).toBe("at-a@x.test");
    t.advance(60_000);
    await expect(t.svc.session(sessionId)).rejects.toBeInstanceOf(WebmailUnavailableError);
    const noRefresh = setup({
      oauth: { signIn: async () => ({ accessToken: "a", refreshToken: null, expiresAt: 1_000_000 }) },
    });
    const s = await noRefresh.svc.signIn("a@x.test", "x");
    expect(await noRefresh.svc.session(s.sessionId)).toBeNull();
  });

  it("retries with a refreshed token on 401, then treats a second 401 as signed out", async () => {
    let first = true;
    const t = setup({
      upstream: (url, init) => {
        if (url.endsWith("/jmap/session"))
          return Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } });
        const auth = new Headers(init.headers).get("authorization");
        if (first && auth === "Bearer at-a@x.test") {
          first = false;
          return new Response("", { status: 401 });
        }
        return Response.json({ methodResponses: [] });
      },
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    expect((await t.svc.jmap(sessionId, body)).status).toBe(200);
    expect(t.refreshes()).toBe(1);

    const dead = setup({
      upstream: (url) =>
        url.endsWith("/jmap/session")
          ? Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } })
          : new Response("", { status: 401 }),
    });
    const s = await dead.svc.signIn("a@x.test", "right");
    await expect(dead.svc.jmap(s.sessionId, body)).rejects.toBeInstanceOf(WebmailSignedOutError);
    expect(dead.kv.size()).toBe(0);
    await expect(dead.svc.jmap("missing-session", body)).rejects.toBeInstanceOf(WebmailSignedOutError);
  });

  it("retries Stalwart's limit errors, reports busy when they persist, and maps 5xx", async () => {
    let limited = 2;
    const limit = () => Response.json({ type: "urn:ietf:params:jmap:error:limit" }, { status: 400 });
    const t = setup({
      upstream: (url) => {
        if (url.endsWith("/jmap/session"))
          return Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } });
        return limited-- > 0 ? limit() : Response.json({ methodResponses: [] });
      },
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    expect((await t.svc.jmap(sessionId, body)).status).toBe(200);
    limited = 99;
    await expect(t.svc.jmap(sessionId, body)).rejects.toBeInstanceOf(WebmailBusyError);

    const broken = setup({
      upstream: (url) =>
        url.endsWith("/jmap/session")
          ? Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } })
          : new Response("oops", { status: 502 }),
    });
    const s = await broken.svc.signIn("a@x.test", "right");
    await expect(broken.svc.jmap(s.sessionId, body)).rejects.toBeInstanceOf(WebmailUnavailableError);
    await expect(broken.svc.jmapAs(s.sessionId, () => body)).rejects.toBeInstanceOf(WebmailUnavailableError);
  });

  it("builds the sanitised message view with inline images, and 404s unknown ids", async () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const mail: JmapEmail = {
      id: "e1",
      threadId: "t1",
      mailboxIds: {},
      keywords: {},
      from: null,
      to: null,
      cc: null,
      replyTo: null,
      subject: "S",
      sentAt: null,
      receivedAt: "2026-10-22T00:00:00Z",
      htmlBody: [
        { partId: "1", blobId: "h", size: 1, name: null, type: "text/html", disposition: null, cid: null },
        { partId: "2", blobId: "img", size: 4, name: "l.png", type: "image/png", disposition: "inline", cid: "<l1>" },
      ],
      textBody: null,
      attachments: [
        { partId: "2", blobId: "img", size: 4, name: "l.png", type: "image/png", disposition: "inline", cid: "<l1>" },
        {
          partId: "3",
          blobId: "big",
          size: 9_999_999,
          name: "b.png",
          type: "image/png",
          disposition: "inline",
          cid: "<b>",
        },
      ],
      bodyValues: { "1": { value: '<img src="cid:l1"><img src="cid:b">' } },
    };
    const t = setup({
      upstream: (url, init) => {
        if (url.endsWith("/jmap/session"))
          return Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } });
        if (url.includes("/jmap/download/acc1/img/")) return new Response(png);
        const req = JSON.parse(typeof init.body === "string" ? init.body : "{}") as {
          methodCalls: [string, { ids: string[] }, string][];
        };
        const ids = req.methodCalls[0]?.[1].ids ?? [];
        return Response.json({ methodResponses: [["Email/get", { list: ids.includes("e1") ? [mail] : [] }, "m"]] });
      },
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    const v = await t.svc.message(sessionId, "e1", sanitizeMessageHtml);
    expect(v?.html).toContain(`src="data:image/png;base64,${png.toString("base64")}"`);
    expect(v?.blockedImages).toBe(1); // the oversized one stays a placeholder
    expect(v?.attachments.map((a) => a.name)).toEqual([]);
    expect(await t.svc.message(sessionId, "nope", sanitizeMessageHtml)).toBeNull();
    // Another account's blob: not found, without asking Stalwart.
    const before = t.calls.length;
    expect((await t.svc.download(sessionId, "acc2", "img", "x")).status).toBe(404);
    expect(t.calls.length).toBe(before);
    await t.svc.signOut(sessionId);
    expect(await t.svc.session(sessionId)).toBeNull();
    expect(t.svc.store).toBe(t.store);
  });

  it("reports an unexpected message response as unavailable", async () => {
    const t = setup({
      upstream: (url) =>
        url.endsWith("/jmap/session")
          ? Response.json({ username: "a@x.test", primaryAccounts: { [MAIL]: "acc1" } })
          : Response.json({ methodResponses: [["error", { type: "serverFail" }, "m"]] }),
    });
    const { sessionId } = await t.svc.signIn("a@x.test", "right");
    await expect(t.svc.message(sessionId, "e1", sanitizeMessageHtml)).rejects.toBeInstanceOf(WebmailUnavailableError);
  });
});

describe("inline images", async () => {
  const { inlineImageParts, MAX_INLINE_IMAGES, referencedCids } = await import("./view");
  const part = (i: number, type = "image/png") => ({
    partId: `p${String(i)}`,
    blobId: `b${String(i)}`,
    size: 10,
    name: null,
    type,
    disposition: "inline",
    cid: `<c${String(i)}>`,
  });
  const mail = (html: string, parts: ReturnType<typeof part>[]): JmapEmail => ({
    id: "e",
    threadId: "t",
    mailboxIds: {},
    keywords: {},
    from: null,
    to: null,
    cc: null,
    replyTo: null,
    subject: null,
    sentAt: null,
    receivedAt: "2026-10-22T00:00:00Z",
    htmlBody: [{ partId: "h", blobId: "h", size: 1, name: null, type: "text/html", disposition: null, cid: null }],
    textBody: null,
    attachments: parts,
    bodyValues: { h: { value: html } },
  });

  it("fetches only images the HTML references, at most 32, once each", () => {
    const parts = Array.from({ length: 100 }, (_, i) => part(i));
    const html = parts.map((_, i) => `<img src="cid:c${String(i)}">`).join("");
    expect(inlineImageParts(mail(html, parts))).toHaveLength(MAX_INLINE_IMAGES);
    expect(inlineImageParts(mail('<img src="cid:c3"><img src="cid:c3">', parts)).map((p) => p.blobId)).toEqual(["b3"]);
    expect(inlineImageParts(mail("<p>no images</p>", parts))).toEqual([]);
    expect(inlineImageParts(mail('<img src="cid:c1">', [part(1, "image/svg+xml")]))).toEqual([]);
    expect([...referencedCids(mail('<div style="background:url(cid:c9)">', []))]).toEqual(["c9"]);
  });
});
