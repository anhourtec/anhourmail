#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rule 53: brand assets have one source, packages/ui/assets/brand. This copies them into each app's
 * public/ folder (Next serves only from there). `--check` fails when a copy is missing or differs.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = "packages/ui/assets/brand";
const TARGETS = ["apps/web/public", "apps/site/public"];
const check = process.argv.includes("--check");
const files = readdirSync(SRC).filter((f) => f !== "README.md");
const drift = [];

for (const target of TARGETS) {
  if (!check) mkdirSync(target, { recursive: true });
  for (const f of files) {
    const from = path.join(SRC, f);
    const to = path.join(target, f);
    const same = existsSync(to) && readFileSync(from).equals(readFileSync(to));
    if (same) continue;
    if (check) drift.push(to);
    else copyFileSync(from, to);
  }
}

if (drift.length > 0) {
  console.error("Brand assets out of sync — run `npm run brand:sync`:");
  for (const d of drift) console.error(`  ${d}`);
  process.exit(1);
}
console.log(check ? "check:brand — app copies match packages/ui/assets/brand." : "brand assets synced.");
