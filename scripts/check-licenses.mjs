#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rule 43: every production dependency has an allowlisted licence.
 *
 *   npm run check:licenses
 *
 * Fails (exit 1) on any licence outside the allowlist that has no reviewed exception in
 * scripts/license-exceptions.json. An exception needs a reason and an ADR reference.
 * SPDX expressions: "A OR B" passes if either side is allowed; "A AND B" needs both.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { EXTRA_COMPONENTS, productionPackages } from "./third-party-notices.mjs";

const ALLOW = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "OFL-1.1",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "PostgreSQL",
]);

/** Copyleft families compatible with distributing alongside AGPL-3.0 apps. */
const ALLOW_PATTERNS = [
  /^LGPL-\d\.\d(-only|-or-later)?$/,
  /^GPL-\d\.\d(-only|-or-later)?$/,
  /^AGPL-3\.0(-only|-or-later)?$/,
];

function allowed(license) {
  return ALLOW.has(license) || ALLOW_PATTERNS.some((re) => re.test(license));
}

export function expressionAllowed(expr) {
  const e = expr.trim().replace(/^\((.*)\)$/, "$1");
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some(expressionAllowed);
  if (/\sAND\s/.test(e)) return e.split(/\s+AND\s+/).every(expressionAllowed);
  return allowed(e.replace(/[()]/g, "").trim());
}

const exceptions = JSON.parse(readFileSync(path.join(process.cwd(), "scripts/license-exceptions.json"), "utf8"));

const failures = [];
const excepted = [];
const components = [
  ...productionPackages().map((p) => ({ name: p.name, version: p.version, license: p.license })),
  ...EXTRA_COMPONENTS,
];
for (const c of components) {
  if (expressionAllowed(c.license)) continue;
  const ex = exceptions[c.name];
  if (ex && ex.license === c.license && ex.reason && ex.adr) {
    excepted.push(`${c.name} (${c.license}) — ${ex.adr}`);
    continue;
  }
  failures.push(`${c.name}@${c.version}: ${c.license}`);
}

if (failures.length > 0) {
  console.error(
    "Licences outside the allowlist (review, then add an ADR-referenced entry to scripts/license-exceptions.json):",
  );
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check:licenses — ${components.length} components allowed${excepted.length ? `; reviewed exceptions: ${excepted.join("; ")}` : ""}.`,
);
