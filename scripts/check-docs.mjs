#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLAUDE.md rules 31–34: public docs stay correct, single-sourced and free of internals.
 *
 *   npm run check:docs
 *
 * Fails (exit 1) when, in docs/public (and docs/shared):
 *   (a) a link points to a docs page or site route that doesn't exist;
 *   (b) a fact from packages/shared is written literally instead of rendered by a component
 *       (hostnames, client ports, prices, storage sizes, sending limits, refund window);
 *   (c) a page references docs/internal (architecture, ADRs, research, runbooks are never published).
 * Runs in the pre-commit hook and CI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "docs/public");
const SHARED_DOCS = path.join(ROOT, "docs/shared");
const SHARED_SRC = path.join(ROOT, "packages/shared/src");

/** Site routes outside /docs that docs may link to. Keep in sync with apps/site/src/app. */
const SITE_ROUTES = new Set([
  "/",
  "/features",
  "/features/custom-domains",
  "/features/aliases",
  "/features/webmail",
  "/features/privacy",
  "/features/apps",
  "/pricing",
  "/security",
  "/about",
  "/support",
  "/switch",
  "/blog",
  "/changelog",
  "/credits",
  "/legal",
  "/legal/terms",
  "/legal/privacy",
  "/legal/acceptable-use",
]);

function* files(dir, exts) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full, exts);
    else if (exts.some((e) => name.endsWith(e))) yield full;
  }
}

const read = (f) => readFileSync(f, "utf8");
const rel = (f) => path.relative(ROOT, f);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- facts from packages/shared (regex scan; no TS loader needed) ------------------------------------

function sharedFacts() {
  const src = [...files(SHARED_SRC, [".ts"])].map(read).join("\n");
  const domain = /PRODUCT_DOMAIN\s*=\s*"([^"]+)"/.exec(src)?.[1];
  const company = /COMPANY_DOMAIN\s*=\s*"([^"]+)"/.exec(src)?.[1];
  if (!domain) throw new Error("check-docs: PRODUCT_DOMAIN not found in packages/shared");
  const hosts = new Set([domain, ...(company ? [company] : [])]);
  // Hosts are built per platform domain (`platformHosts(domain)`); the docs publish them for PRODUCT_DOMAIN.
  for (const m of src.matchAll(/`([a-z0-9-]+)\.\$\{(?:PRODUCT_DOMAIN|domain)\}`/g)) hosts.add(`${m[1]}.${domain}`);

  const ports = new Set([...src.matchAll(/\bport:\s*(\d+)/g)].map((m) => Number(m[1])));

  const amounts = new Set();
  for (const m of src.matchAll(/\b(USD|CAD):\s*(\d+)/g)) amounts.add(Number(m[2]) / 100);

  const storage = new Set([...src.matchAll(/storage(?:Pool|Block)Gb:\s*(\d+)/g)].map((m) => Number(m[1])));

  const limits = new Set();
  for (const m of src.matchAll(/\b(messagesPerDay|messagesPerHour|recipientsPerMessage):\s*(\d+)/g)) {
    if (Number(m[2]) > 0) limits.add(Number(m[2]));
  }
  for (const m of src.matchAll(/\b(aliases|maskedAliases):\s*(\d+)/g)) limits.add(Number(m[2]));

  const refundDays = /refundWindowDays:\s*(\d+)/.exec(src)?.[1];
  const graceDays = /MAILBOX_DELETE_GRACE_DAYS\s*=\s*(\d+)/.exec(src)?.[1];
  return { domain, hosts, ports, amounts, storage, limits, refundDays, graceDays };
}

// ---- checks ---------------------------------------------------------------------------------------

const facts = sharedFacts();
const problems = [];

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function report(file, text, index, msg) {
  problems.push(`${rel(file)}:${lineOf(text, index)}: ${msg}`);
}

/** docs/public path for a /docs URL, or null when no page exists. */
function docsPageExists(urlPath) {
  const sub = urlPath.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  const base = sub === "" ? path.join(PUBLIC, "index") : path.join(PUBLIC, sub);
  return [".mdx", ".md", "/index.mdx", "/index.md"].some((ext) => existsSync(base + ext));
}

/** The /docs URL a docs/public file is served at. */
function urlOf(file) {
  const r = path.relative(PUBLIC, file).replace(/\.(mdx|md)$/, "");
  const parts = r.split(path.sep).filter((p) => p !== "index");
  return `/docs${parts.length ? `/${parts.join("/")}` : ""}`;
}

function checkLinks(file, text) {
  const isIndex = /(^|\/)index\.mdx?$/.test(file);
  const pageUrl = urlOf(file);
  const dirUrl = isIndex ? pageUrl : pageUrl.replace(/\/[^/]+$/, "") || "/docs";
  const linkRe = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)|href=["']([^"']+)["']/g;
  for (const m of text.matchAll(linkRe)) {
    const raw = m[1] ?? m[2] ?? "";
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = raw.split("#")[0]?.split("?")[0] ?? "";
    if (target === "") continue;
    const abs = target.startsWith("/") ? target : path.posix.normalize(`${dirUrl}/${target}`);
    if (abs === "/docs" || abs.startsWith("/docs/")) {
      if (!docsPageExists(abs)) report(file, text, m.index ?? 0, `link to missing docs page "${raw}"`);
    } else if (!SITE_ROUTES.has(abs)) {
      report(file, text, m.index ?? 0, `link to unknown site route "${raw}"`);
    }
  }
}

function checkFacts(file, text) {
  for (const host of facts.hosts) {
    const re = new RegExp(`(?<![\\w.-])${escape(host)}(?![\\w-])`, "gi");
    for (const m of text.matchAll(re)) {
      report(file, text, m.index ?? 0, `hostname "${m[0]}" is hard-coded — use <Value of="…" /> or a table component`);
    }
  }
  for (const port of facts.ports) {
    // High ports are unambiguous anywhere; low ones (25, 443) only next to the word "port" or after a colon.
    const re =
      port >= 100 && port !== 443
        ? new RegExp(`(?<![\\w.])${port}(?![\\w.])`, "g")
        : new RegExp(`(?:\\bport\\s*|:)${port}\\b`, "gi");
    for (const m of text.matchAll(re)) {
      report(file, text, m.index ?? 0, `port ${port} is hard-coded — use <ClientSettingsTable /> or <Value />`);
    }
  }
  for (const amount of facts.amounts) {
    const re = new RegExp(`(?:\\$\\s?${amount}(?:\\.00)?\\b|\\b${amount}(?:\\.00)?\\s?(?:USD|CAD)\\b)`, "g");
    for (const m of text.matchAll(re)) {
      report(file, text, m.index ?? 0, `price "${m[0]}" is hard-coded — use <PlanTable /> or <Value />`);
    }
  }
  for (const gb of facts.storage) {
    for (const m of text.matchAll(new RegExp(`\\b${gb}\\s?GB\\b`, "gi"))) {
      report(file, text, m.index ?? 0, `storage "${m[0]}" is hard-coded — use <PlanTable /> or <Value />`);
    }
  }
  for (const n of facts.limits) {
    const re = new RegExp(
      `\\b${n}\\b[^\\n.]{0,24}\\b(messages?|emails?|recipients?|aliases|masked aliases|per day|per hour|a day|an hour)\\b`,
      "gi",
    );
    for (const m of text.matchAll(re)) {
      report(file, text, m.index ?? 0, `limit "${m[0]}" is hard-coded — use <SendLimitsTable /> or <PlanTable />`);
    }
  }
  if (facts.refundDays) {
    for (const m of text.matchAll(new RegExp(`\\b${facts.refundDays}[- ]days?\\b`, "gi"))) {
      report(file, text, m.index ?? 0, `refund window "${m[0]}" is hard-coded — use <Value of="refundWindowDays" />`);
    }
  }
}

function checkGraceDays(file, text) {
  if (!facts.graceDays) return;
  for (const m of text.matchAll(new RegExp(`\\b${facts.graceDays}[- ]days?\\b`, "gi"))) {
    report(
      file,
      text,
      m.index ?? 0,
      `grace period "${m[0]}" is hard-coded — use <Value of="mailboxDeleteGraceDays" />`,
    );
  }
}

function checkInternal(file, text) {
  for (const m of text.matchAll(/docs\/internal|\.\.\/internal\//g)) {
    report(file, text, m.index ?? 0, "references docs/internal — internal docs are never published");
  }
}

let count = 0;
for (const file of [...files(PUBLIC, [".md", ".mdx"]), ...files(SHARED_DOCS, [".mdx"])]) {
  const text = read(file);
  count += 1;
  if (file.startsWith(PUBLIC)) checkLinks(file, text);
  checkFacts(file, text);
  checkGraceDays(file, text);
  checkInternal(file, text);
}

if (problems.length > 0) {
  console.error("check:docs — public docs problems (CLAUDE.md rules 31–34):\n");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check:docs — ${count} public doc files: links resolve, no hard-coded facts, no internal references.`);
