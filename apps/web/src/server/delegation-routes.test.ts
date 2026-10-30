// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mailbox delegation routes end to end in memory (ADR-0026 §5): the Delegation tab's read and batch change, "Convert
 * to shared mailbox", a person's "Mailboxes they can open", and removing someone with "Give full access to …". 401
 * signed out, 403 without the permission (and guard rail 8, act-as, step-up), 404 for another account's ids,
 * cross-origin writes refused, malformed bodies 400, the `delegationManage` tier on the changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, ANONYMOUS, systemClock, type UserActor } from "@anhourmail/core";
import type { Mailbox } from "@anhourmail/core/mailboxes";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import type { AccountRole } from "@anhourmail/shared/rbac";

import { POST as convertRoute } from "@/app/api/accounts/[accountId]/mailboxes/[mailboxId]/convert-to-shared/route";
import {
  GET as getDelegation,
  PATCH as patchDelegation,
} from "@/app/api/accounts/[accountId]/mailboxes/[mailboxId]/delegation/route";
import { GET as personDelegations } from "@/app/api/accounts/[accountId]/people/[userId]/delegation/route";
import { DELETE as removeRoute } from "@/app/api/accounts/[accountId]/people/[userId]/route";

import { setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SHARED = "aaaaaaaa-0000-4000-8000-000000000001";
const KIM_BOX = "aaaaaaaa-0000-4000-8000-000000000002";
const OWNER_BOX = "aaaaaaaa-0000-4000-8000-000000000003";
const OTHER_BOX = "bbbbbbbb-0000-4000-8000-000000000001";
const SESSION = "console-session-1";
/** An argon2id PHC string at the pinned parameters (the release checks the shape before queuing it). */
const PHC = `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${"a".repeat(43)}`;

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

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" ? SESSION : null }),
}));

let uow: MemoryUnitOfWork;

const box = (id: string, accountId: string, address: string, userId: string | null): Mailbox => ({
  id,
  accountId,
  userId,
  address,
  status: "active",
  quotaBytes: 1024,
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
  for (const [userId, accountId, role, name] of [
    ["owner", ACCOUNT, "owner", "Olive Owner"],
    ["uadmin", ACCOUNT, "user_admin", "Uma Admin"],
    ["kim", ACCOUNT, "member", "Kim Member"],
    ["lee", ACCOUNT, "member", "Lee Member"],
    ["owner-b", OTHER, "owner", "Bea Owner"],
  ] as const) {
    s.memberships.push({ userId, accountId, role });
    s.userEmails[userId] = `${userId}@family.test`;
    s.userNames[userId] = name;
  }
  s.mailboxes.push(
    box(SHARED, ACCOUNT, "desk@family.test", null),
    box(KIM_BOX, ACCOUNT, "kim@family.test", "kim"),
    box(OWNER_BOX, ACCOUNT, "owner@family.test", "owner"),
    box(OTHER_BOX, OTHER, "bea@other.test", "owner-b"),
  );
  for (const userId of ["owner", "uadmin", "kim", "owner-b"]) {
    s.stepUps.push({ userId, sessionId: SESSION, expiresAt: new Date(Date.now() + 300_000) });
  }
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
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

/** `body`: a value to send as JSON, or a string sent as is (malformed JSON, or "" for no body at all). */
const req = (method: string, path: string, body?: unknown, origin = "http://localhost:43200") =>
  new Request(`http://localhost:43200${path}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:43200", origin },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

const delegationPath = (mailboxId: string, accountId = ACCOUNT) =>
  `/api/accounts/${accountId}/mailboxes/${mailboxId}/delegation`;
const read = (mailboxId: string, accountId = ACCOUNT) =>
  getDelegation(req("GET", delegationPath(mailboxId, accountId)), params({ accountId, mailboxId }));
const change = (mailboxId: string, body: unknown, origin?: string) =>
  patchDelegation(req("PATCH", delegationPath(mailboxId), body, origin), params({ accountId: ACCOUNT, mailboxId }));
const convert = (mailboxId: string, body?: unknown, accountId = ACCOUNT) =>
  convertRoute(
    req("POST", `/api/accounts/${accountId}/mailboxes/${mailboxId}/convert-to-shared`, body),
    params({ accountId, mailboxId }),
  );
const remove = (userId: string, body?: unknown) =>
  removeRoute(req("DELETE", `/api/accounts/${ACCOUNT}/people/${userId}`, body), params({ accountId: ACCOUNT, userId }));
const personList = (userId: string, accountId = ACCOUNT) =>
  personDelegations(
    req("GET", `/api/accounts/${accountId}/people/${userId}/delegation`),
    params({ accountId, userId }),
  );

type View = { data: { fullAccess: { userId: string }[]; sendAs: { userId: string }[]; canManage: boolean } };

describe("mailbox delegation routes", () => {
  it("GET: 401 signed out, 403 for a Member, 404 for another account's mailbox or an unknown id, 200 with the lists", async () => {
    actor = ANONYMOUS;
    expect((await read(SHARED)).status).toBe(401);
    actor = member;
    expect((await read(SHARED)).status).toBe(403);
    actor = outsider;
    expect((await read(SHARED)).status).toBe(404);
    actor = owner;
    expect((await read(OTHER_BOX)).status).toBe(404);
    expect((await read("aaaaaaaa-0000-4000-8000-0000000000ff")).status).toBe(404);
    const res = await read(SHARED);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      data: {
        mailboxId: SHARED,
        address: "desk@family.test",
        fullAccess: [],
        sendAs: [],
        sendOnBehalf: [],
        canManage: true,
      },
    });
  });

  it("PATCH: adds and removes in one batch on the delegationManage tier, and the read shows it", async () => {
    const res = await change(SHARED, {
      add: [
        { userId: "kim", right: "full_access" },
        { userId: "kim", right: "send_as" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-limit")).toBe("30");
    const view = (await res.json()) as View;
    expect(view.data.fullAccess.map((p) => p.userId)).toEqual(["kim"]);
    expect(view.data.sendAs.map((p) => p.userId)).toEqual(["kim"]);
    const back = await change(SHARED, { remove: [{ userId: "kim", right: "send_as" }] });
    expect(back.status).toBe(200);
    const now = (await (await read(SHARED)).json()) as View;
    expect(now.data.sendAs).toEqual([]);
    expect(now.data.fullAccess.map((p) => p.userId)).toEqual(["kim"]);
    const actions = uow.state.audit.filter((e) => e.action.startsWith("delegation.")).map((e) => e.action);
    expect(actions).toEqual(["delegation.granted", "delegation.granted", "delegation.revoked"]);
  });

  it("PATCH: 403 cross-origin, 400 for malformed JSON or an empty batch, 404 for a person outside the account", async () => {
    expect(
      (await change(SHARED, { add: [{ userId: "kim", right: "full_access" }] }, "https://evil.example")).status,
    ).toBe(403);
    expect((await change(SHARED, "{not json")).status).toBe(400);
    const empty = await change(SHARED, {});
    expect(empty.status).toBe(400);
    expect(await errorCode(empty)).toBe("bad_request");
    expect((await change(SHARED, { add: [{ userId: "kim", right: "read_all" }] })).status).toBe(400);
    expect((await change(SHARED, { add: [{ userId: "owner-b", right: "full_access" }] })).status).toBe(404);
    expect(uow.state.delegations).toHaveLength(0);
  });

  it("PATCH: 403 for a Member, guard rail 8 for a User Admin on an Owner's mailbox, a stale step-up, and act-as", async () => {
    const batch = { add: [{ userId: "lee", right: "full_access" }] };
    actor = member;
    expect((await change(SHARED, batch)).status).toBe(403);
    actor = userAdmin;
    expect((await change(OWNER_BOX, batch)).status).toBe(403);
    expect((await change(KIM_BOX, batch)).status).toBe(200);
    uow.state.stepUps = [];
    const stale = await change(SHARED, batch);
    expect(stale.status).toBe(403);
    expect(await errorCode(stale)).toBe("step_up_required");
    actor = {
      ...owner,
      actingAs: {
        sessionId: "act-as-1",
        accountId: ACCOUNT,
        staffUserId: "owner",
        staffEmail: "staff@anhourtec.test",
        staffRole: "support_admin",
        reason: "Customer ticket 1234",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    };
    expect((await change(SHARED, batch)).status).toBe(403);
    expect(uow.state.delegations.map((g) => g.mailboxId)).toEqual([KIM_BOX]);
    expect(uow.state.audit.some((e) => e.result === "denied" && e.errorCode === "step_up_required")).toBe(true);
  });

  it("PATCH: 409 when the mailbox's own person is added", async () => {
    expect((await change(KIM_BOX, { add: [{ userId: "kim", right: "full_access" }] })).status).toBe(409);
  });
});

describe("convert to shared mailbox route", () => {
  it("202 with grants written in the same change; then 409 once it is shared", async () => {
    const res = await convert(KIM_BOX, { fullAccessTo: ["lee"], sendAs: true });
    expect(res.status).toBe(202);
    expect(res.headers.get("ratelimit-limit")).toBe("30");
    const { data } = (await res.json()) as { data: { grants: number; mailbox: { id: string } } };
    expect(data.grants).toBe(2);
    expect(data.mailbox.id).toBe(KIM_BOX);
    expect(uow.state.mailboxes.find((m) => m.id === KIM_BOX)?.userId).toBeNull();
    expect(uow.state.jobs.some((j) => j.kind === "mailbox.password")).toBe(true);
    const again = await convert(KIM_BOX, {});
    expect(again.status).toBe(409);
  });

  it("takes no body at all (no grants); 400 for malformed JSON or unknown fields", async () => {
    expect((await convert(KIM_BOX, "{")).status).toBe(400);
    expect((await convert(KIM_BOX, { fullAccessTo: [], extra: 1 })).status).toBe(400);
    const res = await convert(KIM_BOX, "");
    expect(res.status).toBe(202);
    expect(((await res.json()) as { data: { grants: number } }).data.grants).toBe(0);
  });

  it("401 signed out, 403 for a Member, 404 across accounts, 403 without a fresh step-up", async () => {
    actor = ANONYMOUS;
    expect((await convert(KIM_BOX)).status).toBe(401);
    actor = member;
    expect((await convert(KIM_BOX)).status).toBe(403);
    actor = outsider;
    expect((await convert(KIM_BOX)).status).toBe(404);
    actor = owner;
    expect((await convert(OTHER_BOX, undefined, ACCOUNT)).status).toBe(404);
    uow.state.stepUps = [];
    const stale = await convert(KIM_BOX);
    expect(stale.status).toBe(403);
    expect(await errorCode(stale)).toBe("step_up_required");
    expect(uow.state.mailboxes.find((m) => m.id === KIM_BOX)?.userId).toBe("kim");
  });
});

describe("a person's delegated mailboxes route", () => {
  it("lists what they can open, with their rights; 403 for a Member; 404 outside the account", async () => {
    await change(SHARED, {
      add: [
        { userId: "lee", right: "send_on_behalf" },
        { userId: "lee", right: "full_access" },
      ],
    });
    const res = await personList("lee");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ mailboxId: SHARED, address: "desk@family.test", rights: ["full_access", "send_on_behalf"] }],
    });
    expect((await personList("owner-b")).status).toBe(404);
    expect((await personList("nobody")).status).toBe(404);
    actor = member;
    expect((await personList("lee")).status).toBe(403);
    actor = outsider;
    expect((await personList("lee")).status).toBe(404);
  });
});

describe("removing someone with Give full access", () => {
  it("removes without a body, as before", async () => {
    const res = await remove("lee");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { userId: "lee", delegated: 0 } });
  });

  it("gives the named person read and manage (and send as) on the leaver's mailboxes in the same change", async () => {
    const res = await remove("kim", { delegateTo: { userId: "lee", sendAs: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { userId: "kim", delegated: 2 } });
    expect(uow.state.memberships.some((m) => m.userId === "kim")).toBe(false);
    expect(uow.state.delegations.map((g) => [g.mailboxId, g.granteeUserId, g.right]).sort()).toEqual([
      [KIM_BOX, "lee", "full_access"],
      [KIM_BOX, "lee", "send_as"],
    ]);
  });

  it("400 for malformed JSON or unknown fields (never a removal without the hand-over that was asked for)", async () => {
    expect((await remove("kim", "{")).status).toBe(400);
    expect((await remove("kim", { delgateTo: { userId: "lee" } })).status).toBe(400);
    expect((await remove("kim", { delegateTo: { userId: "lee", sendAs: "yes" } })).status).toBe(400);
    expect(uow.state.memberships.some((m) => m.userId === "kim")).toBe(true);
  });

  it("403 for the hand-over without a fresh step-up, and nothing is removed", async () => {
    uow.state.stepUps = [];
    const res = await remove("kim", { delegateTo: { userId: "lee", sendAs: false } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("step_up_required");
    expect(uow.state.memberships.some((m) => m.userId === "kim")).toBe(true);
    // The removal alone needs no step-up.
    expect((await remove("kim")).status).toBe(200);
  });

  it("404 for someone in another account; 403 cross-origin", async () => {
    expect((await remove("owner-b", { delegateTo: { userId: "lee", sendAs: false } })).status).toBe(404);
    const cross = removeRoute(
      req("DELETE", `/api/accounts/${ACCOUNT}/people/kim`, undefined, "https://evil.example"),
      params({ accountId: ACCOUNT, userId: "kim" }),
    );
    expect((await cross).status).toBe(403);
  });
});
