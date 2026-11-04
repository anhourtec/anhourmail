// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { redis as shared } from "@anhourmail/server/redis";

import { createFakeBillingProvider, redisFakeBillingStore } from ".";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is not set (integration tests need the compose stack)");
const redis = shared();
const prefixes: string[] = [];
afterAll(async () => {
  for (const p of prefixes) await redis.del(`${p}:state`, `${p}:version`);
  await redis.quit();
});

const freshStore = () => {
  const prefix = `am:test:billing-fake:${randomUUID()}`;
  prefixes.push(prefix);
  return redisFakeBillingStore(redis, prefix);
};

describe("redis fake billing store (dev: the web app and the worker share one fake)", () => {
  it("20 concurrent updates all land (compare-and-set retries, nothing lost)", async () => {
    const store = freshStore();
    await Promise.all(Array.from({ length: 20 }, () => store.update((s) => (s.seq += 1))));
    expect((await store.read()).seq).toBe(20);
  });

  it("a throwing update writes nothing", async () => {
    const store = freshStore();
    await store.update((s) => (s.offsetMs = 5));
    await expect(
      store.update((s) => {
        s.offsetMs = 99;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await store.read()).offsetMs).toBe(5);
  });

  it("two providers on one store see the same customers and subscriptions", async () => {
    const store = freshStore();
    const opts = { store, appUrl: "http://localhost:43200", webhookSecret: "whsec_dev_test", nodeEnv: "test" };
    const web = createFakeBillingProvider(opts);
    const worker = createFakeBillingProvider(opts);
    const accountId = randomUUID();
    const { customerId } = await web.ensureCustomer({ accountId, email: "a@example.test", name: "A" });
    const { url } = await web.createCheckout({
      accountId,
      customerId,
      currency: "USD",
      plan: "plus",
      storageBlocks: 0,
      extraMailboxes: 0,
      successUrl: "s",
      cancelUrl: "c",
      intentId: randomUUID(),
    });
    await web.completeCheckout(url.split("/").pop() ?? "", "pay");
    expect((await worker.getSubscription(customerId))?.status).toBe("active");
    expect(await worker.drainDeliveries()).toHaveLength(3);
    expect(await web.drainDeliveries()).toEqual([]);
  });
});
