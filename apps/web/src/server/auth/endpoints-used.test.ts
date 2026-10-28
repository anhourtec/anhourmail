// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { authEndpoint } from "./endpoints";

const SRC = path.join(import.meta.dirname, "..", "..");

/** Every page and component source file (not API routes, not tests). */
function uiFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (full !== path.join(SRC, "app", "api")) uiFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

type Call = { method: "GET" | "POST"; path: string; file: string };

/**
 * The better-auth endpoints the browser code calls: `fetch("/api/auth/…")` literals, `authCall("/…", { method })`
 * (every string literal in the first argument, so a ternary counts both sides) and the two-factor settings' `run("/…")`
 * wrapper, which posts through `authCall`.
 */
function usedEndpoints(): Call[] {
  const calls: Call[] = [];
  for (const file of uiFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(SRC, file);
    for (const m of src.matchAll(/fetch\(\s*["'`]\/api\/auth(\/[^"'`$?]+)["'`]([\s\S]{0,200})/g)) {
      const method = /method:\s*"(GET|POST)"/.exec(m[2] ?? "")?.[1] === "POST" ? "POST" : "GET";
      calls.push({ method, path: m[1] ?? "", file: rel });
    }
    if (!src.includes("authCall")) continue;
    for (const m of src.matchAll(/authCall\(\s*([^{]*?),\s*\{\s*method:\s*"(GET|POST)"/g)) {
      for (const lit of (m[1] ?? "").matchAll(/"(\/[^"]+)"/g)) {
        calls.push({ method: m[2] === "GET" ? "GET" : "POST", path: lit[1] ?? "", file: rel });
      }
    }
    for (const m of src.matchAll(/\brun\(\s*"(\/[^"]+)"/g)) calls.push({ method: "POST", path: m[1] ?? "", file: rel });
  }
  return calls;
}

describe("auth endpoints the UI calls", () => {
  const calls = usedEndpoints();

  it("finds the calls (the scan itself works)", () => {
    const seen = new Set(calls.map((c) => `${c.method} ${c.path}`));
    expect([...seen]).toEqual(
      expect.arrayContaining([
        "POST /sign-in/email",
        "POST /change-password",
        "POST /two-factor/verify-backup-code",
        "POST /two-factor/enable",
        "GET /passkey/generate-authenticate-options",
        "POST /step-up",
      ]),
    );
  });

  it("are all on the allow-list (anything else answers 404)", () => {
    const missing = calls.filter((c) => authEndpoint(c.method, `/api/auth${c.path}`) === null);
    expect(missing).toEqual([]);
  });
});
