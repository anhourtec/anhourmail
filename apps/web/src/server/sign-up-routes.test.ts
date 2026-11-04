// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The sign-up gate (ADR-0031) at the routes: `POST /api/sign-up/challenge` issues a challenge, and
 * `POST /api/auth/sign-up/email` reaches the identity layer only with a fresh, correct proof from the same client
 * address and inside the per-address and per-network sign-up limits. The identity layer is a stub here (its own
 * sign-up is covered by packages/adapters/src/auth/auth.int.test.ts).
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryMailer } from "@anhourmail/adapters/mail";
import { memoryBreachedPasswords, MemoryUnitOfWork } from "@anhourmail/adapters/memory";
import { systemClock } from "@anhourmail/core";
import { setLogSinkForTests } from "@anhourmail/server/log";
import { memoryOneTime, type OneTimeStore } from "@anhourmail/server/one-time";
import { type Counter, memoryCounter, type Uncount } from "@anhourmail/server/rate-limit";
import { PUBLIC_PLATFORM } from "@anhourmail/shared/platform";
import { leadingZeroBits, POW_BITS, POW_HEADERS, powInput } from "@anhourmail/shared/proof-of-work";

import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { POST as challengeRoute } from "@/app/api/sign-up/challenge/route";

import { setContainerForTests } from "./container";
import { env, resetEnvForTests } from "./env";

const reached = vi.fn();
/** What the stubbed identity layer answers sign-ups with (200: account created; 422: e.g. the address is in use). */
let answer: () => Promise<Response> = async () => Response.json({ ok: true });
vi.mock("@anhourmail/adapters/auth", () => ({
  authRouteHandlers: () => ({
    GET: async () => Response.json({ ok: true }),
    POST: async (req: Request) => {
      reached(new URL(req.url).pathname);
      return answer();
    },
  }),
}));
vi.mock("@/server/auth/instance", () => ({
  auth: () => ({}),
  signUpOpen: () => process.env.SIGNUP_MODE === "open",
}));

const APP = "http://localhost:43200";
const IP = "203.0.113.7";
let uow: MemoryUnitOfWork;
let oneTime: OneTimeStore | undefined;
let counter: Counter;
let uncount: Uncount | undefined;

function useContainer() {
  const breaches = memoryBreachedPasswords();
  setContainerForTests({
    deps: { uow, clock: systemClock, platform: PUBLIC_PLATFORM },
    counter,
    ...(oneTime ? { oneTime } : {}),
    ...(uncount ? { uncount } : {}),
    mailer: memoryMailer(),
    dns: { lookup: async () => [] },
    passwords: { hash: async () => "x", breaches },
    breaches,
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", APP);
  vi.stubEnv("WEBMAIL_URL", "http://localhost:43300");
  vi.stubEnv("SITE_URL", "http://localhost:43100");
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("REDIS_URL", "redis://unused");
  vi.stubEnv("MAIL_TRANSPORT_URL", "smtp://unused");
  vi.stubEnv("MAIL_FROM", "AnhourMail <no-reply@example.test>");
  vi.stubEnv("SIGNUP_MODE", "open");
  vi.stubEnv("SIGNUP_POW_BITS", "8");
  vi.stubEnv("TRUST_PROXY", "true");
  vi.stubEnv("RATE_LIMIT_MULTIPLIER", "1");
  resetEnvForTests();
  reached.mockReset();
  uow = new MemoryUnitOfWork();
  oneTime = memoryOneTime();
  const memory = memoryCounter();
  counter = memory;
  uncount = memory.uncount;
  answer = async () => Response.json({ ok: true });
  useContainer();
  setLogSinkForTests(() => undefined);
});
afterEach(() => {
  setContainerForTests(null);
  setLogSinkForTests(null);
  vi.unstubAllEnvs();
  resetEnvForTests();
});

const headers = (ip: string, extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  host: "localhost:43200",
  origin: APP,
  "x-forwarded-for": ip,
  ...extra,
});

const catchAll = { params: Promise.resolve({ all: ["sign-up", "email"] }) };
const noParams = { params: Promise.resolve({}) };

async function challenge(ip = IP): Promise<{ challenge: string; bits: number; expiresAt: string }> {
  const res = await challengeRoute(
    new Request(`${APP}/api/sign-up/challenge`, { method: "POST", headers: headers(ip), body: "{}" }),
    noParams,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { challenge: string; bits: number; expiresAt: string } }).data;
}

function solve(c: string, bits: number): string {
  for (let n = 0; ; n++) {
    if (
      leadingZeroBits(
        createHash("sha256")
          .update(powInput(c, String(n)))
          .digest(),
      ) >= bits
    )
      return String(n);
  }
}

const FORM = { email: "new@example.test", password: "a long passphrase here", name: "New" };

const signUp = (ip: string, proof: { challenge: string; proof: string } | null, body: string = JSON.stringify(FORM)) =>
  authPost(
    new Request(`${APP}/api/auth/sign-up/email`, {
      method: "POST",
      headers: headers(ip, proof ? { [POW_HEADERS.challenge]: proof.challenge, [POW_HEADERS.proof]: proof.proof } : {}),
      body,
    }),
    catchAll,
  );

async function solved(ip = IP) {
  const c = await challenge(ip);
  return { challenge: c.challenge, proof: solve(c.challenge, c.bits) };
}

const refusals = () =>
  uow.state.audit
    .filter((e) => e.action === "auth.sign_up_refused")
    .map((e) => [e.errorCode, e.meta.reason, e.ip] as const);

describe("sign-up settings", () => {
  it("accept a difficulty and limits in range, blank as unset, and refuse anything else", () => {
    vi.stubEnv("SIGNUP_LIMIT_NETWORK_DAY", "");
    resetEnvForTests();
    expect(env().SIGNUP_POW_BITS).toBe(8);
    expect(env().SIGNUP_LIMIT_NETWORK_DAY).toBeUndefined();
    for (const [k, v] of [
      ["SIGNUP_POW_BITS", "40"],
      ["SIGNUP_POW_BITS", "4"],
      ["SIGNUP_LIMIT_ADDRESS_HOUR", "0"],
      ["SIGNUP_LIMIT_NETWORK_HOUR", "many"],
    ] as const) {
      vi.stubEnv(k, v);
      resetEnvForTests();
      expect(() => env(), `${k}=${v}`).toThrow();
      vi.stubEnv(k, k === "SIGNUP_POW_BITS" ? "8" : "");
    }
  });
});

describe("POST /api/sign-up/challenge", () => {
  it("issues a challenge at the configured difficulty, with its expiry", async () => {
    const c = await challenge();
    expect(c.bits).toBe(8);
    expect(Date.parse(c.expiresAt)).toBeGreaterThan(Date.now());
    expect(c.challenge).not.toContain(IP);
  });

  it("uses the default difficulty when none is configured", async () => {
    vi.stubEnv("SIGNUP_POW_BITS", "");
    resetEnvForTests();
    expect((await challenge()).bits).toBe(POW_BITS.default);
  });

  it("is 404 while sign-up is closed", async () => {
    vi.stubEnv("SIGNUP_MODE", "closed");
    resetEnvForTests();
    const res = await challengeRoute(
      new Request(`${APP}/api/sign-up/challenge`, { method: "POST", headers: headers(IP), body: "{}" }),
      noParams,
    );
    expect(res.status).toBe(404);
  });

  it("is limited per client address (signupChallenge), fail closed", async () => {
    for (let i = 0; i < 30; i++) await challenge();
    const res = await challengeRoute(
      new Request(`${APP}/api/sign-up/challenge`, { method: "POST", headers: headers(IP), body: "{}" }),
      noParams,
    );
    expect(res.status).toBe(429);
  });
});

describe("POST /api/auth/sign-up/email behind the gate", () => {
  it("passes a correct proof to the identity layer, once", async () => {
    const proof = await solved();
    expect((await signUp(IP, proof)).status).toBe(200);
    expect(reached).toHaveBeenCalledWith("/api/auth/sign-up/email");
    const again = await signUp(IP, proof);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({
      error: {
        code: "proof_of_work",
        message: "The automatic check didn't go through. Reload the page and try again.",
      },
    });
    expect(reached).toHaveBeenCalledTimes(1);
    expect(refusals()).toEqual([["proof_of_work", "replayed", IP]]);
  });

  it("refuses no proof and a forged one without auditing them (anyone can send those)", async () => {
    expect((await signUp(IP, null)).status).toBe(400);
    const { challenge: c } = await challenge();
    const parts = c.split(".");
    const forged = [parts[0], "1", ...parts.slice(2)].join(".");
    expect((await signUp(IP, { challenge: forged, proof: "0" })).status).toBe(400);
    expect(reached).not.toHaveBeenCalled();
    expect(refusals()).toEqual([]);
  });

  it("refuses a proof solved for another client address, and audits it once per hour", async () => {
    const proof = await solved("198.51.100.20");
    expect((await signUp(IP, proof)).status).toBe(400);
    expect((await signUp(IP, await solved("198.51.100.20"))).status).toBe(400);
    expect(reached).not.toHaveBeenCalled();
    expect(refusals()).toEqual([["proof_of_work", "wrong_client", IP]]);
  });

  it("refuses too little work", async () => {
    const c = await challenge();
    let n = 0;
    while (
      leadingZeroBits(
        createHash("sha256")
          .update(powInput(c.challenge, String(n)))
          .digest(),
      ) >= c.bits
    )
      n++;
    expect((await signUp(IP, { challenge: c.challenge, proof: String(n) })).status).toBe(400);
    expect(refusals()).toEqual([["proof_of_work", "insufficient_work", IP]]);
  });

  it("limits sign-ups per client address, with Retry-After, auditing the first refusal", async () => {
    vi.stubEnv("SIGNUP_LIMIT_ADDRESS_HOUR", "2");
    resetEnvForTests();
    expect((await signUp(IP, await solved())).status).toBe(200);
    expect((await signUp(IP, await solved())).status).toBe(200);
    const refused = await signUp(IP, await solved());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("sign_up_limited");
    expect((await signUp(IP, await solved())).status).toBe(429);
    expect(reached).toHaveBeenCalledTimes(2);
    expect(refusals()).toEqual([["sign_up_limited", "address_hour", IP]]);
  });

  it("limits sign-ups per network: other addresses in the same /24 share it, another /24 doesn't", async () => {
    vi.stubEnv("SIGNUP_LIMIT_NETWORK_HOUR", "2");
    resetEnvForTests();
    expect((await signUp("203.0.113.1", await solved("203.0.113.1"))).status).toBe(200);
    expect((await signUp("203.0.113.2", await solved("203.0.113.2"))).status).toBe(200);
    expect((await signUp("203.0.113.3", await solved("203.0.113.3"))).status).toBe(429);
    expect((await signUp("198.51.100.3", await solved("198.51.100.3"))).status).toBe(200);
    expect(refusals()).toEqual([["sign_up_limited", "network_hour", "203.0.113.3"]]);
  });

  it("doesn't count requests without a valid proof against the limits", async () => {
    vi.stubEnv("SIGNUP_LIMIT_ADDRESS_HOUR", "1");
    resetEnvForTests();
    for (let i = 0; i < 5; i++) await signUp(IP, null);
    expect((await signUp(IP, await solved())).status).toBe(200);
  });

  it("doesn't count failed sign-ups against the account tiers (address in use, refused password, a throw)", async () => {
    vi.stubEnv("SIGNUP_LIMIT_ADDRESS_HOUR", "1");
    vi.stubEnv("SIGNUP_LIMIT_NETWORK_HOUR", "1");
    resetEnvForTests();
    answer = async () => Response.json({ code: "USER_ALREADY_EXISTS" }, { status: 422 });
    for (let i = 0; i < 4; i++) expect((await signUp(IP, await solved())).status).toBe(422);
    answer = () => Promise.reject(new Error("identity layer down"));
    expect((await signUp(IP, await solved())).status).toBe(500);
    // The allowance is untouched: the next real sign-up is created, and the one after it is over the limit.
    answer = async () => Response.json({ ok: true });
    expect((await signUp(IP, await solved())).status).toBe(200);
    expect((await signUp(IP, await solved())).status).toBe(429);
    expect(refusals()).toEqual([["sign_up_limited", "address_hour", IP]]);
  });

  it("bounds failed attempts with the attempts tier (per address), audited once", async () => {
    vi.stubEnv("SIGNUP_LIMIT_ATTEMPTS_HOUR", "3");
    resetEnvForTests();
    answer = async () => Response.json({ code: "PASSWORD_COMPROMISED" }, { status: 400 });
    for (let i = 0; i < 3; i++) expect((await signUp(IP, await solved())).status).toBe(400);
    const refused = await signUp(IP, await solved());
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("sign_up_attempts");
    expect((await signUp(IP, await solved())).status).toBe(429);
    expect(reached).toHaveBeenCalledTimes(3);
    expect(refusals()).toEqual([["sign_up_attempts", "attempts_hour", IP]]);
    // Another address isn't affected.
    expect((await signUp("198.51.100.9", await solved("198.51.100.9"))).status).toBe(400);
  });

  it("refuses a body that isn't a sign-up form without counting it", async () => {
    vi.stubEnv("SIGNUP_LIMIT_ATTEMPTS_HOUR", "1");
    resetEnvForTests();
    for (const body of ["", "{}", "[]", "not json", JSON.stringify({ ...FORM, email: 7 }), "x".repeat(9000)]) {
      const res = await signUp(IP, await solved(), body);
      expect({ body: body.slice(0, 20), status: res.status }).toEqual({ body: body.slice(0, 20), status: 400 });
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
    expect(reached).not.toHaveBeenCalled();
    expect((await signUp(IP, await solved())).status).toBe(200);
  });

  it("concurrent sign-ups can't overshoot the account tiers, and failed ones in flight give theirs back", async () => {
    vi.stubEnv("SIGNUP_LIMIT_ADDRESS_HOUR", "2");
    resetEnvForTests();
    const proofs = await Promise.all(Array.from({ length: 6 }, () => solved()));
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    // Two in flight fail slowly; two more arrive meanwhile and find no room until those two give theirs back.
    answer = async () => {
      await held;
      return Response.json({ code: "USER_ALREADY_EXISTS" }, { status: 422 });
    };
    const slow = [signUp(IP, proofs[0] ?? null), signUp(IP, proofs[1] ?? null)];
    await vi.waitFor(() => {
      expect(reached).toHaveBeenCalledTimes(2);
    });
    answer = async () => Response.json({ ok: true });
    const meanwhile = await Promise.all(proofs.slice(2, 4).map((p) => signUp(IP, p)));
    expect(meanwhile.map((r) => r.status)).toEqual([429, 429]);
    release();
    expect((await Promise.all(slow)).map((r) => r.status)).toEqual([422, 422]);
    const after = await Promise.all(proofs.slice(4).map((p) => signUp(IP, p)));
    expect(after.map((r) => r.status)).toEqual([200, 200]);
  });

  it("limits IPv6 per /64, /56 and /48, and reads mapped and NAT64 addresses as the IPv4 address", async () => {
    vi.stubEnv("SIGNUP_LIMIT_NETWORK_HOUR", "1");
    vi.stubEnv("SIGNUP_LIMIT_NETWORK56_DAY", "2");
    vi.stubEnv("SIGNUP_LIMIT_NETWORK48_DAY", "3");
    resetEnvForTests();
    const at = async (ip: string) => (await signUp(ip, await solved(ip))).status;
    expect(await at("2001:db8:1:100::1")).toBe(200);
    // Another address in the same /64 is the same network.
    expect(await at("2001:db8:1:100::2")).toBe(429);
    expect(await at("2001:db8:1:101::1")).toBe(200);
    // A third /64 in the same /56 (2001:db8:1:1xx) is over the /56 limit.
    expect(await at("2001:db8:1:102::1")).toBe(429);
    expect(await at("2001:db8:1:200::1")).toBe(200);
    // A fourth in the same /48 is over the /48 limit, whatever its /56.
    expect(await at("2001:db8:1:300::1")).toBe(429);
    expect(await at("2001:db8:2:300::1")).toBe(200);
    expect(refusals().map(([code, reason]) => [code, reason])).toEqual([
      ["sign_up_limited", "network_hour"],
      ["sign_up_limited", "network56_day"],
      ["sign_up_limited", "network48_day"],
    ]);
    // A challenge fetched over IPv4 is spent over an IPv4-mapped spelling of the same address (the binding holds), and
    // a NAT64 spelling counts against the same IPv4 /24 (its network allowance of 1 is used: 429, not a 400 refusal).
    expect((await signUp("::ffff:198.51.100.40", await solved("198.51.100.40"))).status).toBe(200);
    expect((await signUp("64:ff9b::c633:6428", await solved("198.51.100.40"))).status).toBe(429);
  });

  it("fails closed: 503 when the limiter or the single-use store is down", async () => {
    const first = await solved();
    const second = await solved();
    counter = async (key) => {
      if (key.startsWith("am:rl:signup")) throw new Error("redis down");
      return 1;
    };
    useContainer();
    expect((await signUp(IP, first)).status).toBe(503);
    counter = memoryCounter();
    oneTime = undefined;
    useContainer();
    expect((await signUp(IP, second)).status).toBe(503);
    expect(reached).not.toHaveBeenCalled();
  });

  it("leaves other auth endpoints alone, and closed sign-up to the identity layer", async () => {
    const signIn = await authPost(
      new Request(`${APP}/api/auth/sign-in/email`, { method: "POST", headers: headers(IP), body: "{}" }),
      { params: Promise.resolve({ all: ["sign-in", "email"] }) },
    );
    expect(signIn.status).toBe(200);
    vi.stubEnv("SIGNUP_MODE", "closed");
    resetEnvForTests();
    expect((await signUp(IP, null)).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(2);
  });
});
