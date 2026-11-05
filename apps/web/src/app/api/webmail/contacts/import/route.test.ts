// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { ANONYMOUS, systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { LIMITS, memoryCounter } from "@anhourmail/server/rate-limit";
import { IMPORT } from "@anhourmail/shared/import";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { setContainerForTests } from "@/server/container";
import { resetEnvForTests } from "@/server/env";
import type { ContactsImportFile } from "@/server/webmail/service";
import { WebmailOwnMailboxOnlyError, WebmailRefusedError } from "@/server/webmail/service";

import { POST } from "./route";

/** What the route handed the BFF, and what the fake answers. */
const calls: { account: string; file: ContactsImportFile }[] = [];
let answer: () => Promise<unknown> = async () => ({ created: 1, merged: 0, duplicates: 0, invalid: 0, overCap: 0 });

vi.mock("@/server/auth/actor", () => ({ getActor: async () => ANONYMOUS }));
// The control-plane gates `route()` runs for webmail routes have their own tests: open here.
vi.mock("@/server/webmail/access-block", () => ({ mailboxAccessBlock: async () => null }));
vi.mock("@/server/webmail/delegation-gate", () => ({ delegationBlock: async () => null }));
vi.mock("@/server/webmail/password-gate", () => ({
  PASSWORD_CHANGE_REQUIRED: "password_change_required",
  passwordChangeBlock: async () => null,
}));
vi.mock("@/server/webmail/instance", () => ({
  webmailSessionId: (cookie: string | null) => (cookie?.includes("am.webmail=") ? "sid" : null),
  webmailCookie: () => "am.webmail=; Max-Age=0",
  webmail: () => ({
    importContacts: async (
      _id: string,
      account: string,
      file: ContactsImportFile,
      onDone?: (address: string, counts: Record<string, number>) => Promise<void>,
    ) => {
      calls.push({ account, file });
      const counts = (await answer()) as Record<string, number>;
      await onDone?.("nobody@x.test", counts);
      return counts;
    },
  }),
}));

beforeEach(() => {
  vi.stubEnv("APP_URL", "http://localhost:43200");
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  resetEnvForTests();
  setContainerForTests({
    deps: { uow: new MemoryUnitOfWork(), clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: { check: () => Promise.resolve("unknown") },
  });
  setLogSinkForTests(() => undefined);
  calls.length = 0;
  answer = async () => ({ created: 1, merged: 0, duplicates: 0, invalid: 0, overCap: 0 });
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const post = (query: string, body: BodyInit, opts: { cookie?: boolean; account?: boolean; length?: number } = {}) =>
  POST(
    new Request(`http://localhost:43300/api/webmail/contacts/import${query}`, {
      method: "POST",
      headers: {
        host: "localhost:43300",
        origin: "http://localhost:43300",
        "content-type": "text/csv",
        ...(opts.account === false ? {} : { "x-webmail-account": "acc1" }),
        ...(opts.cookie === false ? {} : { cookie: "am.webmail=s1" }),
        ...(opts.length === undefined ? {} : { "content-length": String(opts.length) }),
      },
      body,
    }),
    { params: Promise.resolve({}) },
  );

describe("POST /api/webmail/contacts/import", () => {
  it("answers 401 without a webmail session and 400 without the account the tab shows", async () => {
    expect((await post("", "BEGIN:VCARD", { cookie: false })).status).toBe(401);
    expect((await post("", "BEGIN:VCARD", { account: false })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses cross-origin uploads", async () => {
    const res = await POST(
      new Request("http://localhost:43300/api/webmail/contacts/import", {
        method: "POST",
        headers: { host: "localhost:43300", origin: "https://evil.example", cookie: "am.webmail=s1" },
        body: "x",
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("passes a vCard (the default) and a CSV with its mapping to the BFF, which parses the file itself", async () => {
    const vc = await post("", "BEGIN:VCARD\r\nFN:A\r\nEND:VCARD\r\n");
    expect(vc.status).toBe(200);
    expect(await vc.json()).toEqual({
      data: { format: "vcard", created: 1, merged: 0, duplicates: 0, invalid: 0, overCap: 0 },
    });
    expect(calls[0]).toMatchObject({ account: "acc1", file: { format: "vcard" } });
    expect(new TextDecoder().decode(calls[0]?.file.bytes)).toContain("FN:A");

    const csv = await post("?format=csv&columns=given,,emails", "First,Middle,E-mail\r\nSam,J,s@x.test\r\n");
    expect(csv.status).toBe(200);
    expect(((await csv.json()) as { data: { format: string } }).data.format).toBe("csv");
    expect(calls[1]?.file).toMatchObject({ format: "csv", columns: ["given", null, "emails"] });
  });

  it("refuses an unknown format, a missing or unknown mapping, and a file over the size limit", async () => {
    for (const q of ["?format=xlsx", "?format=csv", "?format=csv&columns=given,password", "?format=csv&columns="]) {
      const res = await post(q, "a,b\r\n1,2\r\n");
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
    }
    const big = await post("?format=vcard", "x", { length: IMPORT.contactsMaxBytes + 1 });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({
      error: { code: "too_large", message: "Contact files can be up to 5 MB." },
    });
    expect(calls).toEqual([]);
  });

  it("maps the BFF's refusals: a bad file is 400, a mailbox shared with the person is 403", async () => {
    answer = async () => {
      throw new WebmailRefusedError("This file isn't saved as UTF-8.");
    };
    const bad = await post("?format=csv&columns=given", "x\r\n");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "refused", message: "This file isn't saved as UTF-8." } });
    answer = async () => {
      throw new WebmailOwnMailboxOnlyError("own mailbox only");
    };
    const shared = await post("", "BEGIN:VCARD");
    expect(shared.status).toBe(403);
    expect(await shared.json()).toMatchObject({ error: { code: "own_mailbox_only" } });
  });

  it("is on the upload tier", async () => {
    const res = await post("", "BEGIN:VCARD");
    expect(res.headers.get("ratelimit-limit")).toBe(String(LIMITS.webmailUpload.limit));
  });
});
