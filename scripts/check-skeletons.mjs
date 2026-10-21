#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rule 11: every page has a loading skeleton that mirrors its layout.
 * Fails (exit 1) when a page.tsx in an app has no loading.tsx next to it. Runs in pre-commit and CI.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["apps/web/src/app", "apps/site/src/app"];
const missing = [];
let pages = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name === "page.tsx") {
      pages += 1;
      if (!existsSync(path.join(dir, "loading.tsx"))) missing.push(dir);
    }
  }
}

for (const root of ROOTS) if (existsSync(root)) walk(root);

if (missing.length > 0) {
  console.error("Missing loading.tsx (CLAUDE.md rule 11 — every page gets a loading skeleton):");
  for (const dir of missing) console.error(`  ${dir}`);
  process.exit(1);
}
console.log(`check:skeletons — ${pages} pages, each with a loading skeleton.`);
