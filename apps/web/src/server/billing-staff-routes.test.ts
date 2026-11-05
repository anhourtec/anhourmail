// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Slice 12 routes (ADR-0029 §8, §9) in memory with the fake provider: redeeming a comp code on the Billing page (the
 * one 404 for any wrong code, permission and scope, the per-address tier failing closed), staff grants and ending them,
 * the staff refund, and invite codes (create shown once, revoke), each answering per the matrix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "@anhourmail/adapters/billing-fake";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { type Counter, memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { POST as redeemRoute } from "@/app/api/accounts/[accountId]/billing/redeem/route";
import {
  DELETE as endGrantRoute,
  PUT as grantRoute,
} from "@/app/api/platform/accounts/[accountId]/billing/grant/route";
import { POST as clearDisputesRoute } from "@/app/api/platform/accounts/[accountId]/billing/disputes/clear/route";
import { POST as staffRefundRoute } from "@/app/api/platform/accounts/[accountId]/billing/refund/route";
import { POST as resyncRoute } from "@/app/api/platform/accounts/[accountId]/billing/resync/route";
import { POST as dismissOrphanRoute } from "@/app/api/platform/billing/orphans/[eventId]/dismiss/route";
import { POST as createCodeRoute } from "@/app/api/platform/invite-codes/route";
import { DELETE as revokeCodeRoute } from "@/app/api/platform/invite-codes/[codeId]/route";

import { type Container, setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const APP = "http://localhost:43200";
const SESSION = "session-1";

const person = (id: string, accountId: string, role: "owner" | "member" | "billing_admin"): Actor => ({
  kind: "user",
  userId: id,
  email: `${id}@example.test`,
  platformRoles: [],
  memberships: [{ accountId, role }],
  suspended: false,
});
const owner = person("owner-1", ACCOUNT, "owner");
const billingStaff: Actor = {
  kind: "user",
  userId: "staff-billing",
  email: "staff-billing@example.test",
  platformRoles: ["billing_admin"],
  memberships: [],
  suspended: false,
};
const support: Actor = { ...billingStaff, userId: "staff-support", platformRoles: ["support_admin"] };
const member = person("member-1", ACCOUNT, "member");
const outsider = person("outsider-1", OTHER, "owner");
let actor: Actor = owner;

vi.mock("@/server/auth/actor", () => ({
  getActor: async () => actor,
  getActorAndSession: async () => ({ actor, sessionId: actor.kind === "user" ? SESSION : null }),
}));

let uow: MemoryUnitOfWork;
let fake: ReturnType<typeof createFakeBillingProvider>;

function useContainer(billing: Container["billing"] | undefined, counter: Counter = memoryCounter()) {
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter,
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: memoryBreachedPasswords(),
    ...(billing === undefined ? {} : { billing }),
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", APP);
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  vi.stubEnv("BILLING_PROVIDER", "fake");
  resetEnvForTests();
  uow = new MemoryUnitOfWork();
  uow.state.accounts.push({ id: ACCOUNT, name: "Acme", plan: "free" });
  uow.state.accounts.push({ id: OTHER, name: "Other", plan: "free" });
  fake = createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: APP,
    webhookSecret: fakeWebhookSecret("billing-routes-test"),
    nodeEnv: "test",
  });
  useContainer(fake);
  actor = owner;
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const params = (accountId = ACCOUNT) => ({ params: Promise.resolve({ accountId }) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${APP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP, host: "localhost:43200", ...headers },
    body: JSON.stringify(body),
  });
const json = async (res: Response) =>
  (await res.json()) as { data?: Record<string, unknown>; error?: { code: string } };

const del = (path: string) =>
  new Request(`${APP}${path}`, { method: "DELETE", headers: { origin: APP, host: "localhost:43200" } });
const put = (path: string, body: unknown) =>
  new Request(`${APP}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: APP, host: "localhost:43200" },
    body: JSON.stringify(body),
  });

function staffReady() {
  for (const a of [billingStaff, support, owner]) {
    if (a.kind === "user") {
      uow.state.userEmails[a.userId] = a.email;
      uow.state.stepUps.push({ userId: a.userId, sessionId: SESSION, expiresAt: new Date("2099-01-01") });
    }
  }
}

async function compCode(): Promise<string> {
  staffReady();
  actor = billingStaff;
  const res = await createCodeRoute(
    post("/api/platform/invite-codes", { compPlan: "plus", compDays: 30, expiresInDays: 10 }),
    {
      params: Promise.resolve({}),
    },
  );
  expect(res.status).toBe(200);
  return String((await json(res)).data?.code);
}

describe("POST /api/accounts/:id/billing/redeem", () => {
  it("redeems a comp code for an Owner; any wrong code is the same 404; members 403, outsiders 404", async () => {
    const code = await compCode();
    actor = owner;
    const wrong = await redeemRoute(
      post(`/api/accounts/${ACCOUNT}/billing/redeem`, { code: "0000-0000-0000-0000-0000-0000-0000-0000" }),
      params(),
    );
    expect(wrong.status).toBe(404);
    expect((await json(wrong)).error?.code).toBe("invite_code_invalid");
    actor = member;
    expect((await redeemRoute(post(`/api/accounts/${ACCOUNT}/billing/redeem`, { code }), params())).status).toBe(403);
    actor = outsider;
    expect((await redeemRoute(post(`/api/accounts/${ACCOUNT}/billing/redeem`, { code }), params())).status).toBe(404);
    actor = owner;
    const ok = await redeemRoute(post(`/api/accounts/${ACCOUNT}/billing/redeem`, { code }), params());
    expect(ok.status).toBe(200);
    expect((await json(ok)).data).toMatchObject({ plan: "plus" });
  });

  it("the per-address tier fails closed when the limiter is down", async () => {
    const down: Counter = { incr: async () => Promise.reject(new Error("redis down")) } as unknown as Counter;
    useContainer(fake, down);
    const res = await redeemRoute(
      post(`/api/accounts/${ACCOUNT}/billing/redeem`, { code: "0000-0000-0000-0000-0000-0000-0000-0000" }),
      params(),
    );
    expect(res.status).toBe(429);
  });
});

describe("staff billing routes", () => {
  it("grant and end: billing staff only; unknown accounts 404", async () => {
    staffReady();
    actor = support;
    expect(
      (await grantRoute(put(`/api/platform/accounts/${ACCOUNT}/billing/grant`, { plan: "plus" }), params())).status,
    ).toBe(403);
    actor = billingStaff;
    expect(
      (
        await grantRoute(
          put(`/api/platform/accounts/${OTHER.replace("2222", "3333")}/billing/grant`, { plan: "plus" }),
          params(OTHER.replace("2222", "3333")),
        )
      ).status,
    ).toBe(404);
    const granted = await grantRoute(
      put(`/api/platform/accounts/${ACCOUNT}/billing/grant`, { plan: "plus", days: 30 }),
      params(),
    );
    expect(granted.status).toBe(200);
    expect((await json(granted)).data).toMatchObject({ state: "active", plan: "plus" });
    expect((await endGrantRoute(del(`/api/platform/accounts/${ACCOUNT}/billing/grant`), params())).status).toBe(200);
    expect((await endGrantRoute(del(`/api/platform/accounts/${ACCOUNT}/billing/grant`), params())).status).toBe(409);
  });

  it("staff refund: 409 for an account that never paid, 403 for customers", async () => {
    staffReady();
    actor = billingStaff;
    expect(
      (await staffRefundRoute(post(`/api/platform/accounts/${ACCOUNT}/billing/refund`, {}), params())).status,
    ).toBe(409);
    actor = owner;
    expect(
      (await staffRefundRoute(post(`/api/platform/accounts/${ACCOUNT}/billing/refund`, {}), params())).status,
    ).toBe(403);
  });

  it("invite codes: created once by the right staff, 400 without an expiry, revoked once", async () => {
    staffReady();
    actor = support;
    const none = { params: Promise.resolve({}) };
    expect((await createCodeRoute(post("/api/platform/invite-codes", {}), none)).status).toBe(400);
    expect(
      (
        await createCodeRoute(
          post("/api/platform/invite-codes", { compPlan: "plus", compDays: 3, expiresInDays: 3 }),
          none,
        )
      ).status,
    ).toBe(403);
    const made = await createCodeRoute(
      post("/api/platform/invite-codes", { grantsSignup: true, expiresInDays: 3 }),
      none,
    );
    expect(made.status).toBe(200);
    const list = await uow.run((r) => r.inviteCodes.list(10));
    const codeId = list[0]?.id ?? "";
    const revoke = () =>
      revokeCodeRoute(del(`/api/platform/invite-codes/${codeId}`), { params: Promise.resolve({ codeId }) });
    expect((await revoke()).status).toBe(200);
    expect((await revoke()).status).toBe(409);
    actor = owner;
    expect(
      (await createCodeRoute(post("/api/platform/invite-codes", { grantsSignup: true, expiresInDays: 3 }), none))
        .status,
    ).toBe(403);
  });

  it("clear disputes: 409 when nothing is disputed, 404 for unknown accounts, 403 for other staff and customers", async () => {
    staffReady();
    actor = billingStaff;
    const clear = (accountId = ACCOUNT) =>
      clearDisputesRoute(
        post(`/api/platform/accounts/${accountId}/billing/disputes/clear`, { disputeIds: [] }),
        params(accountId),
      );
    const res = await clear();
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("not_disputed");
    expect((await clear(OTHER.replace("2222", "3333"))).status).toBe(404);
    actor = support;
    expect((await clear()).status).toBe(403);
    actor = owner;
    expect((await clear()).status).toBe(403);
  });

  it("re-sync now: queues the account's sync for billing staff; 503 with billing off", async () => {
    staffReady();
    actor = billingStaff;
    const res = await resyncRoute(post(`/api/platform/accounts/${ACCOUNT}/billing/resync`, {}), params());
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ queued: true });
    expect(uow.state.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT)).toBe(true);
    actor = member;
    expect((await resyncRoute(post(`/api/platform/accounts/${ACCOUNT}/billing/resync`, {}), params())).status).toBe(
      403,
    );
    actor = billingStaff;
    useContainer(undefined);
    expect((await resyncRoute(post(`/api/platform/accounts/${ACCOUNT}/billing/resync`, {}), params())).status).toBe(
      503,
    );
  });

  it("dismiss an orphan: once for billing staff, then 404; unknown ids 404; customers 403", async () => {
    staffReady();
    const eventId =
      (await uow.run((r) =>
        r.billing.recordEvent({
          providerEventId: "evt_unmatched",
          type: "invoice.paid",
          accountId: null,
          objectId: "in_unknown",
          providerCreatedAt: new Date(),
          receivedAt: new Date(),
        }),
      )) ?? "";
    const dismiss = (id: string) =>
      dismissOrphanRoute(post(`/api/platform/billing/orphans/${id}/dismiss`, {}), {
        params: Promise.resolve({ eventId: id }),
      });
    actor = owner;
    expect((await dismiss(eventId)).status).toBe(403);
    actor = billingStaff;
    expect((await dismiss(OTHER)).status).toBe(404);
    expect((await dismiss(eventId)).status).toBe(200);
    expect((await dismiss(eventId)).status).toBe(404);
  });
});
