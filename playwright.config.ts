// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Committed e2e role journeys (`npm run test:e2e`), headless in CI. Expects the apps running
 * (`npm run dev` locally; CI starts built apps).
 */
import { defineConfig, devices } from "@playwright/test";

try {
  process.loadEnvFile(".env");
} catch {
  // CI provides the environment
}

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  // No traces in CI: they record typed passwords and request bodies, and CI artifacts are public. Locally they're kept
  // on failure for debugging.
  use: { trace: process.env.CI ? "off" : "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
      grepInvert: /@desktop-only/,
    },
  ],
});
