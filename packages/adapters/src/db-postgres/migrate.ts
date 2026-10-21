// SPDX-License-Identifier: AGPL-3.0-only
/** Applies pending migrations (`npm run db:migrate`). Never edit an applied migration (CLAUDE.md rule 15). */
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb } from "./client";

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, pool } = createDb(url);
await migrate(db, { migrationsFolder: path.join(import.meta.dirname, "../../drizzle") });
await pool.end();
process.stdout.write("migrations applied\n");
