// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { billingProviderKind, billingSettingsProblems, stripeConfig } from "./config";

/** Shaped like real settings; not real values (none ever live in the repository). */
const stripe = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "development",
  BILLING_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: "rk_test_0000example",
  STRIPE_WEBHOOK_SECRET: "whsec_one, whsec_two",
  STRIPE_PRICE_PLUS: "price_plusNow,price_plusOld",
  STRIPE_PRICE_STORAGE_BLOCK: "price_storage",
  STRIPE_PRICE_EXTRA_MAILBOX: "price_extra",
  STRIPE_PRODUCT_SUPPORTER: "prod_supporter",
  ...over,
});

describe("billing settings (ADR-0029 §3)", () => {
  it("defaults: off in production, fake elsewhere; explicit values win (any case)", () => {
    expect(billingProviderKind({ NODE_ENV: "production" })).toBe("off");
    expect(billingProviderKind({ NODE_ENV: "development" })).toBe("fake");
    expect(billingProviderKind({ NODE_ENV: "test", BILLING_PROVIDER: "" })).toBe("fake");
    expect(billingProviderKind({ NODE_ENV: "production", BILLING_PROVIDER: " Stripe " })).toBe("stripe");
    expect(billingProviderKind({ NODE_ENV: "development", BILLING_PROVIDER: "off" })).toBe("off");
  });

  it("refuses an unknown provider and the fake in production", () => {
    expect(billingSettingsProblems({ BILLING_PROVIDER: "paypal" })).toEqual([
      "BILLING_PROVIDER must be off, fake or stripe",
    ]);
    expect(billingSettingsProblems({ NODE_ENV: "production", BILLING_PROVIDER: "fake" })).toEqual([
      "BILLING_PROVIDER=fake is for development and tests only: use off or stripe in production",
    ]);
    expect(billingSettingsProblems({ NODE_ENV: "development" })).toEqual([]);
    expect(billingSettingsProblems({ NODE_ENV: "production" })).toEqual([]);
  });

  it("a complete processor configuration passes and parses, lists first = current", () => {
    expect(billingSettingsProblems(stripe())).toEqual([]);
    expect(stripeConfig(stripe())).toEqual({
      secretKey: "rk_test_0000example",
      mode: "test",
      webhookSecrets: ["whsec_one", "whsec_two"],
      prices: {
        plus: ["price_plusNow", "price_plusOld"],
        storageBlock: ["price_storage"],
        extraMailbox: ["price_extra"],
      },
      supporterProduct: "prod_supporter",
      portalConfiguration: null,
    });
    expect(stripeConfig(stripe({ STRIPE_PORTAL_CONFIGURATION: "bpc_123" })).portalConfiguration).toBe("bpc_123");
  });

  it("key mode must agree with production unless test keys are allowed (pre-staging)", () => {
    const prod = { NODE_ENV: "production" };
    expect(billingSettingsProblems(stripe(prod))).toEqual([
      "STRIPE_SECRET_KEY is a test key in production: set BILLING_ALLOW_TEST_KEYS=true only for pre-staging",
    ]);
    expect(billingSettingsProblems(stripe({ ...prod, BILLING_ALLOW_TEST_KEYS: "true" }))).toEqual([]);
    expect(billingSettingsProblems(stripe({ ...prod, STRIPE_SECRET_KEY: "sk_live_0000example" }))).toEqual([]);
    expect(stripeConfig(stripe({ ...prod, STRIPE_SECRET_KEY: "sk_live_0000example" })).mode).toBe("live");
    expect(billingSettingsProblems(stripe({ STRIPE_SECRET_KEY: "rk_live_0000example" }))).toEqual([
      "STRIPE_SECRET_KEY is a live key outside production: use a test key",
    ]);
  });

  it("names every missing or malformed setting, never a value", () => {
    const problems = billingSettingsProblems(
      stripe({
        STRIPE_SECRET_KEY: "pk_test_publishable",
        STRIPE_WEBHOOK_SECRET: "not-a-secret",
        STRIPE_PRICE_PLUS: "",
        STRIPE_PRICE_STORAGE_BLOCK: "prod_wrong",
        STRIPE_PRICE_EXTRA_MAILBOX: "price_../x",
        STRIPE_PRODUCT_SUPPORTER: "price_wrong",
        STRIPE_PORTAL_CONFIGURATION: "conf_x",
      }),
    );
    expect(problems).toEqual([
      "STRIPE_SECRET_KEY must be a secret or restricted key (sk_… or rk_…)",
      "STRIPE_WEBHOOK_SECRET must be webhook signing secrets (whsec_…)",
      "Set STRIPE_PRICE_PLUS (price ids, first = current)",
      "STRIPE_PRICE_STORAGE_BLOCK must be price ids (price_…)",
      "STRIPE_PRICE_EXTRA_MAILBOX must be price ids (price_…)",
      "STRIPE_PRODUCT_SUPPORTER must be a product id (prod_…)",
      "STRIPE_PORTAL_CONFIGURATION must be a portal configuration id (bpc_…) or unset",
    ]);
    expect(problems.join(" ")).not.toContain("pk_test_publishable");
    expect(
      billingSettingsProblems({ NODE_ENV: "development", BILLING_PROVIDER: "stripe" }).filter((p) =>
        p.startsWith("Set"),
      ),
    ).toHaveLength(6);
  });

  it("stripeConfig refuses anything but a complete processor configuration", () => {
    expect(() => stripeConfig({ NODE_ENV: "development" })).toThrow(/BILLING_PROVIDER is not stripe/);
    expect(() => stripeConfig(stripe({ STRIPE_WEBHOOK_SECRET: "" }))).toThrow(/Set STRIPE_WEBHOOK_SECRET/);
  });
});
