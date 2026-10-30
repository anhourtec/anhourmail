// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { ANONYMOUS, ForbiddenError, systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryCounter } from "@anhourmail/server/rate-limit";
import { memoryMailer } from "@anhourmail/adapters/mail";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";

import { setContainerForTests } from "../container";
import { resetEnvForTests } from "../env";
import { pinnedAddress, pinnedKind, PinnedMailboxMissingError } from "../webmail/pin";
import { logPath, ok, readJson, readOptionalJson, route, routeTemplate } from "./route";

vi.mock("../auth/actor", () => ({ getActor: async () => ANONYMOUS }));
// The gate itself is tested in webmail/password-gate.test.ts; here only whether route() consults it.
vi.mock("../webmail/password-gate", () => ({
  PASSWORD_CHANGE_REQUIRED: "password_change_required",
  passwordChangeBlock: async (req: Request) =>
    req.headers.get("cookie")?.includes("am.webmail=flagged")
      ? Response.json({ error: { code: "password_change_required", message: "x" } }, { status: 403 })
      : null,
}));

// The access check itself is tested in webmail/access-block.test.ts; here only whether route() consults it, first.
vi.mock("../webmail/access-block", () => ({
  mailboxAccessBlock: async (req: Request) =>
    req.headers.get("cookie")?.includes("am.webmail=suspended")
      ? Response.json({ error: { code: "mailbox_unavailable", message: "x" } }, { status: 401 })
      : null,
}));

// The delegation gate itself is tested in webmail/delegation-gate.test.ts; here only whether route() consults it.
vi.mock("../webmail/delegation-gate", () => ({
  delegationBlock: async (req: Request, mode: string | undefined) =>
    req.headers.get("cookie")?.includes("am.webmail=delegated") && mode !== "allowed"
      ? Response.json(
          { error: { code: mode ? "not_found" : "own_mailbox_only", message: "x" } },
          { status: mode ? 404 : 403 },
        )
      : null,
}));

const params = { params: Promise.resolve({}) };
const noDns = { lookup: async () => [] };
let uow: MemoryUnitOfWork;

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
  uow = new MemoryUnitOfWork();
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter: memoryCounter(),
    mailer: memoryMailer(),
    dns: noDns,
    passwords: { hash: async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA" },
    breaches: { check: () => Promise.resolve("unknown") },
  });
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:43200", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("route()", () => {
  it("wraps the response with request id, no-store and rate-limit headers", async () => {
    const res = await route(async () => ok({ hi: 1 }))(
      new Request("http://localhost:43200/api/x", { headers: { "x-request-id": "abcdefgh123" } }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { hi: 1 } });
    expect(res.headers.get("x-request-id")).toBe("abcdefgh123");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("ratelimit-limit")).toBeTruthy();
  });

  it("keeps a handler's own Cache-Control only when the route asks for it", async () => {
    const cached = async () =>
      new Response("x", { headers: { "Cache-Control": "private, max-age=60", "Content-Security-Policy": "sandbox" } });
    const req = () => new Request("http://localhost:43200/api/x");
    const kept = await route(cached, { cache: "handler" })(req(), params);
    expect(kept.headers.get("cache-control")).toBe("private, max-age=60");
    expect(kept.headers.get("content-security-policy")).toBe("sandbox");
    expect((await route(cached)(req(), params)).headers.get("cache-control")).toBe("no-store");
    const failing = await route(
      async () => {
        throw new ForbiddenError();
      },
      { cache: "handler" },
    )(req(), params);
    expect(failing.headers.get("cache-control")).toBe("no-store");
  });

  it("maps domain errors, bad JSON and unexpected errors", async () => {
    const forbidden = await route(async () => {
      throw new ForbiddenError();
    })(new Request("http://localhost:43200/api/x"), params);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "forbidden" } });
    const bad = await route(async ({ req }) => ok(await readJson(req)))(
      post("http://localhost:43200/api/x", "{nope", { origin: "http://localhost:43200" }),
      params,
    );
    expect(bad.status).toBe(400);
    const boom = await route(async () => {
      throw new Error("secret detail");
    })(new Request("http://localhost:43200/api/x"), params);
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("secret detail");
  });

  it("reads an optional body: none (or whitespace) is null, JSON is parsed, malformed JSON is a 400", async () => {
    const same = { origin: "http://localhost:43200" };
    const optional = route(async ({ req }) => ok(await readOptionalJson(req)));
    const none = await optional(post("http://localhost:43200/api/x", "", same), params);
    expect(await none.json()).toEqual({ data: null });
    const blank = await optional(post("http://localhost:43200/api/x", "  \n", same), params);
    expect(await blank.json()).toEqual({ data: null });
    const json = await optional(post("http://localhost:43200/api/x", { a: 1 }, same), params);
    expect(await json.json()).toEqual({ data: { a: 1 } });
    const bad = await optional(post("http://localhost:43200/api/x", "{nope", same), params);
    expect(bad.status).toBe(400);
  });

  it("blocks cross-origin writes and writes without an origin", async () => {
    const handler = async () => ok(true);
    const evil = await route(handler)(
      post("http://localhost:43200/api/x", {}, { origin: "https://evil.example" }),
      params,
    );
    expect(evil.status).toBe(403);
    const same = await route(handler)(
      post("http://localhost:43200/api/x", {}, { origin: "http://localhost:43200" }),
      params,
    );
    expect(same.status).toBe(200);
    const site = await route(handler)(
      post("http://localhost:43200/api/x", {}, { origin: "http://localhost:43100" }),
      params,
    );
    expect(site.status).toBe(403);
    const noOrigin = await route(handler)(post("http://localhost:43200/api/x", {}), params);
    expect(noOrigin.status).toBe(403);
  });

  it("returns 429 past the limit", async () => {
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
    const h = route(async () => ok(true), { limit: "export" });
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await h(new Request("http://localhost:43200/api/export"), params)).status;
    expect(last).toBe(429);
  });
});

describe("security hardening (audit 2026-10-21)", () => {
  it("never logs one-time tokens in paths", () => {
    expect(logPath("/api/auth/reset-password/abc123TOKEN")).toBe("/api/auth/reset-password/[redacted]");
    expect(logPath("/invite/xyz?x=1")).toBe("/invite/[redacted]?x=1");
    expect(logPath("/api/me")).toBe("/api/me");
  });

  it("refuses per-IP routes without a client address in production instead of sharing one bucket", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BREACHED_PASSWORD_CHECK", undefined);
    vi.stubEnv("TRUST_PROXY", "true");
    vi.stubEnv("APP_URL", "https://app.example.test");
    vi.stubEnv("WEBMAIL_URL", "https://mail.example.test");
    vi.stubEnv("SITE_URL", "https://example.test");
    vi.stubEnv("PLATFORM_DOMAIN", "example.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "y".repeat(48));
    vi.stubEnv("SECRETS_KEYRING", `k1:${Buffer.alloc(32, 1).toString("base64")}`);
    vi.stubEnv("MAILBOX_PASSWORD_GRANT_KEY", "g".repeat(48));
    vi.stubEnv("SENDER_DELEGATION_KEY", "d".repeat(64));
    vi.stubEnv("STALWART_OPERATIONS_KEY", "operations-key");
    resetEnvForTests();
    const res = await route(async () => ok(true), { limit: "publicForm" })(
      post("https://app.example.test/api/example", {}, { origin: "https://app.example.test" }),
      params,
    );
    expect(res.status).toBe(400);
  });

  it("names rate-limit buckets by route pattern, so varying ids never yields a fresh bucket", async () => {
    expect(routeTemplate("/api/webmail/messages/abc", { emailId: "abc" })).toBe("/api/webmail/messages/:emailId");
    expect(routeTemplate("/api/accounts/a%20b/mailboxes/m1", { accountId: "a b", mailboxId: "m1" })).toBe(
      "/api/accounts/:accountId/mailboxes/:mailboxId",
    );
    expect(routeTemplate("/api/auth/sign-in/email", { all: ["sign-in", "email"] })).toBe("/api/auth/:all/:all");
    expect(routeTemplate("/api/x/%E0%A4%A", {})).toBe("/api/x/%E0%A4%A");

    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
    const handler = route(async () => ok(true), { limit: "webmailDownload" });
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      const id = `blob${String(i)}`;
      const res = await handler(new Request(`http://localhost:43200/api/webmail/download/${id}`), {
        params: Promise.resolve({ blobId: id }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
    // A route's own CSP is kept; otherwise API responses get a strict one.
    const own = await route(
      async () => new Response("x", { headers: { "Content-Security-Policy": "default-src 'none'; sandbox" } }),
    )(new Request("http://localhost:43200/api/webmail/x"), {});
    expect(own.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(
      (await route(async () => ok(1))(new Request("http://localhost:43200/api/x"), {})).headers.get(
        "content-security-policy",
      ),
    ).toBe("default-src 'none'; frame-ancestors 'none'");
    // Static routes get no params from Next.
    const plain = await route(async () => ok(true))(new Request("http://localhost:43200/api/me"), {});
    expect(plain.status).toBe(200);
  });
});

describe("webmail first-sign-in password change", () => {
  const get = (cookie: string) =>
    new Request("http://localhost:43300/api/webmail/session", { headers: { cookie, host: "localhost:43300" } });

  it("blocks every webmail route while the mailbox must change its password, before the handler runs", async () => {
    let ran = false;
    const handler = route(
      async () => {
        ran = true;
        return ok(true);
      },
      { session: "webmail", limit: "webmail" },
    );
    const res = await handler(get("am.webmail=flagged"), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "password_change_required" } });
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(ran).toBe(false);
    expect((await handler(get("am.webmail=fine"), params)).status).toBe(200);
  });

  it("answers the routes that opt in (password change, sign-out) and never gates console routes", async () => {
    const allowed = route(async () => ok(true), { session: "webmail", passwordChange: "allowed" });
    expect((await allowed(get("am.webmail=flagged"), params)).status).toBe(200);
    const consoleRoute = route(async () => ok(true));
    expect((await consoleRoute(get("am.webmail=flagged"), params)).status).toBe(200);
  });
});

describe("webmail control-plane access", () => {
  const get = (cookie: string) =>
    new Request("http://localhost:43300/api/webmail/session", { headers: { cookie, host: "localhost:43300" } });

  it("refuses a blocked mailbox on every webmail route, opt-ins included, before the handler runs", async () => {
    let ran = false;
    const handler = (opts: Parameters<typeof route>[1]) =>
      route(async () => {
        ran = true;
        return ok(true);
      }, opts);
    for (const opts of [
      { session: "webmail" as const },
      { session: "webmail" as const, passwordChange: "allowed" as const },
    ]) {
      const res = await handler(opts)(get("am.webmail=suspended"), params);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "mailbox_unavailable" } });
    }
    expect(ran).toBe(false);
    expect((await handler({ session: "webmail" })(get("am.webmail=fine"), params)).status).toBe(200);
    // Console routes never consult it.
    expect((await handler({})(get("am.webmail=suspended"), params)).status).toBe(200);
  });

  it("consults the delegation gate on webmail routes with the route's mode, before the handler and the password gate", async () => {
    let ran = 0;
    const handler = (opts: Parameters<typeof route>[1]) =>
      route(async () => {
        ran += 1;
        return ok(true);
      }, opts);
    const own = await handler({ session: "webmail" })(get("am.webmail=delegated"), params);
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({ error: { code: "own_mailbox_only" } });
    const gone = await handler({ session: "webmail", delegated: "full_access" })(get("am.webmail=delegated"), params);
    expect(gone.status).toBe(404);
    expect(ran).toBe(0);
    expect(
      (await handler({ session: "webmail", delegated: "allowed" })(get("am.webmail=delegated"), params)).status,
    ).toBe(200);
    // A blocked mailbox is answered first; console routes never consult the gate.
    expect(
      (await handler({ session: "webmail" })(get("am.webmail=suspended;am.webmail=delegated"), params)).status,
    ).toBe(401);
    expect((await handler({})(get("am.webmail=delegated"), params)).status).toBe(200);
    expect(ran).toBe(2);
  });

  it("runs webmail routes pinned to the tab's shared mailbox, and refuses a pin it can't honour (Open another mailbox)", async () => {
    const seen: (string | null)[] = [];
    const kinds: (string | null)[] = [];
    const pinned = (opts: Parameters<typeof route>[1], fail = false) =>
      route(async () => {
        seen.push(pinnedAddress());
        kinds.push(pinnedKind());
        if (fail) throw new PinnedMailboxMissingError("not open");
        return ok(true);
      }, opts);
    const at = (headers: Record<string, string>, query = "") =>
      new Request(`http://localhost:43300/api/webmail/x${query}`, { headers });
    expect((await pinned({ session: "webmail" })(at({ "x-webmail-shared": "Desk@Family.test" }), params)).status).toBe(
      200,
    );
    expect((await pinned({ session: "webmail" })(at({}, "?shared=desk%40family.test"), params)).status).toBe(200);
    expect((await pinned({ session: "webmail" })(at({}), params)).status).toBe(200);
    // Console routes never pin.
    expect((await pinned({})(at({ "x-webmail-shared": "desk@family.test" }), params)).status).toBe(200);
    // A shared tab's compose requests pin the person's own mailbox (header only); both kinds at once are refused.
    expect((await pinned({ session: "webmail" })(at({ "x-webmail-own": "Kim@Family.test" }), params)).status).toBe(200);
    expect(kinds.at(-1)).toBe("own");
    expect(
      (
        await pinned({ session: "webmail" })(
          at({ "x-webmail-own": "kim@family.test", "x-webmail-shared": "desk@family.test" }),
          params,
        )
      ).status,
    ).toBe(404);
    expect(seen).toEqual(["desk@family.test", "desk@family.test", null, null, "kim@family.test"]);
    expect(kinds).toEqual(["shared", "shared", null, null, "own"]);
    // A malformed pin, or one naming no open shared mailbox: the one delegation refusal, marked for the tab.
    for (const res of [
      await pinned({ session: "webmail" })(at({ "x-webmail-shared": "not-an-address" }), params),
      await pinned({ session: "webmail" }, true)(at({ "x-webmail-shared": "desk@family.test" }), params),
    ]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("x-webmail-refused")).toBe("mailbox");
      expect(await res.json()).toEqual({
        error: { code: "not_found", message: "You don't have access to this mailbox." },
      });
    }
  });
});
