#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rule 12: server code logs only through @anhourmail/server/log (JSON, request ids, redaction).
 * Fails on console.log/info/warn/error/debug/trace in server code. CLI scripts in scripts/ may print.
 * (ESLint's no-console covers the same paths; this check also runs where lint is skipped, e.g. pre-commit.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = [
  "apps/web/src/server",
  "apps/web/src/app/api",
  "apps/web/src/proxy.ts",
  "apps/site/src/app/api",
  "apps/worker/src",
  "packages/core/src",
  "packages/adapters/src",
  "packages/server/src",
  "packages/stalwart-client/src",
  "packages/jmap-client/src",
];
const PATTERN = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/;

function* files(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (/\.(ts|tsx|mjs|js)$/.test(p) && !/\.test\.ts$/.test(p)) yield p;
    return;
  }
  for (const name of readdirSync(p)) yield* files(path.join(p, name));
}

const hits = [];
for (const root of ROOTS) {
  for (const file of files(root)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (PATTERN.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
}

if (hits.length > 0) {
  console.error("console.* in server code — use `log` from @anhourmail/server/log instead:\n");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log("check:logging — no console.* in server code.");
