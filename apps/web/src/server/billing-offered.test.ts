// SPDX-License-Identifier: AGPL-3.0-only
/**
 * When paid plans may be bought (ADR-0029 §3, run-67 N3): billing on, and `BILLING.status` open or a test setup (the
 * dev fake, the processor with test keys). The same rule drives the Billing page and the services' `paidPlansOpen`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { billingOffered, paidPlansOffered } from "./billing";
import { resetEnvForTests } from "./env";

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
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe("billingOffered", () => {
  it("offers the dev fake while planned, and nothing with billing off", () => {
    vi.stubEnv("BILLING_PROVIDER", "fake");
    expect(billingOffered("planned", true)).toEqual({ offered: true, test: true });
    expect(billingOffered("planned", false).offered).toBe(false);
  });

  it("with the processor: test keys are offered while planned, live keys only once open", () => {
    const stripe = (key: string) => ({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: key, NODE_ENV: "production" });
    expect(paidPlansOffered("planned", true, stripe("rk_test_abc123"))).toEqual({ offered: true, test: true });
    expect(paidPlansOffered("planned", true, stripe("rk_live_abc123"))).toEqual({ offered: false, test: false });
    expect(paidPlansOffered("open", true, stripe("rk_live_abc123"))).toEqual({ offered: true, test: false });
    expect(paidPlansOffered("open", false, stripe("rk_live_abc123")).offered).toBe(false);
    // Unset in production means billing off.
    expect(paidPlansOffered("planned", true, { NODE_ENV: "production" }).offered).toBe(false);
  });
});
