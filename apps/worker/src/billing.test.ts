// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { checkBillingSettings } from "./billing";

describe("worker billing settings (ADR-0029 §3)", () => {
  it("starts with billing off in production and the fake in development", () => {
    expect(() => {
      checkBillingSettings({ NODE_ENV: "production" });
    }).not.toThrow();
    expect(() => {
      checkBillingSettings({ NODE_ENV: "development", BILLING_PROVIDER: "fake" });
    }).not.toThrow();
  });

  it("refuses the fake provider in production", () => {
    expect(() => {
      checkBillingSettings({ NODE_ENV: "production", BILLING_PROVIDER: "fake" });
    }).toThrow(/Worker configuration refused: BILLING_PROVIDER=fake is for development and tests only/);
  });
});
