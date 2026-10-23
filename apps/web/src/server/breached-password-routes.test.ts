// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The mailbox and invite password routes refuse a password from the breached-password corpus with 400
 * `password_breached` and the shared message, through the container's check (here the memory fake; no network), and
 * accept it when the check is unavailable (fail open). The console's own auth endpoints are covered by the identity
 * integration tests (packages/adapters/src/auth/auth.int.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { KNOWN_BREACHED_PASSWORDS, memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, systemClock } from "@anhourmail/core";
import { invitePerson } from "@anhourmail/core/people";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { BREACHED_PASSWORD } from "@anhourmail/shared/security";

import { POST as createMailboxRoute } from "@/app/api/accounts/[accountId]/mailboxes/route";
import { POST as resetPasswordRoute } from "@/app/api/accounts/[accountId]/mailboxes/[mailboxId]/password/route";
import { POST as acceptInviteRoute } from "@/app/api/invites/accept/route";

import { setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const DOMAIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAILBOX = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION = "sess-1";
const BREACHED = KNOWN_BREACHED_PASSWORDS[0] ?? "";
const CLEAN = "a fresh unlisted passphrase";

const owner: Actor = {
  kind: "user",
  userId: "owner",
  email: "owner@example.test",
  platformRoles: [],
  memberships: [{ accountId: ACCOUNT, role: "owner" }],
  suspended: false,
};
let actor: Actor = owner;

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: SESSION }),
}));

let uow: MemoryUnitOfWork;
let breaches: ReturnType<typeof memoryBreachedPasswords>;

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
  actor = owner;
  uow = new MemoryUnitOfWork();
  const s = uow.state;
  s.accounts.push({ id: ACCOUNT, name: "Family", plan: "plus" });
  s.memberships.push({ userId: "owner", accountId: ACCOUNT, role: "owner" });
  s.userEmails.owner = "owner@example.test";
  s.domains.push({
    id: DOMAIN,
    accountId: ACCOUNT,
    name: "family.test",
    status: "active",
    verifyToken: "t",
    stalwartId: null,
    lastError: null,
    createdAt: new Date(0),
  });
  s.mailboxes.push({
    id: MAILBOX,
    accountId: ACCOUNT,
    userId: null,
    address: "kid@family.test",
    status: "active",
    quotaBytes: 1024 ** 3,
    stalwartId: "s-1",
    lastError: null,
    purgeAfter: null,
    createdAt: new Date(0),
  });
  s.stepUps.push({ userId: "owner", sessionId: SESSION, expiresAt: new Date(Date.now() + 60_000) });
  breaches = memoryBreachedPasswords();
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: {
      hash: async () =>
        "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g",
      breaches,
    },
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

const post = (path: string, body: unknown) =>
  new Request(`http://localhost:43200${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:43200", origin: "http://localhost:43200" },
    body: JSON.stringify(body),
  });

const refusal = { error: { code: BREACHED_PASSWORD.code, message: BREACHED_PASSWORD.message } };

describe("breached passwords at the routes", () => {
  it("creating a mailbox: 400 password_breached, nothing created; a clean password is created (201)", async () => {
    const params = { params: Promise.resolve({ accountId: ACCOUNT }) };
    const make = (password: string, localPart: string) =>
      createMailboxRoute(post(`/api/accounts/${ACCOUNT}/mailboxes`, { localPart, domainId: DOMAIN, password }), params);
    const refused = await make(BREACHED, "pat");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual(refusal);
    expect(uow.state.mailboxes.map((m) => m.address)).toEqual(["kid@family.test"]);
    expect((await make(CLEAN, "pat")).status).toBe(201);
  });

  it("an admin's mailbox reset: 400 password_breached; fails open while the check is unavailable (202)", async () => {
    const params = { params: Promise.resolve({ accountId: ACCOUNT, mailboxId: MAILBOX }) };
    const reset = (password: string) =>
      resetPasswordRoute(post(`/api/accounts/${ACCOUNT}/mailboxes/${MAILBOX}/password`, { password }), params);
    const refused = await reset(BREACHED);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual(refusal);
    expect(uow.state.jobs).toHaveLength(0);
    breaches.unavailable = true;
    expect((await reset(BREACHED)).status).toBe(202);
  });

  it("someone without the permission gets 403 and causes no lookup", async () => {
    actor = { ...owner, userId: "member", memberships: [{ accountId: ACCOUNT, role: "member" }] };
    uow.state.memberships.push({ userId: "member", accountId: ACCOUNT, role: "member" });
    const res = await createMailboxRoute(
      post(`/api/accounts/${ACCOUNT}/mailboxes`, { localPart: "x", domainId: DOMAIN, password: BREACHED }),
      { params: Promise.resolve({ accountId: ACCOUNT }) },
    );
    expect(res.status).toBe(403);
    expect(breaches.calls).toBe(0);
  });

  it("accepting an invite signed out: 400 password_breached, no login; the link still works", async () => {
    const sent = await invitePerson(
      { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
      owner,
      ACCOUNT,
      { email: "new@example.test", role: "member" },
      { requestId: "r", ip: null, userAgent: null },
    );
    actor = { kind: "anonymous" };
    const accept = (password: string) =>
      acceptInviteRoute(post("/api/invites/accept", { token: sent.token, firstName: "New", password }), {
        params: Promise.resolve({}),
      });
    const refused = await accept(BREACHED);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual(refusal);
    expect(uow.state.logins).toHaveLength(0);
    expect((await accept(CLEAN)).status).toBe(200);
  });
});
