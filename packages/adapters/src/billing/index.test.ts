// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { createFakeBillingProvider, fakeWebhookSecret, memoryFakeBillingStore } from "../billing-fake";

import { billingRedirectOrigins, isFakeBillingProvider } from ".";

const T0 = new Date("2026-11-05T12:00:00Z");
const fake = () =>
  createFakeBillingProvider({
    store: memoryFakeBillingStore(),
    appUrl: "http://localhost:43200/",
    webhookSecret: fakeWebhookSecret("index-test"),
    clock: () => T0,
    nodeEnv: "test",
  });

describe("billingRedirectOrigins (ADR-0029 §2: no open redirect)", () => {
  it("allows the processor's hosted pages, the console's own origin for the fake, nothing when billing is off", () => {
    expect(billingRedirectOrigins(null, "http://localhost:43200")).toEqual([]);
    expect(billingRedirectOrigins(fake(), "http://localhost:43200/")).toEqual(["http://localhost:43200"]);
    const stripe = { ...fake(), kind: "stripe" as const };
    expect(billingRedirectOrigins(stripe, "https://app.example.test")).toEqual([
      "https://checkout.stripe.com",
      "https://billing.stripe.com",
    ]);
  });
});

describe("the fake's dev controls", () => {
  it("is told apart from the processor", () => {
    expect(isFakeBillingProvider(fake())).toBe(true);
    expect(isFakeBillingProvider(null)).toBe(false);
    expect(isFakeBillingProvider({ ...fake(), kind: "stripe" })).toBe(false);
  });

  it("describes a checkout and its customer for the dev pages, null for what it doesn't know", async () => {
    const p = fake();
    const { customerId } = await p.ensureCustomer({ accountId: "acc-1", email: "o@example.test", name: "O" });
    const { url } = await p.createCheckout({
      accountId: "acc-1",
      customerId,
      currency: "USD",
      plan: "plus",
      storageBlocks: 1,
      extraMailboxes: 0,
      successUrl: "x",
      cancelUrl: "y",
      intentId: "i-1",
    });
    const session = decodeURIComponent(url.split("/").pop() ?? "");
    const before = await p.describe("checkout", session);
    expect(before).toMatchObject({ accountId: "acc-1", customerId, cardFails: false, subscription: null });
    expect(before?.checkout).toMatchObject({ plan: "plus", storageBlocks: 1, open: true });
    expect(before?.checkout?.totalMinor).toBeGreaterThan(0);
    await p.completeCheckout(session, "pay");
    const after = await p.describe("customer", customerId);
    expect(after?.checkout).toBeNull();
    expect(after?.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: false, dispute: null });
    expect(after?.subscription?.latestInvoice?.status).toBe("paid");
    expect(await p.describe("checkout", "cs_unknown")).toBeNull();
    expect(await p.describe("customer", "cus_unknown")).toBeNull();
  });
});
