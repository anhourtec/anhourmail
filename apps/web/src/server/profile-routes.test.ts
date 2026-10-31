// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The profile routes (`/api/me/profile`, People "Edit profile"): a body that isn't the expected shape is a 400 and
 * changes nothing — never read as "no details", which would clear every field — and 401 still comes first when signed
 * out. In memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, ANONYMOUS, systemClock, type UserActor } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { PUT as putPersonProfile } from "@/app/api/accounts/[accountId]/people/[userId]/profile/route";
import { PUT as putOwnProfile } from "@/app/api/me/profile/route";

import { setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const PHC = `$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$${"a".repeat(43)}`;

const owner: UserActor = {
  kind: "user",
  userId: "owner",
  email: "owner@family.test",
  platformRoles: [],
  memberships: [{ accountId: ACCOUNT, role: "owner" }],
  suspended: false,
};
const kim: UserActor = {
  ...owner,
  userId: "kim",
  email: "kim@family.test",
  memberships: [{ accountId: ACCOUNT, role: "member" }],
};
let actor: Actor = owner;

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" ? "s1" : null }),
}));

let uow: MemoryUnitOfWork;
const DETAILS = { jobTitle: "Engineer", city: "Halifax" };

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
  s.accounts.push({ id: ACCOUNT, name: "Family", plan: "plus" });
  for (const [userId, role, name] of [
    ["owner", "owner", "Olive Owner"],
    ["kim", "member", "Kim Member"],
  ] as const) {
    s.memberships.push({ userId, accountId: ACCOUNT, role });
    s.userEmails[userId] = `${userId}@family.test`;
    s.userNames[userId] = name;
    s.profiles[userId] = { ...DETAILS };
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

const req = (path: string, body: unknown) =>
  new Request(`http://localhost:43200${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", host: "localhost:43200", origin: "http://localhost:43200" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const own = (body: unknown) => putOwnProfile(req("/api/me/profile", body), { params: Promise.resolve({}) });
const person = (userId: string, body: unknown) =>
  putPersonProfile(req(`/api/accounts/${ACCOUNT}/people/${userId}/profile`, body), {
    params: Promise.resolve({ accountId: ACCOUNT, userId }),
  });
const error = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

const BAD_BODIES: [string, unknown][] = [
  ["a name over 400 characters", { name: "x".repeat(401) }],
  ["a name that isn't a string", { name: 42 }],
  ["a detail over 400 characters", { profile: { jobTitle: "x".repeat(401) } }],
  ["details that aren't an object", { profile: "clear" }],
  ["a body that isn't an object", [1, 2]],
];

describe("profile routes: a malformed body", () => {
  it.each(BAD_BODIES)("own profile: %s is a 400 and changes nothing", async (_label, body) => {
    const res = await own(body);
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe("bad_request");
    expect(uow.state.profiles.owner).toEqual(DETAILS);
    expect(uow.state.userNames.owner).toBe("Olive Owner");
    expect(uow.state.audit.filter((e) => e.action === "account.profile_changed")).toEqual([]);
  });

  it.each(BAD_BODIES)("a person's profile: %s is a 400 and changes nothing", async (_label, body) => {
    const res = await person("kim", body);
    expect(res.status).toBe(400);
    expect((await error(res)).code).toBe("bad_request");
    expect(uow.state.profiles.kim).toEqual(DETAILS);
    expect(uow.state.userNames.kim).toBe("Kim Member");
  });

  it("says when the name is too long", async () => {
    expect((await error(await own({ name: "x".repeat(401) }))).message).toBe("That name is too long.");
    expect((await error(await person("kim", { name: "x".repeat(401) }))).message).toBe("That name is too long.");
    expect((await error(await own({ profile: "clear" }))).message).toBe("Check the profile details and try again.");
  });

  it("signed out is still a 401 first, and a good body still saves", async () => {
    actor = ANONYMOUS;
    expect((await own({ name: 42 })).status).toBe(401);
    expect((await person("kim", { name: 42 })).status).toBe(401);
    actor = kim;
    const res = await own({ name: "Kim Lee" });
    expect(res.status).toBe(200);
    expect(uow.state.userNames.kim).toBe("Kim Lee");
    expect(uow.state.profiles.kim).toEqual(DETAILS);
    actor = owner;
    expect((await person("kim", { profile: { city: "Truro" } })).status).toBe(200);
    expect(uow.state.profiles.kim).toEqual({ city: "Truro" });
  });
});
