// SPDX-License-Identifier: AGPL-3.0-only
/** Integration tests (`npm run test:int`): real Postgres/Redis/Stalwart/Mailpit from docker-compose (dev or ci profile). */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    env: process.env.TEST_DATABASE_URL ? {} : loadDotEnv(),
  },
});

function loadDotEnv(): Record<string, string> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // CI provides the environment
  }
  return {};
}
