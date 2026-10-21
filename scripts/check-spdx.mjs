#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rule 42: every source file starts with the right SPDX header.
 *
 *   npm run check:spdx            # report, exit 1 on any missing or wrong header
 *   npm run check:spdx -- --fix   # insert or correct headers (a leading shebang stays first)
 *
 * Licence by path: MIT for the reusable library packages (jmap-client, stalwart-client, server, config),
 * AGPL-3.0-only for everything else (apps, core, adapters, shared, ui, scripts, infra).
 * Header forms: `// SPDX-License-Identifier: <id>` (js/ts), `/* SPDX-License-Identifier: <id> *\/` (css),
 * `# SPDX-License-Identifier: <id>` (sh).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FIX = process.argv.includes("--fix");

const MIT_PACKAGES = ["packages/jmap-client", "packages/stalwart-client", "packages/server", "packages/config"];

/** [directory, filter] roots to scan. */
const ROOTS = [
  ...listDirs("apps").map((d) => path.join(d, "src")),
  ...listDirs("packages").map((d) => path.join(d, "src")),
  "scripts",
  "infra",
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".source", "dist", "out", "build", ".generated", "data"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".sh"]);

function listDirs(dir) {
  try {
    return readdirSync(dir)
      .map((n) => path.join(dir, n))
      .filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
}

function* walk(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isFile()) {
    yield p;
    return;
  }
  for (const name of readdirSync(p)) {
    if (SKIP_DIRS.has(name)) continue;
    // Generated shadcn/ui primitives keep their upstream form.
    if (name === "ui" && p.endsWith(`${path.sep}components`)) continue;
    yield* walk(path.join(p, name));
  }
}

function expectedId(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  return MIT_PACKAGES.some((pkg) => rel.startsWith(`${pkg}/`)) ? "MIT" : "AGPL-3.0-only";
}

function headerFor(ext, id) {
  if (ext === ".css") return `/* SPDX-License-Identifier: ${id} */`;
  if (ext === ".sh") return `# SPDX-License-Identifier: ${id}`;
  return `// SPDX-License-Identifier: ${id}`;
}

const SPDX_LINE = /^(\/\/|#|\/\*)\s*SPDX-License-Identifier:\s*([^\s*]+)\s*(\*\/)?\s*$/;

const problems = [];
let fixed = 0;
let checked = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const ext = path.extname(file);
    if (!EXTENSIONS.has(ext) || file.endsWith(".d.ts")) continue;
    checked += 1;
    const id = expectedId(file);
    const want = headerFor(ext, id);
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    const start = lines[0]?.startsWith("#!") ? 1 : 0;
    const line = lines[start] ?? "";
    const m = SPDX_LINE.exec(line);
    if (m && m[2] === id) continue;
    problems.push(`${path.relative(ROOT, file)}: ${m ? `has ${m[2]}, expected ${id}` : `missing header (${id})`}`);
    if (FIX) {
      if (m) lines[start] = want;
      else lines.splice(start, 0, want);
      writeFileSync(file, lines.join("\n"));
      fixed += 1;
    }
  }
}

if (FIX) {
  console.log(`check:spdx --fix — ${checked} files checked, ${fixed} fixed.`);
} else if (problems.length > 0) {
  console.error("SPDX header problems (CLAUDE.md rule 42 — run `npm run check:spdx -- --fix`):");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
} else {
  console.log(`check:spdx — ${checked} files, all headers correct.`);
}
