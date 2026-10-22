#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Asks the dev server for every console/webmail page and API route once, so CI's e2e journeys don't wait on
 * Next compiling a route on its first request (a cold compile on a CI runner can outlast a 5 s assertion).
 * Signed-out requests are enough: Next compiles a route before it answers, whatever the answer is.
 *
 * Usage: node scripts/warm-routes.mjs [baseUrl]   (default http://127.0.0.1:$WEB_DEV_PORT)
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const APP_DIR = "apps/web/src/app";
const BASE = process.argv[2] ?? `http://127.0.0.1:${process.env.WEB_DEV_PORT ?? "43200"}`;
const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const CONCURRENCY = 3;
const TIMEOUT_MS = 180_000;

/** Every directory under the app folder holding a page or route file, as a URL path. */
function* routes(dir, segments) {
  const names = readdirSync(dir);
  if (names.some((n) => /^(page|route)\.tsx?$/.test(n))) yield toPath(segments);
  for (const name of names) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* routes(full, [...segments, name]);
  }
}

function toPath(segments) {
  const parts = segments
    .filter((s) => !/^\(.*\)$/.test(s)) // route groups don't appear in the URL
    .map((s) => (s.startsWith("[...") ? "x" : s.startsWith("[") ? SAMPLE_ID : s));
  return `/${parts.join("/")}`;
}

async function warm(urlPath) {
  const started = Date.now();
  try {
    const res = await fetch(new URL(urlPath, BASE), { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    return `${String(res.status)} ${urlPath} (${String(Date.now() - started)} ms)`;
  } catch (err) {
    return `ERR ${urlPath} (${err instanceof Error ? err.name : "error"})`;
  }
}

const queue = [...new Set(routes(APP_DIR, []))];
const started = Date.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) console.log(await warm(next));
  }),
);
console.log(`warmed in ${String(Math.round((Date.now() - started) / 1000))} s`);
