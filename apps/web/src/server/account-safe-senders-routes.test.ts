// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The account-wide Safe senders routes (ADR-0032 §1): Owners and User Administrators change the list, Read-only reads
 * it, Members get 403 (their body is never read), other accounts 404; every change schedules the managed-script pass.
 * In memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, systemClock, type UserActor } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { DELETE } from "@/app/api/accounts/[accountId]/safe-senders/[entryId]/route";
import { GET, POST } from "@/app/api/accounts/[accountId]/safe-senders/route";

import { setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PHC = `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${"a".repeat(43)}`;

const person = (userId: string, accountId: string, role: "owner" | "user_admin" | "member" | "auditor"): UserActor => ({
  kind: "user",
  userId,
  email: `${userId}@family.test`,
  platformRoles: [],
  memberships: [{ accountId, role }],
  suspended: false,
});
const owner = person("owner", ACCOUNT, "owner");
const userAdmin = person("ua", ACCOUNT, "user_admin");
const member = person("kim", ACCOUNT, "member");
const auditor = person("aud", ACCOUNT, "auditor");
const outsider = person("out", OTHER, "owner");
let actor: Actor = owner;

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" ? "s1" : null }),
}));
const scheduled: string[] = [];
vi.mock("@/server/webmail/account-safe-apply", () => ({
  scheduleAccountSafeSenders: (accountId: string) => {
    scheduled.push(accountId);
  },
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
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  resetEnvForTests();
  uow = new MemoryUnitOfWork();
  uow.state.accounts.push({ id: ACCOUNT, name: "Family", plan: "plus" }, { id: OTHER, name: "Other", plan: "plus" });
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => PHC },
    breaches: memoryBreachedPasswords(),
  });
  setLogSinkForTests(() => undefined);
  actor = owner;
  scheduled.length = 0;
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const request = (method: string, path: string, body?: string) =>
  new Request(`http://localhost:43200${path}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:43200", origin: "http://localhost:43200" },
    ...(body === undefined ? {} : { body }),
  });
const list = (accountId = ACCOUNT) =>
  GET(request("GET", `/api/accounts/${accountId}/safe-senders`), { params: Promise.resolve({ accountId }) });
const add = (body: string, accountId = ACCOUNT) =>
  POST(request("POST", `/api/accounts/${accountId}/safe-senders`, body), { params: Promise.resolve({ accountId }) });
const remove = (entryId: string, accountId = ACCOUNT) =>
  DELETE(request("DELETE", `/api/accounts/${accountId}/safe-senders/${entryId}`), {
    params: Promise.resolve({ accountId, entryId }),
  });
type ListBody = { data: { entries: { id: string; entry: string }[]; canManage: boolean } };

describe("account safe senders routes", () => {
  it("adds, lists and removes entries, scheduling the mailbox pass after each change", async () => {
    const res = await add(JSON.stringify({ entries: ["Partner.example", "jane@corp.example"] }));
    expect(res.status).toBe(201);
    expect(scheduled).toEqual([ACCOUNT]);
    actor = userAdmin;
    const got = (await (await list()).json()) as ListBody;
    expect(got.data.entries.map((e) => e.entry).sort()).toEqual(["jane@corp.example", "partner.example"]);
    expect(got.data.canManage).toBe(true);
    // Adding only what is there already: no pass.
    expect((await add(JSON.stringify({ entries: ["partner.example"] }))).status).toBe(201);
    expect(scheduled).toHaveLength(1);
    const id = got.data.entries[0]?.id ?? "";
    expect((await remove(id)).status).toBe(200);
    expect(scheduled).toHaveLength(2);
    expect((await remove(id)).status).toBe(404);
  });

  it("lets Read-only read; refuses Members (403) without reading their body, and other accounts (404)", async () => {
    await add(JSON.stringify({ entries: ["partner.example"] }));
    actor = auditor;
    expect(((await (await list()).json()) as ListBody).data.canManage).toBe(false);
    expect((await add(JSON.stringify({ entries: ["x.example"] }))).status).toBe(403);
    actor = member;
    expect((await list()).status).toBe(403);
    // Not JSON at all: still a 403, so the body was never parsed.
    expect((await add("not json")).status).toBe(403);
    actor = outsider;
    expect((await list()).status).toBe(404);
    expect((await add(JSON.stringify({ entries: ["x.example"] }))).status).toBe(404);
    const id = uow.state.accountSafeSenders[0]?.id ?? "";
    expect((await remove(id)).status).toBe(404);
    // The outsider's own account doesn't hold that id either.
    expect((await remove(id, OTHER)).status).toBe(404);
    expect(uow.state.accountSafeSenders).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  it("answers 400 for a malformed body and 413 for a huge one", async () => {
    expect((await add("{")).status).toBe(400);
    expect((await add(JSON.stringify({ entries: "partner.example" }))).status).toBe(400);
    expect((await add(JSON.stringify({ entries: ["x".repeat(70 * 1024)] }))).status).toBe(413);
    expect(uow.state.accountSafeSenders).toEqual([]);
  });
});
