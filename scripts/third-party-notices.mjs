#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rule 43: credits for everything we ship.
 *
 *   npm run notices            # regenerate THIRD_PARTY_NOTICES.md + packages/shared/src/credits.generated.ts
 *   npm run notices -- --check # exit 1 if either file is out of date (CI, pre-commit)
 *
 * Source of truth: package-lock.json "packages" entries that are production dependencies of any workspace
 * (dev-only packages and workspace links are skipped), plus the self-hosted fonts and the container images we
 * run. Output is deterministic (sorted, no timestamps) so `--check` is a plain comparison.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CHECK = process.argv.includes("--check");
const NOTICES_FILE = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
const CREDITS_FILE = path.join(ROOT, "packages/shared/src/credits.generated.ts");

/** Licence strings seen in the wild → SPDX ids. */
const NORMALIZE = new Map([
  ["SIL OPEN FONT LICENSE", "OFL-1.1"],
  ["SIL Open Font License 1.1", "OFL-1.1"],
  ["OFL", "OFL-1.1"],
  ["Apache 2.0", "Apache-2.0"],
  ["Apache License 2.0", "Apache-2.0"],
  ["BSD", "BSD-3-Clause"],
  ["MIT*", "MIT"],
]);

export function normalizeLicense(raw) {
  if (raw == null) return "UNKNOWN";
  const value = typeof raw === "string" ? raw : (raw.type ?? "UNKNOWN");
  const trimmed = value.trim().replace(/^\((.*)\)$/, "$1");
  return NORMALIZE.get(trimmed) ?? trimmed;
}

/** Production packages from the lockfile: [{ name, version, license, dir, repository }]. */
export function productionPackages(root = ROOT) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const out = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/") && !key.includes("/node_modules/")) continue; // workspaces + root
    if (entry.link || entry.dev || entry.devOptional) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (name.startsWith("@anhourmail/")) continue;
    const id = `${name}@${entry.version}`;
    if (out.has(id)) continue;
    out.set(id, {
      name,
      version: entry.version,
      license: normalizeLicense(entry.license),
      dir: path.join(root, key),
      optional: Boolean(entry.optional),
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function readIfExists(dir, names) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  for (const want of names) {
    const hit = files.find((f) => f.toUpperCase() === want || f.toUpperCase().startsWith(`${want}.`));
    if (hit) return readFileSync(path.join(dir, hit), "utf8");
  }
  return null;
}

function copyrightLine(text) {
  if (!text) return null;
  const line = text.split("\n").find((l) => /copyright\s*(\(c\)|©|\d{4})/i.test(l));
  return line ? line.trim().replace(/\s+/g, " ").slice(0, 200) : null;
}

function repositoryUrl(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const home = typeof pkg.homepage === "string" ? pkg.homepage : null;
    const norm = (u) =>
      u
        ?.replace(/^git\+/, "")
        .replace(/^git:\/\//, "https://")
        .replace(/^github:/, "https://github.com/")
        .replace(/\.git$/, "")
        .replace(/^ssh:\/\/git@github\.com/, "https://github.com") ?? null;
    const url = norm(repo);
    return { url: home ?? url, repository: url && /^https?:/.test(url) ? url : null };
  } catch {
    return { url: null, repository: null };
  }
}

/** Assets we ship or run that aren't npm packages. */
export const EXTRA_COMPONENTS = [
  {
    name: "General Sans (font)",
    version: "Fontshare",
    license: "LicenseRef-ITF-FFL",
    url: "https://www.fontshare.com/fonts/general-sans",
    note: "ITF Free Font License (Indian Type Foundry). Self-hosted from packages/ui/src/fonts.",
  },
  {
    name: "Geist / Geist Mono (font)",
    version: "via the geist package",
    license: "OFL-1.1",
    url: "https://vercel.com/font",
    note: "SIL Open Font License 1.1. Self-hosted, no third-party font requests.",
  },
  {
    name: "Stalwart mail server (container image)",
    version: "v0.16.27",
    license: "AGPL-3.0-only",
    url: "https://github.com/stalwartlabs/stalwart",
    note: "Run unmodified. Copyright Stalwart Labs LLC. Source: https://github.com/stalwartlabs/stalwart/tree/v0.16.27",
  },
  {
    name: "PostgreSQL (container image)",
    version: "17.11",
    license: "PostgreSQL",
    url: "https://www.postgresql.org",
    note: "PostgreSQL License. Copyright The PostgreSQL Global Development Group.",
  },
  {
    name: "Redis (container image)",
    version: "8.8.3",
    license: "AGPL-3.0-only",
    url: "https://redis.io",
    note: "Redis 8 is offered under AGPL-3.0 (among other licences). Run unmodified.",
  },
  {
    name: "Mailpit (container image, development only)",
    version: "v1.31.6",
    license: "MIT",
    url: "https://github.com/axllent/mailpit",
    note: "Local mail sink; never deployed to production.",
  },
  {
    name: "socat (alpine/socat container image, development only)",
    version: "1.8.0.3",
    license: "GPL-2.0-only",
    url: "http://www.dest-unreach.org/socat/",
    note: "Local port forwarder for the isolated dev mail network; never deployed to production.",
  },
];

/** Human-written thanks for the projects AnhourMail leans on most. */
const THANKS = [
  {
    name: "Stalwart",
    url: "https://stalw.art",
    why: "The mail server at the heart of AnhourMail: SMTP, IMAP and JMAP in one fast, secure package.",
  },
  { name: "Next.js", url: "https://nextjs.org", why: "The framework behind the console, the webmail and this site." },
  { name: "React", url: "https://react.dev", why: "The UI library every screen is built with." },
  {
    name: "shadcn/ui",
    url: "https://ui.shadcn.com",
    why: "Accessible components we own and adapt instead of fighting a framework.",
  },
  { name: "Tailwind CSS", url: "https://tailwindcss.com", why: "The styling system behind our design tokens." },
  { name: "Lucide", url: "https://lucide.dev", why: "Clean, consistent icons." },
  {
    name: "PostgreSQL",
    url: "https://www.postgresql.org",
    why: "The database that keeps accounts, domains and audit history safe.",
  },
  { name: "Redis", url: "https://redis.io", why: "Sessions, queues and rate limits." },
  {
    name: "Playwright",
    url: "https://playwright.dev",
    why: "End-to-end tests that drive the product like a real person.",
  },
  { name: "Vitest", url: "https://vitest.dev", why: "Fast unit tests for every rule and service." },
  { name: "Fumadocs", url: "https://fumadocs.dev", why: "The documentation framework behind anhourmail.com/docs." },
];

function buildNotices(pkgs) {
  const lines = [
    "# Third-party notices",
    "",
    "<!-- Generated by scripts/third-party-notices.mjs — do not edit by hand. Run `npm run notices`. -->",
    "",
    "AnhourMail is built on open-source software. This file lists the third-party components we ship or run,",
    "their licences and copyright notices. Listing a project here does not imply its endorsement of AnhourMail.",
    "",
    "## Services and assets",
    "",
    "| Component | Version | Licence | Notes |",
    "| --- | --- | --- | --- |",
    ...EXTRA_COMPONENTS.map((c) => `| [${c.name}](${c.url}) | ${c.version} | ${c.license} | ${c.note} |`),
    "",
    `## npm packages (${pkgs.length})`,
    "",
    "Production dependencies of all workspaces, from `package-lock.json`.",
    "",
    "| Package | Version | Licence | Copyright |",
    "| --- | --- | --- | --- |",
  ];
  const notices = [];
  for (const p of pkgs) {
    const licText = readIfExists(p.dir, ["LICENSE", "LICENCE", "COPYING"]);
    const copyright = copyrightLine(licText) ?? "";
    const { url } = repositoryUrl(p.dir);
    const label = url ? `[${p.name}](${url})` : p.name;
    lines.push(`| ${label} | ${p.version} | ${p.license} | ${copyright.replace(/\|/g, "\\|")} |`);
    if (p.license.includes("Apache-2.0")) {
      const notice = readIfExists(p.dir, ["NOTICE"]);
      if (notice) notices.push({ name: `${p.name}@${p.version}`, text: notice.trim() });
    }
  }
  if (notices.length > 0) {
    lines.push("", "## NOTICE files (Apache-2.0)", "");
    for (const n of notices) {
      lines.push(`### ${n.name}`, "", "```", n.text, "```", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** JSON with bare identifier keys (Prettier's default `quoteProps: "as-needed"`), so formatting is a no-op. */
const tsLiteral = (value) => JSON.stringify(value, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");

function buildCredits(pkgs) {
  const credits = [
    ...EXTRA_COMPONENTS.map((c) => ({ name: c.name, version: c.version, license: c.license, url: c.url })),
    ...pkgs.map((p) => {
      const { url, repository } = repositoryUrl(p.dir);
      return { name: p.name, version: p.version, license: p.license, url, ...(repository ? { repository } : {}) };
    }),
  ];
  return `// SPDX-License-Identifier: AGPL-3.0-only
// Generated by scripts/third-party-notices.mjs — do not edit by hand. Run \`npm run notices\`.
// Rendered by the /credits page and "About → Open source" in the app.

export type Credit = { name: string; version: string; license: string; url: string | null; repository?: string };
export type Thanks = { name: string; url: string; why: string };

export const CREDITS: readonly Credit[] = ${tsLiteral(credits)};

export const THANKS: readonly Thanks[] = ${tsLiteral(THANKS)};
`;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const pkgs = productionPackages();
  // Format with the repo's Prettier config so `npm run format` never changes generated files.
  const prettier = await import("prettier");
  const formatted = async (file, text) =>
    prettier.format(text, { ...((await prettier.resolveConfig(file)) ?? {}), filepath: file });
  const outputs = [
    [NOTICES_FILE, await formatted(NOTICES_FILE, buildNotices(pkgs))],
    [CREDITS_FILE, await formatted(CREDITS_FILE, buildCredits(pkgs))],
  ];
  if (CHECK) {
    const stale = outputs.filter(([file, text]) => !existsSync(file) || readFileSync(file, "utf8") !== text);
    if (stale.length > 0) {
      console.error("Third-party notices are out of date (CLAUDE.md rule 43). Run `npm run notices`:");
      for (const [file] of stale) console.error(`  ${path.relative(ROOT, file)}`);
      process.exit(1);
    }
    console.log(`notices — up to date (${pkgs.length} packages).`);
  } else {
    for (const [file, text] of outputs) writeFileSync(file, text);
    console.log(`notices — wrote THIRD_PARTY_NOTICES.md and credits.generated.ts (${pkgs.length} packages).`);
  }
}
