// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reads a demo password from the local, gitignored credentials.md written by `npm run db:seed -- --demo`
 * (CLAUDE.md rule 50). The value is returned to the caller only — never print or log it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const FILE = path.join(import.meta.dirname, "..", "..", "credentials.md");

export function demoPassword(email: string): string {
  if (!existsSync(FILE)) throw new Error("credentials.md is missing: run `npm run db:seed -- --demo` first");
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // | Role | `email` | `password` | What to try |
    if (cells[2] === `\`${email}\``) {
      const pw = /^`(.+)`$/.exec(cells[3] ?? "")?.[1];
      if (pw) return pw;
    }
  }
  throw new Error(`No demo password for ${email} in credentials.md: re-run \`npm run db:seed -- --demo\``);
}
