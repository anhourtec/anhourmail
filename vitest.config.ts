// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests (CLAUDE.md rule 39): fast, no network, memory adapters. `npm test` enforces coverage —
 * 90% for the domain core and the RBAC matrix, 80% overall. Integration tests live in *.int.test.ts and run
 * with vitest.int.config.ts against the compose stack.
 */
import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: path.resolve(import.meta.dirname, "apps/web/src/$1") },
      // Next's guard package throws outside a server component bundle; tests import server modules directly.
      { find: "server-only", replacement: path.resolve(import.meta.dirname, "tests/unit/server-only.ts") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/*.int.test.ts", "**/node_modules/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: [
        "packages/core/src/**",
        "packages/shared/src/**",
        "packages/server/src/**",
        "packages/adapters/src/memory/**",
        "packages/stalwart-client/src/**",
        "packages/jmap-client/src/**",
        "apps/web/src/server/**",
      ],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "packages/shared/src/credits.generated.ts",
        // Talk to real infrastructure: covered by integration tests and the RBAC harness.
        "packages/server/src/redis.ts",
        "apps/web/src/server/env.ts",
        "apps/web/src/server/container.ts",
        "apps/web/src/server/health.ts",
        "apps/web/src/server/auth/**",
        "apps/web/src/server/adapters/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "packages/core/src/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
        "packages/shared/src/rbac/**": { lines: 90, functions: 90, branches: 90, statements: 90 },
      },
    },
  },
});
