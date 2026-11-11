// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Billing routes (ADR-0029 §9) and the dev simulation (§3) in memory with the fake provider: the overview, checkout
 * and portal answer per the matrix (403 / 404), map billing errors to their statuses, refuse cross-origin writes and
 * fail closed on the `billingProvider` tier; the simulate route drives the fake end to end through the real webhook,
 * and the three production guards each answer 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "@anhourmail/adapters/billing-fake";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { type Actor, ANONYMOUS, systemClock } from "@anhourmail/core";
import { syncAccountBilling } from "@anhourmail/core/billing";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { type Counter, memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { GET as overviewRoute } from "@/app/api/accounts/[accountId]/billing/route";
import { POST as checkoutRoute } from "@/app/api/accounts/[accountId]/billing/checkout/route";
import { POST as cancelRoute } from "@/app/api/accounts/[accountId]/billing/cancel/route";
import { POST as changeRoute } from "@/app/api/accounts/[accountId]/billing/change/route";
import { PUT as holdsRoute } from "@/app/api/accounts/[accountId]/billing/holds/route";
import { POST as portalRoute } from "@/app/api/accounts/[accountId]/billing/portal/route";
import { POST as previewRoute } from "@/app/api/accounts/[accountId]/billing/preview/route";
import { POST as refundRoute } from "@/app/api/accounts/[accountId]/billing/refund/route";
import { POST as undoRoute } from "@/app/api/accounts/[accountId]/billing/undo-cancel/route";
import { POST as simulateRoute } from "@/app/api/dev/billing/simulate/route";

import { type Container, setContainerForTests } from "./container";
import { devBilling } from "./dev-billing";
import { resetEnvForTests } from "./env";
import { devOnlyPath, routeHost } from "./host-routing";

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
const member = person("member-1", ACCOUNT, "member");
const outsider = person("outsider-1", OTHER, "owner");
let actor: Actor = owner;

const scheduled: string[] = [];
vi.mock("@/server/webmail/sending-pause-apply", () => ({
  scheduleSendingPause: (accountId: string) => {
    scheduled.push(accountId);
  },
}));

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

async function checkout(body: unknown = { plan: "plus", currency: "USD" }) {
  return checkoutRoute(post(`/api/accounts/${ACCOUNT}/billing/checkout`, body), params());
}

describe("billing routes", () => {
  it("overview: 200 for the Owner, 403 for a Member, 404 for an outsider, 401 signed out", async () => {
    const get = () => overviewRoute(new Request(`${APP}/api/accounts/${ACCOUNT}/billing`), params());
    const res = await get();
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ state: "free", available: true });
    actor = member;
    expect((await get()).status).toBe(403);
    actor = outsider;
    expect((await get()).status).toBe(404);
    actor = ANONYMOUS;
    expect((await get()).status).toBe(401);
  });

  it("checkout: the fake checkout URL, then 409 checkout_pending; 400 for a bad body", async () => {
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(String((await json(res)).data?.url)).toMatch(new RegExp(`^${APP}/dev/billing/checkout/cs_fake_`));
    const again = await checkout();
    expect(again.status).toBe(409);
    expect((await json(again)).error?.code).toBe("checkout_pending");
    expect((await checkout({})).status).toBe(400);
  });

  it("checkout: cross-origin writes are refused before the service runs", async () => {
    const res = await checkoutRoute(
      post(
        `/api/accounts/${ACCOUNT}/billing/checkout`,
        { plan: "plus", currency: "USD" },
        { origin: "https://evil.test" },
      ),
      params(),
    );
    expect(res.status).toBe(403);
    expect(uow.state.audit).toHaveLength(0);
  });

  it("checkout: 503 billing_unavailable with billing off; 403 / 404 per the matrix", async () => {
    useContainer(null);
    expect((await checkout()).status).toBe(503);
    useContainer(fake);
    actor = member;
    expect((await checkout()).status).toBe(403);
    actor = outsider;
    expect((await checkout()).status).toBe(404);
  });

  it("the billingProvider tier fails closed when the limiter is down", async () => {
    useContainer(fake, async () => {
      throw new Error("redis down");
    });
    expect((await checkout()).status).toBe(429);
    expect(uow.state.audit).toHaveLength(0);
  });

  it("portal: 409 not_subscribed without a customer, the fake portal after a checkout", async () => {
    const before = await portalRoute(post(`/api/accounts/${ACCOUNT}/billing/portal`, {}), params());
    expect(before.status).toBe(409);
    expect((await json(before)).error?.code).toBe("not_subscribed");
    await checkout();
    const res = await portalRoute(post(`/api/accounts/${ACCOUNT}/billing/portal`, {}), params());
    expect(res.status).toBe(200);
    expect(String((await json(res)).data?.url)).toMatch(new RegExp(`^${APP}/dev/billing/portal/cus_fake_`));
  });
});

describe("dev billing simulation (ADR-0029 §3)", () => {
  const simulate = (body: unknown) =>
    simulateRoute(post("/api/dev/billing/simulate", body), { params: Promise.resolve({}) });

  it("pays a fake checkout: the signed events go through the real webhook and queue the account's sync", async () => {
    const url = String((await json(await checkout())).data?.url);
    const sessionId = url.split("/").pop() ?? "";
    const res = await simulate({ action: "pay", sessionId });
    expect(res.status).toBe(200);
    const body = (await json(res)).data as { delivered: number; view: { subscription: { status: string } } };
    expect(body.delivered).toBeGreaterThanOrEqual(3);
    expect(body.view.subscription.status).toBe("active");
    expect(uow.state.billingEvents.map((e) => e.type)).toEqual(
      expect.arrayContaining(["checkout.session.completed", "customer.subscription.created", "invoice.paid"]),
    );
    expect(uow.state.billingEvents.every((e) => e.accountId === ACCOUNT)).toBe(true);
    expect(uow.state.jobs.some((j) => j.kind === "billing.sync" && j.subjectId === ACCOUNT)).toBe(true);
  });

  it("checks the body first (400), then who may drive the fake object (403 / 404 / 401)", async () => {
    expect((await simulate({})).status).toBe(400);
    expect((await simulate({ action: "pay" })).status).toBe(400);
    expect((await simulate({ action: "advance_clock", customerId: "cus_x" })).status).toBe(400);
    const url = String((await json(await checkout())).data?.url);
    const sessionId = url.split("/").pop() ?? "";
    actor = member;
    expect((await simulate({ action: "pay", sessionId })).status).toBe(403);
    actor = outsider;
    expect((await simulate({ action: "pay", sessionId })).status).toBe(404);
    actor = ANONYMOUS;
    expect((await simulate({ action: "pay", sessionId })).status).toBe(401);
    actor = owner;
    expect((await simulate({ action: "pay", sessionId: "cs_unknown" })).status).toBe(404);
  });

  it("answers the fake's own refusals with 409 (no open invoice)", async () => {
    const url = String((await json(await checkout())).data?.url);
    await simulate({ action: "pay", sessionId: url.split("/").pop() });
    const customerId = uow.state.billing.find((b) => b.accountId === ACCOUNT)?.providerCustomerId;
    const res = await simulate({ action: "pay_open_invoice", customerId });
    expect(res.status).toBe(409);
  });

  it("guard layer 2: 404 unless billing is the fake in a non-production process", async () => {
    useContainer(null);
    expect((await simulate({ action: "pay", sessionId: "cs_x" })).status).toBe(404);
    expect(devBilling()).toBeNull();
    useContainer(fake);
    expect(devBilling()).toBe(fake);
    vi.stubEnv("BILLING_PROVIDER", "off");
    resetEnvForTests();
    expect(devBilling()).toBeNull();
    expect((await simulate({ action: "pay", sessionId: "cs_x" })).status).toBe(404);
    vi.stubEnv("BILLING_PROVIDER", "fake");
    vi.stubEnv("NODE_ENV", "production");
    resetEnvForTests();
    expect(devBilling()).toBeNull();
    expect((await simulate({ action: "pay", sessionId: "cs_x" })).status).toBe(404);
  });

  it("guard layer 3: production builds never route /dev/ or /api/dev/, however written", () => {
    for (const path of [
      "/dev/billing/checkout/cs_1",
      "/dev/billing/portal/cus_1",
      "/api/dev/billing/simulate",
      "/dev",
      "/DEV/billing",
      "/%64ev/billing/portal/x",
      "//dev/billing/portal/x",
      "/api//dev/billing/simulate",
    ]) {
      expect(devOnlyPath(path)).toBe(true);
      for (const host of ["app.anhourmail.com", "mail.anhourmail.com", "localhost:43200"]) {
        expect(routeHost(host, path, true)).toEqual({ action: "not_found" });
      }
    }
    expect(devOnlyPath("/developers")).toBe(false);
    expect(devOnlyPath("/api/devices")).toBe(false);
    expect(routeHost("localhost:43200", "/dev/billing/checkout/cs_1", false, "43300")).toEqual({ action: "next" });
  });
});

describe("plan and add-on changes, cancel and refund routes (ADR-0029 §9)", () => {
  async function subscribe() {
    const url = String((await json(await checkout({ plan: "plus", currency: "USD", storageBlocks: 1 }))).data?.url);
    await simulateRoute(post("/api/dev/billing/simulate", { action: "pay", sessionId: url.split("/").pop() }), {
      params: Promise.resolve({}),
    });
    await syncAccountBilling({ uow, clock: systemClock, platform: PUBLIC_PLATFORM }, fake, ACCOUNT);
  }
  const call = (path: string, body: unknown = {}) =>
    (
      ({
        preview: previewRoute,
        change: changeRoute,
        cancel: cancelRoute,
        "undo-cancel": undoRoute,
        refund: refundRoute,
      }) as const
    )[path as "preview"](post(`/api/accounts/${ACCOUNT}/billing/${path}`, body), params());

  it("preview, then the change with the confirmed amount; 409 without it; 402 for a declined card", async () => {
    await subscribe();
    const preview = await call("preview", { storageBlocks: 2 });
    expect(preview.status).toBe(200);
    const { amountDueNowMinor } = (await json(preview)).data as { amountDueNowMinor: number };
    expect(amountDueNowMinor).toBeGreaterThan(0);
    const unconfirmed = await call("change", { storageBlocks: 2 });
    expect(unconfirmed.status).toBe(409);
    expect((await json(unconfirmed)).error?.code).toBe("confirmation_required");
    const customerId = uow.state.billing.find((b) => b.accountId === ACCOUNT)?.providerCustomerId ?? "";
    await fake.setCardFails(customerId, true);
    expect((await call("change", { storageBlocks: 2, confirmAmountMinor: amountDueNowMinor })).status).toBe(402);
    await fake.setCardFails(customerId, false);
    const done = await call("change", { storageBlocks: 2, confirmAmountMinor: amountDueNowMinor });
    expect(done.status).toBe(200);
    expect((await json(done)).data).toMatchObject({ billed: "now", amountDueNowMinor });
  });

  it("cancel and refund need a fresh step-up (403 step_up_required); 409 without a subscription", async () => {
    expect((await call("cancel")).status).toBe(409);
    expect((await call("refund")).status).toBe(409);
    expect((await call("preview", { storageBlocks: 1 })).status).toBe(409);
    await subscribe();
    const cancel = await call("cancel");
    expect(cancel.status).toBe(403);
    expect((await json(cancel)).error?.code).toBe("step_up_required");
    uow.state.stepUps.push({ userId: "owner-1", sessionId: SESSION, expiresAt: new Date("2099-01-01") });
    expect((await call("cancel")).status).toBe(200);
    await syncAccountBilling({ uow, clock: systemClock, platform: PUBLIC_PLATFORM }, fake, ACCOUNT);
    expect((await call("undo-cancel")).status).toBe(200);
    scheduled.length = 0;
    expect((await call("refund")).status).toBe(200);
    // The refund took billing's trust tier back: the managed scripts follow (ADR-0034, finding 2 of the review).
    expect(scheduled).toEqual([ACCOUNT]);
    expect((await uow.run((r) => r.trust.get(ACCOUNT)))?.tier).toBe("new");
    actor = member;
    expect((await call("refund")).status).toBe(403);
  });

  it("400 invalid_change for a mixed change; 400 for a bad body", async () => {
    await subscribe();
    const mixed = await call("change", { storageBlocks: 0, extraMailboxes: 2 });
    expect(mixed.status).toBe(400);
    expect((await json(mixed)).error?.code).toBe("invalid_change");
    expect((await call("change", { plan: 5 })).status).toBe(400);
  });
});

describe("Choose what stays on (ADR-0029 §6)", () => {
  const put = (body: unknown) =>
    holdsRoute(
      new Request(`${APP}/api/accounts/${ACCOUNT}/billing/holds`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: APP, host: "localhost:43200" },
        body: JSON.stringify(body),
      }),
      params(),
    );

  it("answers 400 invalid_change outside a lapse, 400 for a bad body, 403 / 404 per the matrix", async () => {
    const res = await put({});
    expect(res.status).toBe(400);
    expect((await json(res)).error?.code).toBe("invalid_change");
    expect((await put({ aliasIds: "x" })).status).toBe(400);
    actor = member;
    expect((await put({})).status).toBe(403);
    actor = outsider;
    expect((await put({})).status).toBe(404);
  });
});
