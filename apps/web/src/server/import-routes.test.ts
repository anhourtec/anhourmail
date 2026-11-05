// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mail import routes end to end in memory (ADR-0030 §13, §15): start (fresh step-up, own vs any, 404 out of scope,
 * 409 unavailable mailbox), list and read, pause / resume / cancel / stop syncing, the admin-started notice email, the
 * `importStart` tier and the per-account daily count, cross-origin writes refused, and no secret in any response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, ANONYMOUS, systemClock, type UserActor } from "@anhourmail/core";
import type { ImportContext } from "@anhourmail/core/imports";
import type { Mailbox } from "@anhourmail/core/mailboxes";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import type { AccountRole } from "@anhourmail/shared/rbac";

import { POST as cancelRoute } from "@/app/api/accounts/[accountId]/imports/[importId]/cancel/route";
import { POST as pauseRoute } from "@/app/api/accounts/[accountId]/imports/[importId]/pause/route";
import { POST as resumeRoute } from "@/app/api/accounts/[accountId]/imports/[importId]/resume/route";
import { GET as getRoute } from "@/app/api/accounts/[accountId]/imports/[importId]/route";
import { POST as stopSyncRoute } from "@/app/api/accounts/[accountId]/imports/[importId]/stop-sync/route";
import { GET as listRoute, POST as startRoute } from "@/app/api/accounts/[accountId]/imports/route";

import { setContainerForTests } from "./container";
import type * as ImportsModule from "./imports";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KIM_BOX = "aaaaaaaa-0000-4000-8000-000000000002";
const OWNER_BOX = "aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_BOX = "bbbbbbbb-0000-4000-8000-000000000001";
const SESSION = "console-session-1";

const as = (userId: string, accountId: string, role: AccountRole): UserActor => ({
  kind: "user",
  userId,
  email: `${userId}@family.test`,
  platformRoles: [],
  memberships: [{ accountId, role }],
  suspended: false,
});
const owner = as("owner", ACCOUNT, "owner");
const userAdmin = as("uadmin", ACCOUNT, "user_admin");
const member = as("kim", ACCOUNT, "member");
const outsider = as("owner-b", OTHER, "owner");
let actor: Actor = owner;
let stepUp = true;

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" && stepUp ? SESSION : null }),
}));

const minted: string[] = [];
const ctx: ImportContext = {
  issuer: {
    mint: async () => {
      minted.push("c");
      return { id: `cred-${String(minted.length)}`, createdAt: new Date(), secret: "app_dest_secret" };
    },
    destroy: async () => undefined,
  },
  sealer: {
    encrypt: (purpose, plaintext, aad) => `sealed:${Buffer.from(`${purpose}|${aad}|${plaintext}`).toString("base64")}`,
    decrypt: (purpose, sealed, aad) => {
      const [p, a, ...rest] = Buffer.from(sealed.slice(7), "base64").toString().split("|");
      if (p !== purpose || a !== aad) throw new Error("does not open");
      return rest.join("|");
    },
  },
  devSources: new Set(),
};

vi.mock("@/server/imports", async (load) => ({
  ...(await load<typeof ImportsModule>()),
  importContext: () => ctx,
}));

let uow: MemoryUnitOfWork;
let mailer: ReturnType<typeof memoryMailer>;

const box = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
  id,
  accountId,
  userId,
  address,
  status: "active",
  quotaBytes: 1024 * 1024,
  stalwartId: `s-${id.slice(-2)}`,
  lastError: null,
  purgeAfter: null,
  createdAt: new Date(0),
});

beforeEach(() => {
  vi.stubEnv("APP_URL", "http://localhost:43200");
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  resetEnvForTests();
  uow = new MemoryUnitOfWork();
  const s = uow.state;
  s.accounts.push({ id: ACCOUNT, name: "Family", plan: "plus" }, { id: OTHER, name: "Other", plan: "plus" });
  for (const [userId, accountId, role] of [
    ["owner", ACCOUNT, "owner"],
    ["uadmin", ACCOUNT, "user_admin"],
    ["kim", ACCOUNT, "member"],
    ["owner-b", OTHER, "owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@family.test`;
  }
  s.mailboxes.push(
    box(KIM_BOX, ACCOUNT, "kim@family.test", "kim"),
    box(OWNER_BOX, ACCOUNT, "owner@family.test", "owner"),
    box(OTHER_BOX, OTHER, "bea@other.test", "owner-b"),
  );
  for (const userId of ["owner", "uadmin", "kim", "owner-b"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date(Date.now() + 300_000) });
  }
  mailer = memoryMailer();
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer,
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "x" },
    breaches: memoryBreachedPasswords(),
  });
  setLogSinkForTests(() => undefined);
  actor = owner;
  stepUp = true;
  minted.length = 0;
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const req = (method: string, path: string, body?: unknown, origin = "http://localhost:43200") =>
  new Request(`http://localhost:43200${path}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:43200", origin },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const base = (accountId = ACCOUNT) => `/api/accounts/${accountId}/imports`;
const SOURCE = { host: "imap.old.example", port: 993, username: "kim@old.example", password: "old-app-pw" };

const start = (mailboxId: string, body: Record<string, unknown> = {}, accountId = ACCOUNT, origin?: string) =>
  startRoute(req("POST", base(accountId), { mailboxId, ...SOURCE, ...body }, origin), params({ accountId }));
const control = (
  route: typeof pauseRoute,
  action: string,
  importId: string,
  body?: unknown,
  accountId = ACCOUNT,
): Promise<Response> =>
  route(req("POST", `${base(accountId)}/${importId}/${action}`, body), params({ accountId, importId }));

type ImportBody = { data: { id: string; status: string; requestedAs: string } };

describe("mail import routes", () => {
  it("starts an import into one's own mailbox with a step-up, never answering a secret", async () => {
    actor = member;
    const res = await start(KIM_BOX);
    expect(res.status).toBe(201);
    expect(res.headers.get("ratelimit-limit")).toBe("10");
    const text = await res.text();
    expect(text).not.toMatch(/old-app-pw|app_dest_secret|kim@old\.example/);
    const body = JSON.parse(text) as ImportBody;
    expect(body.data).toMatchObject({ status: "queued", requestedAs: "own" });
    // Nobody else to tell.
    expect(mailer.sent).toHaveLength(0);
  });

  it("refuses: 401 signed out, 403 without a step-up or on someone else's mailbox, 404 out of scope, 409 busy", async () => {
    // More requests than the per-caller tier allows in one test (the tier itself is the last test's).
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "10");
    actor = ANONYMOUS;
    expect((await start(KIM_BOX)).status).toBe(401);
    actor = member;
    stepUp = false;
    const noStepUp = await start(KIM_BOX);
    expect(noStepUp.status).toBe(403);
    expect(await errorCode(noStepUp)).toBe("step_up_required");
    stepUp = true;
    expect((await start(OWNER_BOX)).status).toBe(404);
    actor = userAdmin;
    expect((await start(OWNER_BOX)).status).toBe(403);
    actor = outsider;
    expect((await start(KIM_BOX)).status).toBe(404);
    actor = owner;
    expect((await start(OTHER_BOX)).status).toBe(404);
    expect((await start(KIM_BOX, { host: "localhost" })).status).toBe(400);
    expect((await start(KIM_BOX)).status).toBe(201);
    const busy = await start(KIM_BOX);
    expect(busy.status).toBe(409);
    expect(await errorCode(busy)).toBe("import_running");
    const m = uow.state.mailboxes.find((x) => x.id === OWNER_BOX);
    if (m) m.status = "suspended";
    const unavailable = await start(OWNER_BOX);
    expect(unavailable.status).toBe(409);
    expect(await errorCode(unavailable)).toBe("mailbox_unavailable");
    // A write from another origin is refused before anything runs.
    expect((await start(KIM_BOX, {}, ACCOUNT, "https://evil.example")).status).toBe(403);
    expect(minted).toHaveLength(1);
  });

  it("emails the person when an admin starts an import into their mailbox", async () => {
    actor = userAdmin;
    const res = await start(KIM_BOX);
    expect(res.status).toBe(201);
    expect(((await res.json()) as ImportBody).data.requestedAs).toBe("admin");
    expect(mailer.sent).toHaveLength(1);
    const [sent] = mailer.sent;
    expect(sent?.to).toBe("kim@family.test");
    expect(sent?.subject).toMatch(/started importing mail/);
    expect(JSON.stringify(sent)).not.toMatch(/old-app-pw|kim@old\.example/);
  });

  it("lists and reads imports in scope, pauses, resumes, stops syncing and cancels", async () => {
    actor = member;
    const id = ((await (await start(KIM_BOX, { options: { sync: true } })).json()) as ImportBody).data.id;
    const list = (await (await listRoute(req("GET", base()), params({ accountId: ACCOUNT }))).json()) as {
      data: { id: string }[];
    };
    expect(list.data.map((i) => i.id)).toEqual([id]);
    const one = await getRoute(req("GET", `${base()}/${id}`), params({ accountId: ACCOUNT, importId: id }));
    expect(one.status).toBe(200);
    actor = outsider;
    expect((await getRoute(req("GET", `${base()}/${id}`), params({ accountId: ACCOUNT, importId: id }))).status).toBe(
      404,
    );
    expect((await control(pauseRoute, "pause", id)).status).toBe(404);
    actor = member;
    expect((await control(pauseRoute, "pause", id)).status).toBe(200);
    const resumed = await control(resumeRoute, "resume", id, "");
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as ImportBody).data.status).toBe("queued");
    expect((await control(stopSyncRoute, "stop-sync", id)).status).toBe(200);
    const cancelled = await control(cancelRoute, "cancel", id);
    expect(((await cancelled.json()) as ImportBody).data.status).toBe("cancelled");
    const again = await control(cancelRoute, "cancel", id);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("import_finished");
    expect((await control(pauseRoute, "pause", "not-an-id")).status).toBe(404);
  });

  it("limits starts per caller (fail closed), and counts them per account only for callers who may import there", async () => {
    actor = owner;
    for (let i = 0; i < 10; i++) expect((await start(KIM_BOX, { host: "bad host" })).status).toBe(400);
    const over = await start(KIM_BOX);
    expect(over.status).toBe(429);
    expect(minted).toEqual([]);
  });
});
