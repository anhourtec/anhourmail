// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The billing webhook route (ADR-0029 §4) in memory with the fake provider: 404 while billing is off, 413 over the
 * 512 KiB cap (declared or streamed), 400 `bad_signature` logged with the reason only, a verified event recorded once
 * with its account's sync queued (no browser origin needed), duplicates answered 200 with nothing new, and a database
 * failure answered 500 so the provider retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeBillingProvider,
  fakeWebhookSecret,
  memoryFakeBillingStore,
} from "@anhourmail/adapters/billing-fake";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { systemClock } from "@anhourmail/core";
import { defaultBilling } from "@anhourmail/core/billing";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { POST } from "@/app/api/billing/webhook/route";

import { WEBHOOK_MAX_BYTES } from "./billing-webhook";
import { type Container, setContainerForTests } from "./container";
import { resetEnvForTests } from "./env";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const provider = () =>
  createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: "http://localhost:43200",
    webhookSecret: fakeWebhookSecret("route-test"),
    nodeEnv: "test",
  });

let uow: MemoryUnitOfWork;
let logs: Record<string, unknown>[];
let fake: ReturnType<typeof provider>;

function useContainer(billing: Container["billing"] | undefined) {
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: memoryBreachedPasswords(),
    ...(billing === undefined ? {} : { billing }),
  });
}

beforeEach(async () => {
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
  uow.state.accounts.push({ id: ACCOUNT, name: "Acme", plan: "free" });
  fake = provider();
  const { customerId } = await fake.ensureCustomer({ accountId: ACCOUNT, email: "o@example.test", name: "O" });
  uow.state.billing.push({ ...defaultBilling(ACCOUNT, "free", new Date()), providerCustomerId: customerId });
  useContainer(fake);
  logs = [];
  setLogSinkForTests((line) => {
    logs.push(JSON.parse(line) as Record<string, unknown>);
  });
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

/** A server-to-server POST: no Origin header, like the provider's. */
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost:43200/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:43200", ...headers },
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    }),
    { params: Promise.resolve({}) },
  );

async function paidCheckout() {
  const { customerId } = await fake.ensureCustomer({ accountId: ACCOUNT, email: "o@example.test", name: "O" });
  const { url } = await fake.createCheckout({
    accountId: ACCOUNT,
    customerId,
    currency: "USD",
    plan: "plus",
    storageBlocks: 0,
    extraMailboxes: 0,
    successUrl: "http://localhost/s",
    cancelUrl: "http://localhost/c",
    intentId: "intent-1",
  });
  await fake.completeCheckout(decodeURIComponent(url.split("/").pop() ?? ""), "pay");
  return fake.drainDeliveries();
}

describe("POST /api/billing/webhook", () => {
  it("records a verified event once and queues the account's sync; a redelivery is answered 200 with nothing new", async () => {
    const [first, ...rest] = await paidCheckout();
    if (!first) throw new Error("no delivery");
    const res = await post(first.body, { "stripe-signature": first.signature });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { received: true } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const d of rest) expect((await post(d.body, { "stripe-signature": d.signature })).status).toBe(200);
    expect((await post(first.body, { "stripe-signature": first.signature })).status).toBe(200);
    expect(uow.state.billingEvents).toHaveLength(3);
    expect(uow.state.billingEvents.every((e) => e.accountId === ACCOUNT && e.status === "queued")).toBe(true);
    expect(uow.state.jobs.filter((j) => j.kind === "billing.sync")).toHaveLength(1);
    // No payload is stored and nothing is audited by ingestion.
    expect(Object.keys(uow.state.billingEvents[0] ?? {})).not.toContain("payload");
    expect(uow.state.audit).toEqual([]);
  });

  it("400 bad_signature for a missing, wrong or tampered signature; logged with the reason, never the body", async () => {
    const [first] = await paidCheckout();
    if (!first) throw new Error("no delivery");
    const missing = await post(first.body);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("bad_signature");
    const tampered = await post(`${first.body} `, { "stripe-signature": first.signature });
    expect(tampered.status).toBe(400);
    const wrong = await post(first.body, { "stripe-signature": "t=1,v1=00" });
    expect(wrong.status).toBe(400);
    expect(uow.state.billingEvents).toEqual([]);
    const rejected = logs.filter((r) => r.msg === "billing webhook rejected");
    expect(rejected.map((r) => r.reason)).toEqual([
      "missing_header",
      "no_matching_signature",
      "timestamp_out_of_tolerance",
    ]);
    const all = JSON.stringify(logs);
    expect(all).not.toContain(first.signature);
    expect(all).not.toContain("cus_fake");
  });

  it("413 over the cap, whether declared or streamed without a length", async () => {
    const big = "x".repeat(WEBHOOK_MAX_BYTES + 1);
    expect((await post(big, { "stripe-signature": "t=1,v1=00" })).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(64 * 1024));
        c.close();
      },
    });
    expect((await post(stream, { "stripe-signature": "t=1,v1=00" })).status).toBe(413);
    expect(uow.state.billingEvents).toEqual([]);
  });

  it("404 while billing is off", async () => {
    useContainer(null);
    expect((await post("{}", { "stripe-signature": "t=1,v1=00" })).status).toBe(404);
    useContainer(undefined);
    expect((await post("{}", { "stripe-signature": "t=1,v1=00" })).status).toBe(404);
  });

  it("a database failure answers 500 so the provider retries", async () => {
    const [first] = await paidCheckout();
    if (!first) throw new Error("no delivery");
    vi.spyOn(uow, "run").mockRejectedValueOnce(new Error("database down"));
    expect((await post(first.body, { "stripe-signature": first.signature })).status).toBe(500);
    expect((await post(first.body, { "stripe-signature": first.signature })).status).toBe(200);
    expect(uow.state.billingEvents).toHaveLength(1);
  });
});
