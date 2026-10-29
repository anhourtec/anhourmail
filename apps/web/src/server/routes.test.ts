// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "@anhourmail/shared/rbac";

import { ROUTES } from "./routes";

const APP = path.join(import.meta.dirname, "..", "app");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === "route.ts") out.push(path.relative(path.join(APP, ".."), full));
  }
  return out;
}

describe("route registry", () => {
  it("lists every API route file exactly once (the RBAC harness depends on it)", () => {
    const files = routeFiles(path.join(APP, "api")).sort();
    const registered = [...new Set(ROUTES.map((r) => r.file))].sort();
    expect(registered).toEqual(files);
  });

  it("guards are real permissions or known keywords; account routes name their parameter", () => {
    const permissioned = ROUTES.filter((r) => !["public", "session", "webmail", "infra", "act_as"].includes(r.guard));
    for (const r of permissioned) expect(PERMISSIONS).toHaveProperty(r.guard);
    const accountScoped = permissioned.filter(
      (r) => PERMISSIONS[r.guard as keyof typeof PERMISSIONS].scope === "account",
    );
    for (const r of accountScoped) expect(r.accountParam).toBeTruthy();
  });
});
