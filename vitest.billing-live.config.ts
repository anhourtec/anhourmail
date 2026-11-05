// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The billing live suite (`npm run test:billing-live`; ADR-0029 §10, slice 14): the payment processor's test mode with
 * test clocks, manual and local only. Reads the local `.env`; every test skips without `STRIPE_SECRET_KEY` and the run
 * aborts with a live key. Not part of `npm test`, `test:int` or CI (none of them include `tests/billing-live`).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/billing-live/**/*.live.test.ts"],
    environment: "node",
    // Test clocks advance asynchronously: a case can take minutes.
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
    // One case at a time: each makes and deletes its own test clock, and the processor rate-limits test mode too.
    fileParallelism: false,
    sequence: { concurrent: false },
    env: loadDotEnv(),
  },
});

function loadDotEnv(): Record<string, string> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env: nothing to run with (the suite skips).
  }
  return {};
}
