// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { LIMITS, memoryCounter } from "@anhourmail/server/rate-limit";

import { confirmationEmailAllowed } from "./confirmation-cap";

describe("confirmation emails per address", () => {
  it("allows the daily cap per address (case and spaces don't make a new one), then refuses", async () => {
    const counter = memoryCounter();
    const now = Date.now();
    for (let i = 0; i < LIMITS.emailVerificationAddress.limit; i++) {
      await expect(
        confirmationEmailAllowed(counter, i % 2 ? " Victim@Example.org " : "victim@example.org", now),
      ).resolves.toBe("allowed");
    }
    await expect(confirmationEmailAllowed(counter, "victim@example.org", now)).resolves.toBe("address_daily_cap");
    // Another address has its own allowance; the next day the first one has its allowance again.
    await expect(confirmationEmailAllowed(counter, "other@example.org", now)).resolves.toBe("allowed");
    await expect(confirmationEmailAllowed(counter, "victim@example.org", now + 86_400_000 + 1000)).resolves.toBe(
      "allowed",
    );
  });

  it("fails closed when the counter is down", async () => {
    const down = () => Promise.reject(new Error("redis down"));
    await expect(confirmationEmailAllowed(down, "a@example.org")).resolves.toBe("limiter_unavailable");
  });
});
