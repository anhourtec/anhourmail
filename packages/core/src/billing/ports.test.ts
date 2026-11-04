// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { BILLING_EVENT_STATUSES, BILLING_STATES, HOLD_SUBJECTS, INVOICE_STATUSES, PLAN_SOURCES } from "./entity";
import {
  BillingProviderError,
  DISPUTE_EVENT_TYPES,
  HANDLED_EVENT_TYPES,
  isLiveSubStatus,
  PROVIDER_SUB_STATUSES,
  WebhookRejected,
} from "./ports";

describe("billing port types", () => {
  it("only our outage or theirs is retryable", () => {
    expect(new BillingProviderError("unavailable", "x").retryable).toBe(true);
    expect(new BillingProviderError("rate_limited", "x").retryable).toBe(true);
    for (const code of [
      "card_declined",
      "invalid_request",
      "not_found",
      "catalogue_drift",
      "multiple_subscriptions",
    ] as const) {
      expect(new BillingProviderError(code, "x").retryable).toBe(false);
    }
    expect(new BillingProviderError("not_found", "gone")).toMatchObject({
      name: "BillingProviderError",
      message: "gone",
    });
  });

  it("a rejected webhook carries the reason only", () => {
    const err = new WebhookRejected("timestamp_out_of_tolerance");
    expect(err).toMatchObject({ name: "WebhookRejected", reason: "timestamp_out_of_tolerance" });
    expect(err.message).toBe("webhook rejected: timestamp_out_of_tolerance");
  });

  it("cancelled and expired subscriptions are terminal; the rest are live", () => {
    expect(PROVIDER_SUB_STATUSES.filter(isLiveSubStatus)).toEqual([
      "active",
      "past_due",
      "unpaid",
      "incomplete",
      "paused",
      "trialing",
    ]);
  });

  it("the handled event set and the stored enums match the ADR", () => {
    expect(HANDLED_EVENT_TYPES).toHaveLength(13);
    expect(HANDLED_EVENT_TYPES).toContain("charge.dispute.created");
    // Dispute events name a payment, not a customer: ingestion resolves them through getDispute.
    expect(DISPUTE_EVENT_TYPES.every((t) => HANDLED_EVENT_TYPES.includes(t))).toBe(true);
    expect(BILLING_STATES).toEqual(["free", "active", "past_due", "restricted", "lapsed"]);
    expect(PLAN_SOURCES).toEqual(["none", "stripe", "comp", "staff"]);
    expect(INVOICE_STATUSES).toEqual(["paid", "open", "uncollectible", "void"]);
    expect(BILLING_EVENT_STATUSES).toEqual(["queued", "processed", "orphan", "dismissed"]);
    expect(HOLD_SUBJECTS).toEqual(["mailbox", "domain", "alias"]);
  });
});
