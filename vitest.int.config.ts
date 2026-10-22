// SPDX-License-Identifier: AGPL-3.0-only
/** Integration tests (`npm run test:int`): real Postgres/Redis/Stalwart/Mailpit from docker-compose (dev or ci profile). */
import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // Next's guard package throws outside a server component bundle; tests import server modules directly.
      { find: "server-only", replacement: path.resolve(import.meta.dirname, "tests/unit/server-only.ts") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    // Suites share the test database and the dev Stalwart: run files one at a time.
    fileParallelism: false,
    globalSetup: ["scripts/test-int-setup.ts"],
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
