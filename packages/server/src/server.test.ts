// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";

import { clientIp } from "./client-ip";
import { appVersion, liveness, probe } from "./health";
import { log, redact, setLogSinkForTests } from "./log";
import { callerKey, checkRateLimit, LIMITS, memoryCounter, redisCounter } from "./rate-limit";
import { requestContext, requestIdFrom, runWithRequestContext } from "./request-context";

afterEach(() => {
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
});

describe("logger", () => {
  it("writes one JSON line with request id, redacting secrets and mail content", () => {
    const lines: string[] = [];
    setLogSinkForTests((l) => lines.push(l));
    runWithRequestContext({ requestId: "req-abcdefgh", userId: "u1" }, () => {
      log.child({ component: "test" }).info("hello", {
        password: "p",
        subject: "private",
        nested: { authorization: "Bearer abc.def" },
        note: "Bearer xyz123",
        err: new Error("boom"),
      });
    });
    const rec = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(rec).toMatchObject({
      level: "info",
      msg: "hello",
      requestId: "req-abcdefgh",
      userId: "u1",
      component: "test",
    });
    expect(rec.password).toBe("[redacted]");
    expect(rec.subject).toBe("[redacted]");
    expect(rec.note).toBe("Bearer [redacted]");
    expect(rec.err).toMatchObject({ type: "Error", message: "boom" });
    expect(rec.err).not.toHaveProperty("stack");
  });

  it("respects LOG_LEVEL and keeps stacks at error", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const lines: string[] = [];
    setLogSinkForTests((l) => lines.push(l));
    log.info("dropped");
    log.error("kept", { err: new Error("x") });
    expect(lines).toHaveLength(1);
    expect(log.enabled("debug")).toBe(false);
    expect((JSON.parse(lines[0] ?? "{}") as { err: { stack?: string } }).err.stack).toBeTruthy();
  });

  it("silent level and pretty mode", () => {
    vi.stubEnv("LOG_LEVEL", "silent");
    const lines: string[] = [];
    setLogSinkForTests((l) => lines.push(l));
    log.fatal("nothing");
    expect(lines).toHaveLength(0);
    vi.stubEnv("LOG_LEVEL", "info");
    vi.stubEnv("LOG_PRETTY", "true");
    setLogSinkForTests((l) => lines.push(l));
    log.at("warn", "pretty", { a: 1 });
    expect(lines[0]).toMatch(/WARN\s+pretty\s+a=1/);
  });

  it("redact handles cycles, depth, arrays, dates, bigints and headers", () => {
    const a: Record<string, unknown> = {
      when: new Date("2026-01-01T00:00:00Z"),
      big: 10n,
      list: Array.from({ length: 60 }, (_, i) => i),
    };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.self).toBe("[circular]");
    expect(out.when).toBe("2026-01-01T00:00:00.000Z");
    expect(out.big).toBe("10");
    expect((out.list as unknown[]).length).toBe(50);
    expect(redact(new Headers({ cookie: "c", accept: "x" }))).toEqual({ accept: "x", cookie: "[redacted]" });
    // SMTP errors name recipients; addresses in free text are masked (rule 24).
    expect(redact(new Error("550 5.1.1 <pat.smith@example.com>: rejected"))).toMatchObject({
      message: "550 5.1.1 <p***@example.com>: rejected",
    });
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 10; i++) deep = deep.n = {} as Record<string, unknown>;
    expect(JSON.stringify(redact(root))).toContain("[truncated]");
    expect(redact(new Date(Number.NaN))).toBeNull();
    expect((redact("x".repeat(3000)) as string).length).toBeLessThan(2100);
  });
});

describe("request context", () => {
  it("accepts a sane X-Request-Id, otherwise generates one", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": "abcd1234efgh" }))).toBe("abcd1234efgh");
    expect(requestIdFrom(new Headers({ "x-request-id": "bad id!" }))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestContext()).toBeUndefined();
  });
});

describe("client ip", () => {
  it("trusts X-Forwarded-For only behind our proxy", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientIp(h, false)).toBeNull();
    expect(clientIp(h, true)).toBe("10.0.0.1"); // right-most: the hop our proxy added
    expect(clientIp(new Headers({ "x-forwarded-for": "not an ip" }), true)).toBeNull();
    expect(clientIp(new Headers(), true)).toBeNull();
  });
});

describe("rate limits", () => {
  it("counts per window and returns headers; 429 past the limit", async () => {
    const counter = memoryCounter();
    const limit = { limit: 2, windowSec: 60, by: "ip", failMode: "open" } as const;
    const now = 1_000_000_000_000;
    expect((await checkRateLimit(counter, "t", limit, "ip:1", now)).allowed).toBe(true);
    const second = await checkRateLimit(counter, "t", limit, "ip:1", now);
    expect(second.headers["RateLimit-Remaining"]).toBe("0");
    const third = await checkRateLimit(counter, "t", limit, "ip:1", now);
    expect(third.allowed).toBe(false);
    expect(third.headers["Retry-After"]).toBeDefined();
    expect((await checkRateLimit(counter, "t", limit, "ip:2", now)).allowed).toBe(true);
  });

  it("fails open or closed per tier when the store is down", async () => {
    const broken = () => Promise.reject(new Error("redis down"));
    setLogSinkForTests(() => undefined);
    expect((await checkRateLimit(broken, "r", LIMITS.read, "c")).allowed).toBe(true);
    const closed = await checkRateLimit(broken, "w", LIMITS.publicForm, "c");
    expect(closed).toMatchObject({ allowed: false, degraded: true });
  });

  it("dev multiplier applies outside production only", async () => {
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "3");
    const counter = memoryCounter();
    const limit = { limit: 1, windowSec: 60, by: "ip", failMode: "closed" } as const;
    for (let i = 0; i < 3; i++) expect((await checkRateLimit(counter, "m", limit, "c", 0)).allowed).toBe(true);
    expect((await checkRateLimit(counter, "m", limit, "c", 0)).allowed).toBe(false);
  });

  it("caller keys hash the session and never contain it", () => {
    const k = callerKey("secret-session-token", "1.2.3.4");
    expect(k).toMatch(/^s:/);
    expect(k).not.toContain("secret");
    expect(callerKey(null, "1.2.3.4")).toBe("ip:1.2.3.4");
    expect(callerKey(null, null)).toBe("ip:direct");
  });

  it("redis counter sets expiry on the first hit only", async () => {
    const calls: string[] = [];
    let n = 0;
    const counter = redisCounter({
      incr: async () => ++n,
      expire: async (k, s) => {
        calls.push(`${k}:${s}`);
        return 1;
      },
    });
    await counter("k", 60);
    await counter("k", 60);
    expect(calls).toEqual(["k:61"]);
  });
});

describe("health", () => {
  it("liveness reports the build sha when valid", () => {
    vi.stubEnv("GIT_SHA", "abc123");
    expect(liveness("0.0.0")).toMatchObject({ status: "ok", version: "abc123" });
    vi.stubEnv("GIT_SHA", "bad sha!");
    expect(appVersion("1.2.3")).toBe("1.2.3");
  });

  it("probe reports ok, failure and timeout without throwing", async () => {
    setLogSinkForTests(() => undefined);
    expect((await probe("ok", 100, async () => 1)).ok).toBe(true);
    expect((await probe("fail", 100, () => Promise.reject(new Error("x")))).ok).toBe(false);
    expect((await probe("slow", 10, () => new Promise((r) => setTimeout(r, 200)))).ok).toBe(false);
  });
});

describe("failure-only limits", async () => {
  const { failuresExceeded, LIMITS, memoryFailureStore, recordFailure, redisFailureStore } =
    await import("./rate-limit");
  it("counts only failures, blocks at the limit, and resets with the window", async () => {
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
    const store = memoryFailureStore();
    const lim = LIMITS.webmailSignInAddress;
    const now = 1_000_000_000_000;
    // Successes never count: checking alone is free.
    for (let i = 0; i < 50; i++) expect(await failuresExceeded(store, "x", lim, "a", now)).toBe(false);
    for (let i = 0; i < lim.limit - 1; i++) await recordFailure(store, "x", lim, "a", now);
    expect(await failuresExceeded(store, "x", lim, "a", now)).toBe(false);
    await recordFailure(store, "x", lim, "a", now);
    expect(await failuresExceeded(store, "x", lim, "a", now)).toBe(true);
    expect(await failuresExceeded(store, "x", lim, "b", now)).toBe(false);
    expect(await failuresExceeded(store, "x", lim, "a", now + lim.windowSec * 1000)).toBe(false);
    vi.unstubAllEnvs();
  });

  it("fails closed for closed tiers when the store is down, and never throws on record", async () => {
    setLogSinkForTests(() => undefined);
    const broken = { get: () => Promise.reject(new Error("down")), incr: () => Promise.reject(new Error("down")) };
    expect(await failuresExceeded(broken, "x", LIMITS.webmailSignInAddress, "a")).toBe(true);
    expect(await failuresExceeded(broken, "x", LIMITS.read, "a")).toBe(false);
    await expect(recordFailure(broken, "x", LIMITS.webmailSignInAddress, "a")).resolves.toBeUndefined();
    setLogSinkForTests(null);
  });

  it("uses INCR + EXPIRE on Redis", async () => {
    const calls: string[] = [];
    const store = redisFailureStore({
      get: async () => null,
      incr: async (k) => (calls.push(`incr ${k}`), 1),
      expire: async (k, s) => (calls.push(`expire ${k} ${String(s)}`), 1),
    });
    expect(await store.get("k")).toBe(0);
    await store.incr("k", 900);
    expect(calls).toEqual(["incr k", "expire k 901"]);
  });
});

describe("redaction of webmail OAuth secrets", () => {
  it("redacts the OAuth flow's secrets in any spelling", () => {
    const out = redact({
      accountSecret: "pw",
      code_verifier: "v",
      codeVerifier: "v",
      client_code: "c",
      clientCode: "c",
      refresh_token: "r",
      access_token: "a",
      SECRETS_KEYRING: "k1:abc",
      secretsKeyring: "k1:abc",
      codeChallenge: "x",
      ok: "fine",
    }) as Record<string, unknown>;
    const expected = Object.fromEntries(Object.keys(out).map((k) => [k, k === "ok" ? "fine" : "[redacted]"]));
    expect(out).toEqual(expected);
  });
});

describe("redaction of the send-on-behalf key and tag", () => {
  it("redacts them in any spelling, including the tag header's name", () => {
    const out = redact({
      SENDER_DELEGATION_KEY: "d".repeat(64),
      senderDelegationKey: "d",
      onBehalfKey: "d",
      on_behalf_tag: "t",
      onBehalfTag: "t",
      "X-AnhourMail-On-Behalf": "t",
      "x-anhourmail-on-behalf": "t",
      nested: { draft: { "X-AnhourMail-On-Behalf": "t" } },
      ok: "fine",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      SENDER_DELEGATION_KEY: "[redacted]",
      senderDelegationKey: "[redacted]",
      onBehalfKey: "[redacted]",
      on_behalf_tag: "[redacted]",
      onBehalfTag: "[redacted]",
      "X-AnhourMail-On-Behalf": "[redacted]",
      "x-anhourmail-on-behalf": "[redacted]",
      nested: { draft: { "X-AnhourMail-On-Behalf": "[redacted]" } },
      ok: "fine",
    });
  });
});

describe("sliding send quotas", async () => {
  const { memorySlidingQuota, redisSlidingQuota } = await import("./rate-limit");
  it("charges every window together or none, and frees units as the window slides", async () => {
    vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
    const q = memorySlidingQuota();
    const hour = { key: "h", limit: 10, windowSec: 3600 };
    const day = { key: "d", limit: 12, windowSec: 86_400 };
    const t = 1_000_000_000_000;
    expect(await q.take([hour, day], 8, t, "a")).toBe(true);
    expect(await q.take([hour, day], 3, t, "b")).toBe(false); // the hour would overflow
    expect(await q.take([hour, day], 2, t, "c")).toBe(true);
    // The hour has slid, the day hasn't: 2 more fit the day (12), not 3.
    expect(await q.take([hour, day], 3, t + 3_601_000, "d")).toBe(false);
    expect(await q.take([hour, day], 2, t + 3_601_000, "e")).toBe(true);
    vi.unstubAllEnvs();
  });

  it("runs one atomic script over all windows in Redis", async () => {
    const calls: unknown[][] = [];
    const store = redisSlidingQuota({
      eval: async (...a: unknown[]) => {
        calls.push(a);
        return 1;
      },
    });
    expect(
      await store.take(
        [
          { key: "k1", limit: 5, windowSec: 60 },
          { key: "k2", limit: 9, windowSec: 600 },
        ],
        2,
        7,
        "x",
      ),
    ).toBe(true);
    expect(calls[0]?.slice(1)).toEqual([2, "k1", "k2", 7, 2, "x", 60, 5, 600, 9]);
  });
});
