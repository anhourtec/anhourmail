// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ESLint (CLAUDE.md rule 40): typescript-eslint strict-type-checked + stylistic, React hooks, Next, Vitest,
 * Playwright, and the ports-and-adapters import boundaries (ADR-0008). Formatting is Prettier's job.
 * Zero warnings allowed (`--max-warnings=0`).
 */
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import vitest from "@vitest/eslint-plugin";
import prettier from "eslint-config-prettier";
import playwright from "eslint-plugin-playwright";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** SDKs, drivers and the ORM: only adapter code may import them. */
const INFRA_IMPORTS = [
  {
    group: ["drizzle-orm", "drizzle-orm/*", "pg", "drizzle-kit"],
    message: "Only packages/adapters talks to the database (ADR-0008).",
  },
  { group: ["better-auth", "better-auth/*"], message: "Only packages/adapters/src/auth uses the auth SDK (ADR-0008)." },
  { group: ["ioredis"], message: "Use @anhourmail/server/redis." },
  { group: ["stripe", "stripe/*"], message: "Stripe lives behind a billing port in packages/adapters (ADR-0008)." },
  {
    group: ["@anhourmail/stalwart-client", "@anhourmail/stalwart-client/*"],
    message: "Stalwart is reached through an adapter (apps/*/src/server/adapters, apps/worker) — rule 21, ADR-0008.",
  },
];

/**
 * The product's published hostnames (anhourmail.com) are for the marketing site and docs. Server code and the console
 * use the deployment's configured platform (`deps.platform`, the web app's `platform()`; PLATFORM_DOMAIN), so a
 * staging or self-hosted install never shows customers production names.
 */
const PUBLIC_FACTS = "HOSTS|CLIENT_ENDPOINTS|CARDDAV|PUBLIC_PLATFORM";
const publicFactsRule = (names, where) => [
  "error",
  {
    selector: `ImportDeclaration[source.value=/^@anhourmail.shared(.platform)?$/] ImportSpecifier[imported.name=/^(${names})$/]`,
    message: `Use the configured platform (${where}), not the product's published hostnames — PLATFORM_DOMAIN, docs/internal/01-architecture.md "Platform hostnames".`,
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/dist/**",
      "**/.source/**",
      "**/next-env.d.ts",
      "**/components/ui/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      ".playwright-mcp/**",
      // Scratch and probe files (CLAUDE.md rule 58) are outside every tsconfig, so type-aware rules can't parse them.
      ".probe/**",
      ".scratch/**",
      "**/.probe*",
      "**/.scratch*",
      "packages/shared/src/credits.generated.ts",
      "packages/adapters/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // House style (as in iotkinect-portal): `type` aliases everywhere.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // Off on purpose: adapters and test fakes implement Promise-returning ports with `async` and no `await`.
      // Promise misuse is still caught by no-floating-promises / no-misused-promises (errors).
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-console": "off",
      "no-restricted-imports": ["error", { patterns: INFRA_IMPORTS }],
    },
  },
  { files: ["**/*.{js,mjs,cjs}"], ...tseslint.configs.disableTypeChecked },
  // Adapters, the auth/stalwart adapter folders, dev tooling and the worker may use SDKs and drivers.
  {
    files: [
      "packages/adapters/**",
      "packages/server/src/redis.ts",
      "packages/stalwart-client/**",
      "apps/*/src/server/adapters/**",
      "apps/worker/**",
      "scripts/**",
      "infra/**",
    ],
    rules: { "no-restricted-imports": "off" },
  },
  // Each process uses only its own Stalwart credential (ADR-0020 "Credential split"): the web app never the
  // provisioning or audit key (it can't create accounts), the worker image never the operations key (it can't act
  // inside a mailbox); the dev admin is for dev tooling and integration-test set-up.
  {
    files: ["apps/web/src/server/adapters/**"],
    ignores: ["**/*.int.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@anhourmail/stalwart-client",
              importNames: ["stalwartProvisioning", "stalwartAudit", "stalwartDevAdmin"],
              message: "The web app holds the operations key only (ADR-0020 'Credential split').",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/worker/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@anhourmail/stalwart-client",
              importNames: ["stalwartOperations", "stalwartDevAdmin"],
              message: "Worker processes hold the provisioning (and the scheduler the audit) key only (ADR-0020).",
            },
          ],
        },
      ],
    },
  },
  // The domain core is plain TypeScript: no frameworks, no adapters.
  {
    files: ["packages/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...INFRA_IMPORTS,
            {
              group: ["@anhourmail/adapters", "@anhourmail/adapters/*"],
              message: "Core depends on ports, not adapters.",
            },
            { group: ["next", "next/*", "react", "react-dom"], message: "Core is framework-free." },
          ],
        },
      ],
    },
  },
  // Server code logs only through the logger (rule 12).
  {
    files: [
      "apps/*/src/server/**",
      "apps/*/src/app/api/**",
      "apps/*/src/proxy.ts",
      "packages/{core,adapters,server}/src/**",
    ],
    ignores: ["**/*.test.ts"],
    rules: { "no-console": "error" },
  },
  // Hostnames customers see come from PLATFORM_DOMAIN in server code and the console (rule 32 note above).
  {
    files: ["packages/{core,adapters}/src/**", "apps/worker/**"],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-syntax": publicFactsRule(PUBLIC_FACTS, "deps.platform") },
  },
  {
    files: ["apps/web/src/**"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": publicFactsRule(`${PUBLIC_FACTS}|PRODUCT_DOMAIN`, "platform() in @/server/platform"),
    },
  },
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["apps/web/**", "apps/site/**"],
    plugins: { "@next/next": nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs["core-web-vitals"].rules },
    settings: { next: { rootDir: ["apps/web/", "apps/site/"] } },
  },
  {
    files: ["**/*.test.ts", "**/*.int.test.ts", "packages/adapters/src/contract/**"],
    plugins: { vitest },
    rules: { ...vitest.configs.recommended.rules, "@typescript-eslint/no-non-null-assertion": "off" },
  },
  { files: ["tests/e2e/**"], ...playwright.configs["flat/recommended"] },
  prettier,
);
