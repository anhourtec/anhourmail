// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The console → webmail handoff routes end to end in memory (ADR-0024): the webmail origin's start sets the verifier
 * cookie and sends the browser to the console with only its challenge; the console mints a code for the person's own
 * mailbox (401 signed out, 404 someone else's, 403 acting as someone) and answers the webmail page with the code in the
 * URL fragment; the redemption works once, only with this browser's verifier, sets the webmail session cookie and
 * always clears the verifier. The mail server side (`openHandoff`) is a fake here; the integration test covers it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, systemClock } from "@anhourmail/core";
import type { HandoffCodeStore, HandoffGrant, WebmailAccess } from "@anhourmail/core/webmail";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { ACT_AS_ACCOUNT_ROLE } from "@anhourmail/shared/rbac";

import { GET as startRoute, POST as redeemRoute } from "@/app/api/webmail/handoff/route";
import { POST as mintRoute } from "@/app/api/accounts/[accountId]/mailboxes/[mailboxId]/webmail-handoff/route";

import { setContainerForTests } from "./container";
import type * as HandoffModule from "./webmail/handoff";
import type * as InstanceModule from "./webmail/instance";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const MINE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const THEIRS = "abababab-abab-4bab-8bab-abababababab";
const SESSION = "console-session-1";

const member: Actor = {
  kind: "user",
  userId: "member",
  email: "member@example.test",
  platformRoles: [],
  memberships: [{ accountId: ACCOUNT, role: "member" }],
  suspended: false,
};
let actor: Actor = member;

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" ? SESSION : null }),
}));

const codes = new Map<string, HandoffGrant>();
const states = new Map<string, WebmailAccess>();
const store: HandoffCodeStore = {
  put: async (k, g) => {
    codes.set(k, structuredClone(g));
  },
  take: async (k) => {
    const g = codes.get(k) ?? null;
    codes.delete(k);
    return g;
  },
};
vi.mock("@/server/webmail/handoff", async (importOriginal) => ({
  ...(await importOriginal<typeof HandoffModule>()),
  redisHandoffCodes: () => store,
  handoffAccess: () => ({ state: async (a: string) => states.get(a) ?? "ok" }),
}));

const opened: { address: string; externalId: string }[] = [];
const signedOut: string[] = [];
vi.mock("@/server/webmail/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof InstanceModule>()),
  webmail: () => ({
    openHandoff: async (t: { address: string; externalId: string }) => {
      opened.push(t);
      return { sessionId: "w".repeat(43), session: { username: t.address } };
    },
    signOut: async (id: string) => {
      signedOut.push(id);
    },
    store: { cookieMaxAgeSec: 3600 },
  }),
}));

let uow: MemoryUnitOfWork;

beforeEach(() => {
  vi.stubEnv("APP_URL", "http://localhost:43200");
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  resetEnvForTests();
  actor = member;
  codes.clear();
  states.clear();
  opened.length = 0;
  signedOut.length = 0;
  uow = new MemoryUnitOfWork();
  const s = uow.state;
  s.accounts.push({ id: ACCOUNT, name: "Family", plan: "plus" });
  s.memberships.push(
    { userId: "member", accountId: ACCOUNT, role: "member" },
    { userId: "owner", accountId: ACCOUNT, role: "owner" },
  );
  s.userEmails.member = "member@example.test";
  s.sessions.push({
    id: SESSION,
    userId: "member",
    createdAt: new Date(0),
    lastActiveAt: new Date(0),
    expiresAt: new Date(Date.now() + 86_400_000),
    ip: null,
    userAgent: null,
  });
  // A fresh step-up on this console session (a sign-in counts), as the identity layer records it.
  s.stepUps.push({ userId: "member", sessionId: SESSION, expiresAt: new Date(Date.now() + 300_000) });
  const mailbox = (id: string, address: string, userId: string) => ({
    id,
    accountId: ACCOUNT,
    userId,
    address,
    status: "active" as const,
    quotaBytes: 1024,
    stalwartId: `s-${id.slice(0, 2)}`,
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push(mailbox(MINE, "kid@family.test", "member"), mailbox(THEIRS, "mum@family.test", "owner"));
  const breaches = memoryBreachedPasswords();
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "unused", breaches },
    breaches,
  });
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const WEBMAIL = "http://localhost:43300";
const CONSOLE = "http://localhost:43200";
const none = { params: Promise.resolve({}) };

/** Step 1 on the webmail origin: the verifier cookie and the challenge in the redirect. */
async function start(query = ""): Promise<{ cookie: string; challenge: string; location: URL; res: Response }> {
  const res = await startRoute(
    new Request(`${WEBMAIL}/api/webmail/handoff${query}`, { headers: { host: "localhost:43300" } }),
    none,
  );
  const set = res.headers.getSetCookie().find((c) => c.startsWith("am.handoff=")) ?? "";
  const location = new URL(res.headers.get("location") ?? "http://invalid");
  return { cookie: set.split(";")[0] ?? "", challenge: location.searchParams.get("challenge") ?? "", location, res };
}

/** Step 2 on the console origin. */
const mint = (mailboxId: string, challenge: string) =>
  mintRoute(
    new Request(`${CONSOLE}/api/accounts/${ACCOUNT}/mailboxes/${mailboxId}/webmail-handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:43200", origin: CONSOLE },
      body: JSON.stringify({ challenge }),
    }),
    { params: Promise.resolve({ accountId: ACCOUNT, mailboxId }) },
  );

/** Step 3 on the webmail origin. */
const redeem = (code: string, cookie: string) =>
  redeemRoute(
    new Request(`${WEBMAIL}/api/webmail/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:43300", origin: WEBMAIL, cookie },
      body: JSON.stringify({ code }),
    }),
    none,
  );

const codeOf = async (res: Response): Promise<string> => {
  const { data } = (await res.json()) as { data: { url: string } };
  const url = new URL(data.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${WEBMAIL}/handoff`);
  expect(url.search).toBe("");
  return url.hash.slice(1);
};

describe("webmail handoff routes", () => {
  it("start: an HttpOnly, SameSite=Strict verifier cookie and a redirect carrying only its challenge", async () => {
    const { res, cookie, challenge, location } = await start(`?mailbox=${MINE.toUpperCase()}`);
    expect(res.status).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(`${CONSOLE}/open-webmail`);
    expect(location.searchParams.get("mailbox")).toBe(MINE);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.slice("am.handoff=".length)).not.toBe(challenge);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("am.handoff=")) ?? "";
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Max-Age=120/);
    // Anything but a mailbox id is dropped (never an address in a URL).
    expect((await start("?mailbox=kid@family.test")).location.searchParams.has("mailbox")).toBe(false);
  });

  it("console → webmail → inbox without a password, once, with a session cookie and the verifier cleared", async () => {
    const { cookie, challenge } = await start();
    const minted = await mint(MINE, challenge);
    expect(minted.status).toBe(201);
    const code = await codeOf(minted);
    const res = await redeem(code, `${cookie}; am.webmail=${"o".repeat(43)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { username: "kid@family.test" } });
    expect(opened).toMatchObject([
      { address: "kid@family.test", externalId: "s-dd", console: { userId: "member", sessionId: SESSION } },
    ]);
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.startsWith(`am.webmail=${"w".repeat(43)}`))).toBe(true);
    expect(set.some((c) => c.startsWith("am.handoff=;") && c.includes("Max-Age=0"))).toBe(true);
    // The browser's previous webmail session was ended, not left behind.
    expect(signedOut).toEqual(["o".repeat(43)]);
    // Once only.
    const again = await redeem(code, cookie);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("handoff_invalid");
    expect(opened).toHaveLength(1);
    expect(uow.state.audit.map((e) => [e.action, e.result])).toEqual([
      ["webmail.handoff_started", "success"],
      ["webmail.handoff_redeemed", "success"],
    ]);
  });

  it("another browser (no verifier, or its own) can't use the code; the cookie is cleared on refusals too", async () => {
    const { challenge } = await start();
    const code = await codeOf(await mint(MINE, challenge));
    const other = await start();
    const res = await redeem(code, other.cookie);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("handoff_refused");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("am.handoff=;"))).toBe(true);
    // Without any verifier: refused too, and that attempt uses a fresh code up.
    const second = await codeOf(await mint(MINE, challenge));
    expect((await redeem(second, "")).status).toBe(409);
    expect((await redeem(second, (await start()).cookie)).status).toBe(400);
    expect(opened).toEqual([]);
  });

  it("mint: 401 signed out, 404 someone else's mailbox, 403 acting as someone, 409 a suspended mailbox", async () => {
    const { challenge } = await start();
    expect((await mint(MINE, challenge)).status).toBe(201);
    expect((await mint(THEIRS, challenge)).status).toBe(404);
    actor = { kind: "anonymous" };
    expect((await mint(MINE, challenge)).status).toBe(401);
    actor = {
      kind: "user",
      userId: "staff-1",
      email: "staff-1@anhourtec.test",
      platformRoles: [],
      memberships: [{ accountId: ACCOUNT, role: ACT_AS_ACCOUNT_ROLE }],
      suspended: false,
      actingAs: {
        sessionId: "act-1",
        accountId: ACCOUNT,
        staffUserId: "staff-1",
        staffEmail: "staff-1@anhourtec.test",
        staffRole: "support_admin",
        reason: "ticket",
        expiresAt: new Date(Date.now() + 600_000),
      },
    };
    expect((await mint(MINE, challenge)).status).toBe(403);
    actor = member;
    states.set("kid@family.test", "suspended");
    const refused = await mint(MINE, challenge);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("handoff_refused");
  });

  it("mint needs a fresh step-up on this console session (403 step_up_required)", async () => {
    uow.state.stepUps = [];
    const { challenge } = await start();
    const res = await mint(MINE, challenge);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("step_up_required");
    expect(codes.size).toBe(0);
  });

  it("drops the webmail session again when the audit entry after it can't be written", async () => {
    const { cookie, challenge } = await start();
    const code = await codeOf(await mint(MINE, challenge));
    const run = uow.run.bind(uow);
    // The redemption's unit of work fails after `open` (the audit append).
    vi.spyOn(uow, "run").mockImplementation(async (fn) =>
      run(async (r) => {
        const out = await fn(r);
        if (opened.length > 0) throw new Error("audit write failed");
        return out;
      }),
    );
    const res = await redeem(code, cookie);
    expect(res.status).toBe(500);
    expect(opened).toHaveLength(1);
    expect(signedOut).toEqual(["w".repeat(43)]);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`am.webmail=${"w".repeat(43)}`))).toBe(false);
  });

  it("refuses a cross-origin mint (CSRF) before anything happens", async () => {
    const { challenge } = await start();
    const res = await mintRoute(
      new Request(`${CONSOLE}/api/accounts/${ACCOUNT}/mailboxes/${MINE}/webmail-handoff`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:43200", origin: "https://evil.example" },
        body: JSON.stringify({ challenge }),
      }),
      { params: Promise.resolve({ accountId: ACCOUNT, mailboxId: MINE }) },
    );
    expect(res.status).toBe(403);
    expect(codes.size).toBe(0);
  });
});
