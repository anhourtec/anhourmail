import { defineConfig } from "drizzle-kit";

// Migrations are logged in docs/internal/migration.md (CLAUDE.md rule 15). Never edit an applied one.
export default defineConfig({
  schema: "./src/db-postgres/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
});
