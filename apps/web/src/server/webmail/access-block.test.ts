// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebmailAccess } from "@anhourmail/core/webmail";
import { SUPPORT_EMAIL } from "@anhourmail/shared/platform";

import { resetEnvForTests } from "../env";
import { type AccessBlockDeps, mailboxAccessBlock } from "./access-block";
import { BLOCKED_NOTICES, NOTICE_COOKIE } from "./http";

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

function deps(states: Record<string, WebmailAccess>, sessions: Record<string, string>) {
  const ended: string[] = [];
  const d: AccessBlockDeps = {
    username: async (id) => sessions[id] ?? null,
    state: async (address) => states[address] ?? "gone",
    end: async (id) => {
      ended.push(id);
    },
  };
  return { d, ended };
}

describe("webmail access check on every route", () => {
  it("ends the session of a suspended person and says so, with the appeal address", async () => {
    const { d, ended } = deps({ "member@group.test": "person_suspended" }, { s1: "member@group.test" });
    const res = await mailboxAccessBlock(withCookie("am.webmail=s1"), d);
    expect(res?.status).toBe(401);
    const body = (await res?.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("mailbox_unavailable");
    expect(body.error.message).toBe(BLOCKED_NOTICES.person_suspended);
    expect(body.error.message).toContain(SUPPORT_EMAIL);
    expect(ended).toEqual(["s1"]);
    const cookies = res?.headers.getSetCookie() ?? [];
    expect(cookies.some((c) => c.startsWith("am.webmail=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${NOTICE_COOKIE}=person_suspended;`))).toBe(true);
  });

  it("names each reason: suspended mailbox, being deleted, gone", async () => {
    for (const reason of ["suspended", "deleting", "gone"] as const) {
      const { d } = deps({ "a@x.test": reason }, { s1: "a@x.test" });
      const res = await mailboxAccessBlock(withCookie("am.webmail=s1"), d);
      expect(((await res?.json()) as { error: { message: string } }).error.message).toBe(BLOCKED_NOTICES[reason]);
    }
    expect(BLOCKED_NOTICES.deleting).not.toContain("suspended");
    expect(BLOCKED_NOTICES.gone).not.toContain("suspended");
  });

  it("lets working mailboxes through and leaves signed-out requests to the route", async () => {
    const { d, ended } = deps({ "a@x.test": "ok" }, { s1: "a@x.test" });
    expect(await mailboxAccessBlock(withCookie("am.webmail=s1"), d)).toBeNull();
    expect(await mailboxAccessBlock(withCookie("am.webmail=missing"), d)).toBeNull();
    expect(await mailboxAccessBlock(withCookie(), d)).toBeNull();
    expect(await mailboxAccessBlock(withCookie("am.session_token=console"), d)).toBeNull();
    expect(ended).toEqual([]);
  });
});
