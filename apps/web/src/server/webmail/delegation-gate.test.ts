// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLogSinkForTests } from "@anhourmail/server/log";

import { resetEnvForTests } from "../env";
import { delegationBlock, type DelegationGateDeps } from "./delegation-gate";
import { WebmailSignedOutError } from "./service";
import type { WebmailSession } from "./session-store";

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
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
  setLogSinkForTests(null);
});

const withCookie = (cookie?: string) =>
  new Request("http://localhost:43300/api/webmail/jmap", { method: "POST", headers: cookie ? { cookie } : {} });

const own: WebmailSession = {
  username: "kim@family.test",
  accountId: "acc-kim",
  accessToken: "at",
  refreshToken: null,
  expiresAt: 9e12,
  createdAt: 0,
};
const shared: WebmailSession = {
  ...own,
  username: "desk@family.test",
  accountId: "acc-desk",
  delegated: { mailboxId: "m-desk", granteeUserId: "kim", via: "kim@family.test" },
  others: [own],
};

function fake(sessions: Record<string, WebmailSession>, allowed: boolean | Error) {
  const dropped: string[] = [];
  const deps: DelegationGateDeps = {
    session: async (id) => sessions[id] ?? null,
    allowed: async () => {
      if (allowed instanceof Error) throw allowed;
      return allowed;
    },
    drop: async (_id, username) => {
      dropped.push(username);
    },
  };
  return { deps, dropped };
}

describe("webmail delegation gate", () => {
  it("lets sessions without a delegated active mailbox through, and leaves signed-out requests to the route", async () => {
    const { deps } = fake({ s1: own }, false);
    for (const mode of [undefined, "full_access", "allowed"] as const) {
      expect(await delegationBlock(withCookie("am.webmail=s1"), mode, deps)).toBeNull();
      expect(await delegationBlock(withCookie("am.webmail=gone"), mode, deps)).toBeNull();
      expect(await delegationBlock(withCookie(), mode, deps)).toBeNull();
    }
  });

  it("refuses routes that need the person's own mailbox with 403 own_mailbox_only while a shared one is active", async () => {
    const { deps, dropped } = fake({ s1: shared }, true);
    const res = await delegationBlock(withCookie("am.webmail=s1"), undefined, deps);
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ error: { code: "own_mailbox_only" } });
    expect(dropped).toEqual([]);
  });

  it("checks the grant on read-and-manage routes: allowed goes on, refused drops the entry and answers 404", async () => {
    expect(
      await delegationBlock(withCookie("am.webmail=s1"), "full_access", fake({ s1: shared }, true).deps),
    ).toBeNull();
    const refused = fake({ s1: shared }, false);
    const res = await delegationBlock(withCookie("am.webmail=s1"), "full_access", refused.deps);
    expect(res?.status).toBe(404);
    expect(res?.headers.get("x-webmail-refused")).toBe("mailbox");
    expect(await res?.json()).toEqual({
      error: { code: "not_found", message: "You don't have access to this mailbox." },
    });
    expect(refused.dropped).toEqual(["desk@family.test"]);
    // Can't tell (the database is down): refused for now, nothing dropped.
    const down = fake({ s1: shared }, new Error("db down"));
    expect((await delegationBlock(withCookie("am.webmail=s1"), "full_access", down.deps))?.status).toBe(503);
    expect(down.dropped).toEqual([]);
    // The person's own sign-in no longer holds at the mail server: the session has ended, answered 401.
    const ended = fake({ s1: shared }, new WebmailSignedOutError("own mailbox signed out"));
    const res401 = await delegationBlock(withCookie("am.webmail=s1"), "full_access", ended.deps);
    expect(res401?.status).toBe(401);
    expect(ended.dropped).toEqual([]);
    // Listing, switching and signing out work whatever is active.
    expect(await delegationBlock(withCookie("am.webmail=s1"), "allowed", refused.deps)).toBeNull();
  });

  it("is pinned per route: what may read a shared mailbox, what works whatever is active, everything else refused", () => {
    const full: string[] = [];
    const allowed: string[] = [];
    const ownOnly: string[] = [];
    const stray: string[] = [];
    for (const file of routeFiles(API).sort()) {
      for (const h of handlers(file)) {
        const key = `${h.method} ${file}`;
        if (h.options === "") throw new Error(`${key}: no route options found`);
        const mode = /delegated: "([a-z_]+)"/.exec(h.options)?.[1];
        // Routes without a webmail session never act on a mailbox of one; an unknown mode is a mistake.
        if (!h.options.includes('session: "webmail"')) {
          if (h.options.includes("delegated:")) stray.push(key);
        } else if (mode === "full_access") full.push(key);
        else if (mode === "allowed") allowed.push(key);
        else if (h.options.includes("delegated:")) stray.push(key);
        else ownOnly.push(key);
      }
    }
    expect(stray).toEqual([]);
    // ADR-0026 §6 "What each right allows": reads, downloads, attachments, original, print, image proxy (and the
    // session document and photos the reader shows) for read and manage.
    expect(full).toEqual([
      "GET avatars/[kind]/[id]/route.ts",
      "POST avatars/lookup/route.ts",
      "GET avatars/route.ts",
      "GET download/[blobId]/route.ts",
      "POST img/route.ts",
      "POST jmap/route.ts",
      "GET messages/[emailId]/attached/[blobId]/route.ts",
      "GET messages/[emailId]/print/route.ts",
      "GET messages/[emailId]/raw/route.ts",
      "GET messages/[emailId]/route.ts",
      "GET preview/[blobId]/route.ts",
      "GET session/route.ts",
    ]);
    expect(allowed).toEqual([
      "DELETE auth/route.ts",
      "PUT mailboxes/active/route.ts",
      "POST mailboxes/delegated/route.ts",
      "GET mailboxes/route.ts",
      "POST mailboxes/route.ts",
    ]);
    // Sending, drafts, uploads, identities, settings, contacts and export always need the person's own mailbox.
    for (const key of [
      "POST send/route.ts",
      "POST send/undo/route.ts",
      "PUT drafts/route.ts",
      "POST upload/route.ts",
      "GET identities/route.ts",
      "GET senders/route.ts",
      "GET settings/route.ts",
      "POST settings/password/route.ts",
      "PUT settings/forwarding/route.ts",
      "PUT settings/vacation/route.ts",
      "GET contacts/route.ts",
      "GET export/route.ts",
    ]) {
      expect(ownOnly).toContain(key);
    }
  });
});
