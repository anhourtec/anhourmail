// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export { schema };

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

const globalForDb = globalThis as unknown as { amDb?: Db; amPool?: Pool };

/** The shared Drizzle client for DATABASE_URL (lazy; survives Next dev hot reloads). */
export function db(): Db {
  if (!globalForDb.amDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    globalForDb.amPool = new Pool({ connectionString, max: 10 });
    globalForDb.amDb = drizzle(globalForDb.amPool, { schema });
  }
  return globalForDb.amDb;
}

/** A separate client (tests, scripts). Caller ends the pool. */
export function createDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString, max: 5 });
  return { db: drizzle(pool, { schema }), pool };
}

/** Readiness probe: one round trip. */
export async function pingDatabase(): Promise<void> {
  await db().execute(sql`select 1`);
}
