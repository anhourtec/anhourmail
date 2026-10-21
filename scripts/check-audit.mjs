#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rules 46–47: every mutation is audited through the audit module.
 *
 * Fails when, in packages/core/src (tests excluded):
 *   - a service file calls a repository write (insert/update/delete/append) but never uses `mutation(`;
 *   - any file other than mutation.ts calls `audit.append` (only the wrapper and adapters write audit rows);
 *   - a `mutation(` spec names an action missing from audit/catalogue.ts or from docs/internal/audit.md;
 *   - an adapter adds an update/delete path for audit rows;
 *   - the event table in docs/internal/audit.md (between the generated markers) is out of date.
 *     `node scripts/check-audit.mjs --write` regenerates it from audit/catalogue.ts (the source of truth).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const CORE = "packages/core/src";
const problems = [];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !full.includes("__tests__")) yield full;
  }
}

const catalogue = readFileSync(path.join(CORE, "audit/catalogue.ts"), "utf8");
const known = new Set([...catalogue.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]));
const auditDoc = existsSync("docs/internal/audit.md") ? readFileSync("docs/internal/audit.md", "utf8") : "";

for (const file of files(CORE)) {
  const src = readFileSync(file, "utf8");
  const rel = file.replaceAll(path.sep, "/");
  const writes = /\brepos?\.\w+\.(insert|update|delete|append)\(|\br\.\w+\.(insert|update|delete)\(/.test(src);
  if (/service\.ts$/.test(rel) && writes && !src.includes("mutation(")) {
    problems.push(`${rel}: writes through a repository without mutation()`);
  }
  if (!rel.endsWith("/mutation.ts") && /\.audit\.append\(/.test(src)) {
    problems.push(`${rel}: calls audit.append directly — use mutation()`);
  }
  for (const m of src.matchAll(/mutation\([\s\S]*?action:\s*"([^"]+)"/g)) {
    const action = m[1];
    if (!known.has(action)) problems.push(`${rel}: action "${action}" is not in audit/catalogue.ts`);
    if (!auditDoc.includes(action)) problems.push(`${rel}: action "${action}" is not in docs/internal/audit.md`);
  }
}

// The doc table is generated from the code catalogue, grouped by area (the part before the dot).
const BEGIN = "<!-- BEGIN generated: audit actions (scripts/check-audit.mjs --write) -->";
const END = "<!-- END generated: audit actions -->";
const ordered = [...catalogue.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]);
const groups = new Map();
for (const a of ordered) {
  const area = a.split(".")[0];
  groups.set(area, [...(groups.get(area) ?? []), a]);
}
const table = [
  BEGIN,
  "",
  "| Area | Actions |",
  "| --- | --- |",
  ...[...groups].map(([area, list]) => `| \`${area}\` | ${list.map((a) => `\`${a}\``).join(", ")} |`),
  "",
  END,
].join("\n");
const start = auditDoc.indexOf(BEGIN);
const end = auditDoc.indexOf(END);
if (process.argv.includes("--write")) {
  if (start === -1 || end === -1) throw new Error(`docs/internal/audit.md needs the markers:\n${BEGIN}\n${END}`);
  writeFileSync("docs/internal/audit.md", auditDoc.slice(0, start) + table + auditDoc.slice(end + END.length));
  console.log("docs/internal/audit.md event table regenerated.");
  process.exit(0);
}
if (start === -1 || auditDoc.slice(start, end + END.length) !== table) {
  problems.push("docs/internal/audit.md: event table is stale — run `node scripts/check-audit.mjs --write`");
}

for (const file of files("packages/adapters/src")) {
  const src = readFileSync(file, "utf8");
  if (/\.(update|delete)\(auditLog\)/.test(src)) problems.push(`${file}: update/delete on audit_log is forbidden`);
}

if (problems.length > 0) {
  console.error("Audit rule violations (CLAUDE.md rules 46–47):");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check:audit — mutations audited; ${known.size} catalogued actions.`);
