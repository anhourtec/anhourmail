// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Data export and account deletion routes end to end in memory (ADR-0025): 401 signed out, 403 without the permission,
 * 404 for another account, cross-origin writes refused, the export downloaded as a ZIP attachment only after a step-up,
 * deletion emailing everyone in the account, and deleting one's own login clearing the session cookie.
 */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sealedArchiver } from "@anhourmail/adapters/archive";
import { type MailMessage, memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, ANONYMOUS, systemClock } from "@anhourmail/core";
import { buildNextExport } from "@anhourmail/core/data";
import { createKeyRing } from "@anhourmail/server/keyring";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { DELETE as cancelDeletion, POST as requestDeletion } from "@/app/api/accounts/[accountId]/deletion/route";
import { GET as downloadRoute } from "@/app/api/accounts/[accountId]/exports/[exportId]/route";
import { GET as listRoute, POST as exportRoute } from "@/app/api/accounts/[accountId]/exports/route";
import { DELETE as deleteLogin } from "@/app/api/me/login/route";
import { GET as pendingRoute } from "@/app/api/platform/deletions/route";

import { setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SESSION = "console-session-1";
const ring = createKeyRing([{ id: "t", key: randomBytes(32) }]);

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
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" ? SESSION : null }),
}));
vi.mock("@/server/data-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  exportArchiver: () => sealedArchiver(ring),
}));

let uow: MemoryUnitOfWork;
let sent: MailMessage[];

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
  s.accounts.push({ id: ACCOUNT, name: "Acme", plan: "plus" }, { id: OTHER, name: "Other", plan: "plus" });
  s.memberships.push(
    { userId: "owner", accountId: ACCOUNT, role: "owner" },
    { userId: "member", accountId: ACCOUNT, role: "member" },
  );
  s.userEmails.owner = "owner@example.test";
  s.userEmails.member = "member@example.test";
  s.stepUps.push({ userId: "owner", sessionId: SESSION, expiresAt: new Date(Date.now() + 300_000) });
  const mailer = memoryMailer();
  sent = mailer.sent;
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer,
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: memoryBreachedPasswords(),
  });
  setLogSinkForTests(() => undefined);
  actor = owner;
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

describe("data export routes", () => {
  it("401 signed out, 403 for a Member, 404 for another account, 403 cross-origin", async () => {
    actor = ANONYMOUS;
    expect(
      (await exportRoute(req("POST", `/api/accounts/${ACCOUNT}/exports`), params({ accountId: ACCOUNT }))).status,
    ).toBe(401);
    actor = { ...owner, userId: "member", memberships: [{ accountId: ACCOUNT, role: "member" }] };
    expect(
      (await listRoute(req("GET", `/api/accounts/${ACCOUNT}/exports`), params({ accountId: ACCOUNT }))).status,
    ).toBe(403);
    actor = owner;
    expect((await listRoute(req("GET", `/api/accounts/${OTHER}/exports`), params({ accountId: OTHER }))).status).toBe(
      404,
    );
    const cross = req("POST", `/api/accounts/${ACCOUNT}/exports`, undefined, "https://evil.example");
    expect((await exportRoute(cross, params({ accountId: ACCOUNT }))).status).toBe(403);
    expect(uow.state.dataExports).toHaveLength(0);
  });

  it("queues an export (202), then downloads the ZIP as an attachment after a step-up", async () => {
    const res = await exportRoute(req("POST", `/api/accounts/${ACCOUNT}/exports`), params({ accountId: ACCOUNT }));
    expect(res.status).toBe(202);
    const { data } = (await res.json()) as { data: { id: string; status: string } };
    expect(data.status).toBe("queued");
    await buildNextExport({ uow, clock: systemClock, platform: PUBLIC_PLATFORM }, sealedArchiver(ring));
    const got = await downloadRoute(
      req("GET", `/api/accounts/${ACCOUNT}/exports/${data.id}`),
      params({ accountId: ACCOUNT, exportId: data.id }),
    );
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/zip");
    expect(got.headers.get("content-disposition")).toMatch(/^attachment; filename="anhourmail-account-export-/);
    expect(got.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await got.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304"); // a ZIP
    // Started from another site (a link elsewhere): refused before anything is read.
    const cross = new Request(`http://localhost:43200/api/accounts/${ACCOUNT}/exports/${data.id}`, {
      headers: { host: "localhost:43200", "sec-fetch-site": "cross-site" },
    });
    expect((await downloadRoute(cross, params({ accountId: ACCOUNT, exportId: data.id }))).status).toBe(403);
    // Without a fresh step-up: 403 step_up_required.
    uow.state.stepUps = [];
    const again = await downloadRoute(
      req("GET", `/api/accounts/${ACCOUNT}/exports/${data.id}`),
      params({ accountId: ACCOUNT, exportId: data.id }),
    );
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("step_up_required");
  });
});

describe("account deletion routes", () => {
  it("400 without the typed name; schedules and emails everyone; cancels and emails again", async () => {
    const bad = await requestDeletion(
      req("POST", `/api/accounts/${ACCOUNT}/deletion`, {}),
      params({ accountId: ACCOUNT }),
    );
    expect(bad.status).toBe(400);
    const ok = await requestDeletion(
      req("POST", `/api/accounts/${ACCOUNT}/deletion`, { confirmName: "Acme" }),
      params({ accountId: ACCOUNT }),
    );
    expect(ok.status).toBe(200);
    expect(sent.map((m) => m.to).sort()).toEqual(["member@example.test", "owner@example.test"]);
    expect(sent.every((m) => m.subject.includes("scheduled for deletion"))).toBe(true);
    expect(sent.some((m) => m.subject.includes("Acme"))).toBe(false); // names people chose never in a subject
    sent.length = 0;
    const cancel = await cancelDeletion(
      req("DELETE", `/api/accounts/${ACCOUNT}/deletion`),
      params({ accountId: ACCOUNT }),
    );
    expect(cancel.status).toBe(200);
    expect(sent).toHaveLength(2);
    const none = await cancelDeletion(
      req("DELETE", `/api/accounts/${ACCOUNT}/deletion`),
      params({ accountId: ACCOUNT }),
    );
    expect(none.status).toBe(409);
  });

  it("staff list: Global Administrators only (403 for others)", async () => {
    expect((await pendingRoute(req("GET", "/api/platform/deletions"), params({}))).status).toBe(403);
    actor = { ...owner, userId: "ga", platformRoles: ["global_admin"], memberships: [] };
    expect((await pendingRoute(req("GET", "/api/platform/deletions"), params({}))).status).toBe(200);
  });
});

describe("deleting one's own login", () => {
  it("409 while they own a non-empty account; then deletes, emails and clears the cookie", async () => {
    const blocked = await deleteLogin(
      req("DELETE", "/api/me/login", { confirmEmail: "owner@example.test" }),
      params({}),
    );
    expect(blocked.status).toBe(409);
    uow.state.memberships = uow.state.memberships.filter((m) => m.userId !== "member");
    const res = await deleteLogin(req("DELETE", "/api/me/login", { confirmEmail: "owner@example.test" }), params({}));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("am.session_token=;"))).toBe(true);
    expect(uow.state.userEmails.owner).toBeUndefined();
    expect(uow.state.accounts.map((a) => a.id)).toEqual([OTHER]);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([["owner@example.test", "Your AnhourMail login was deleted"]]);
  });
});
