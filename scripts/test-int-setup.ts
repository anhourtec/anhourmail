// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Vitest global setup for `npm run test:int`: brings the test database up to the latest migration first, so a
 * fresh database (CI, or after `dev:reset`) needs no manual step.
 */
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb } from "../packages/adapters/src/db-postgres/client";

export default async function setup(): Promise<void> {
  if (!process.env.TEST_DATABASE_URL) {
    try {
      process.loadEnvFile(".env");
    } catch {
      // CI provides the environment
    }
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  const { db, pool } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: path.join(import.meta.dirname, "../packages/adapters/drizzle") });
  } finally {
    await pool.end();
  }
}
