#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rules 44, 50, 52: local-only files never reach the public repo.
 * Fails (exit 1) when any of them is tracked or staged. Runs in the pre-commit hook and CI.
 */
import { execFileSync } from "node:child_process";

const FORBIDDEN = [
  /(^|\/)credentials\.md$/,
  /^docs\/internal\/handoff\.md$/,
  /^deploy\.md$/,
  /^docs\/internal\/private\//,
  /\.local\.md$/,
  /(^|\/)\.env(\..*)?$/,
  /^infra\/stalwart\/\.generated\//,
  /^\.playwright-mcp\//,
  /^deploy\/certs\//,
  /\.(pem|key)$/,
];
const ALLOWED = [/(^|\/)\.env\.example$/];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const files = new Set([...git("ls-files"), ...git("diff", "--cached", "--name-only")]);
const hits = [...files].filter((f) => FORBIDDEN.some((re) => re.test(f)) && !ALLOWED.some((re) => re.test(f)));

if (hits.length > 0) {
  console.error("Local-only files are tracked or staged — unstage them (git rm --cached <file>):");
  for (const f of hits) console.error(`  ${f}`);
  process.exit(1);
}
console.log("check:credentials — no local-only files tracked or staged.");
