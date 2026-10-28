// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvForTests } from "../env";
import { PASSWORD_CHANGE_REQUIRED, passwordChangeBlock, type PasswordGateDeps } from "./password-gate";

const API = path.join(import.meta.dirname, "..", "..", "app", "api", "webmail");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === "route.ts") out.push(path.relative(API, full));
  }
  return out;
}

/** Each exported handler of a route file with its options object (`export const GET = route(…, { … });`). */
function handlers(file: string): { method: string; options: string }[] {
  const src = readFileSync(path.join(API, file), "utf8");
  return [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = route\(/g)].map((m, i, all) => {
    const end = all[i + 1]?.index ?? src.length;
    const body = src.slice(m.index, end);
    const options = /\n {2}(\{[^\n]*\}),?\n\);/.exec(body)?.[1] ?? "";
    return { method: m[1] ?? "", options };
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", "http://localhost:43200");
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  resetEnvForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const withCookie = (cookie?: string) =>
  new Request("http://localhost:43300/api/webmail/jmap", { method: "POST", headers: cookie ? { cookie } : {} });

const deps = (flagged: Record<string, boolean>, sessions: Record<string, string>): PasswordGateDeps => ({
  username: async (id) => sessions[id] ?? null,
  required: async (address) => flagged[address] === true,
});

describe("webmail password-change gate", () => {
  it("refuses a session whose mailbox must change its password with 403 password_change_required", async () => {
    const res = await passwordChangeBlock(
      withCookie("am.webmail=s1"),
      deps({ "kid@family.ca": true }, { s1: "kid@family.ca" }),
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ error: { code: PASSWORD_CHANGE_REQUIRED } });
  });

  it("lets other sessions through, and leaves signed-out requests to the route (401)", async () => {
    const d = deps({ "kid@family.ca": true }, { s1: "mum@family.ca" });
    expect(await passwordChangeBlock(withCookie("am.webmail=s1"), d)).toBeNull();
    expect(await passwordChangeBlock(withCookie("am.webmail=gone"), d)).toBeNull();
    expect(await passwordChangeBlock(withCookie(), d)).toBeNull();
    expect(await passwordChangeBlock(withCookie("am.session_token=console"), d)).toBeNull();
  });

  it("checks the session's active mailbox, not one it merely holds", async () => {
    const d = deps({ "mum@family.ca": true }, { s1: "kid@family.ca", s2: "mum@family.ca" });
    expect(await passwordChangeBlock(withCookie("am.webmail=s1"), d)).toBeNull();
    expect((await passwordChangeBlock(withCookie("am.webmail=s2"), d))?.status).toBe(403);
  });

  it("is skipped only by changing the password and signing out; every other webmail route is blocked", () => {
    const allowed: string[] = [];
    const blocked: string[] = [];
    const unsessioned: string[] = [];
    for (const file of routeFiles(API).sort()) {
      for (const h of handlers(file)) {
        const key = `${h.method} ${file}`;
        if (h.options === "") throw new Error(`${key}: no route options found`);
        if (!h.options.includes('session: "webmail"')) unsessioned.push(key);
        else if (h.options.includes('passwordChange: "allowed"')) allowed.push(key);
        else blocked.push(key);
      }
    }
    expect(allowed).toEqual(["DELETE auth/route.ts", "POST settings/password/route.ts"]);
    // No webmail session: sign-in (it starts one) and the forwarding confirmation link (opened by the target).
    expect(unsessioned).toEqual(["POST auth/route.ts", "POST forwarding/confirm/route.ts"]);
    for (const key of [
      "POST jmap/route.ts",
      "POST send/route.ts",
      "POST upload/route.ts",
      "GET download/[blobId]/route.ts",
      "GET session/route.ts",
      "GET messages/[emailId]/raw/route.ts",
      "PUT settings/forwarding/route.ts",
      "PUT mailboxes/active/route.ts",
    ]) {
      expect(blocked).toContain(key);
    }
  });
});
