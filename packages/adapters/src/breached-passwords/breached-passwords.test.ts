// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { BreachedPasswords } from "@anhourmail/core/security";

import { memoryBreachedPasswords } from "../memory/breached-passwords";
import { breachedPasswordsOff, countInRange, PWNED_PASSWORDS_RANGE_URL, pwnedPasswords, rangeParts } from ".";

const PASSWORD = "an example passphrase that is long";
const HEX = createHash("sha1").update(PASSWORD).digest("hex").toUpperCase();
const PREFIX = HEX.slice(0, 5);
const SUFFIX = HEX.slice(5);

/** A padded range answer: other suffixes, padding lines with count 0, and optionally ours. */
const rangeBody = (ours: number | null, crlf = true) => {
  const lines = [
    "0018A45C4D1DEF81644B54AB7F969B88D65:1",
    "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2",
    "011053FD0102E94D6AE2F8B83D76FAF94F6:0",
    ...(ours === null ? [] : [`${SUFFIX.toLowerCase()}:${String(ours)}`]),
    "FFFFF6E8FA6EECAD2A3AA415EEC418D38EC:0",
  ];
  return lines.join(crlf ? "\r\n" : "\n");
};

type Call = { url: string; init: RequestInit | undefined };

function harness(answer: (call: Call) => Promise<Response>) {
  const calls: Call[] = [];
  const warnings: { msg: string; ctx: Record<string, unknown> | undefined }[] = [];
  const check = pwnedPasswords({
    fetch: (input, init) => {
      const call = { url: input instanceof Request ? input.url : String(input), init };
      calls.push(call);
      return answer(call);
    },
    log: { warn: (msg, ctx) => warnings.push({ msg, ctx }) },
    timeoutMs: 50,
  });
  return { check, calls, warnings };
}

describe("range API adapter (k-anonymity)", () => {
  it("sends only the five-character prefix, with padding and our User-Agent; never the password or full hash", async () => {
    const { check, calls } = harness(() => Promise.resolve(new Response(rangeBody(null))));
    await check.check(PASSWORD);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${PWNED_PASSWORDS_RANGE_URL}${PREFIX}`);
    expect(call?.url).not.toContain(SUFFIX);
    expect(call?.url).not.toContain(encodeURIComponent(PASSWORD));
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("Add-Padding")).toBe("true");
    expect(headers.get("User-Agent")).toBe("AnhourMail");
    expect(call?.init?.method).toBe("GET");
    expect(call?.init?.body).toBeUndefined();
    expect(call?.init?.redirect).toBe("error");
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(call?.init)).not.toContain(PASSWORD);
    expect(JSON.stringify(call?.init)).not.toContain(SUFFIX);
  });

  it("breached when the suffix is listed with a count, clean when absent or padding (count 0)", async () => {
    expect(await harness(() => Promise.resolve(new Response(rangeBody(37)))).check.check(PASSWORD)).toBe("breached");
    expect(await harness(() => Promise.resolve(new Response(rangeBody(null, false)))).check.check(PASSWORD)).toBe(
      "clean",
    );
    expect(await harness(() => Promise.resolve(new Response(rangeBody(0)))).check.check(PASSWORD)).toBe("clean");
  });

  it("fails open with a warning that carries no secret: network error, timeout, bad status, malformed body", async () => {
    const cases: [string, (c: Call) => Promise<Response>][] = [
      ["network", () => Promise.reject(new TypeError("fetch failed"))],
      [
        "timeout",
        (c) =>
          new Promise<Response>((_, reject) => {
            c.init?.signal?.addEventListener("abort", () => {
              reject(c.init?.signal?.reason as Error);
            });
          }),
      ],
      ["status", () => Promise.resolve(new Response("busy", { status: 503 }))],
      ["malformed", () => Promise.resolve(new Response("<html>not a range answer</html>"))],
      ["malformed", () => Promise.resolve(new Response(""))],
      [
        "too_large",
        () => Promise.resolve(new Response("x", { headers: { "content-length": String(10 * 1024 * 1024) } })),
      ],
    ];
    for (const [reason, answer] of cases) {
      const { check, warnings } = harness(answer);
      expect(await check.check(PASSWORD)).toBe("unknown");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.ctx?.reason).toBe(reason);
      const logged = JSON.stringify(warnings);
      for (const secret of [PASSWORD, HEX, PREFIX, SUFFIX]) expect(logged).not.toContain(secret);
    }
  });

  it("parses range bodies strictly", () => {
    expect(countInRange(rangeBody(5), SUFFIX)).toBe(5);
    expect(countInRange(rangeBody(null), SUFFIX)).toBe(0);
    expect(countInRange("", SUFFIX)).toBeNull();
    expect(countInRange("NOT:A:LINE", SUFFIX)).toBeNull();
    expect(rangeParts(PASSWORD)).toEqual({ prefix: PREFIX, suffix: SUFFIX });
  });
});

describe("other implementations of the port", () => {
  it("off never refuses and never calls anything", async () => {
    expect(await breachedPasswordsOff.check("password1234")).toBe("unknown");
  });

  it("the memory fake answers from its list, counts calls and can be unavailable", async () => {
    const fake = memoryBreachedPasswords(["listed-password-1"]);
    expect(await fake.check("listed-password-1")).toBe("breached");
    expect(await fake.check("not-listed-password")).toBe("clean");
    fake.unavailable = true;
    expect(await fake.check("listed-password-1")).toBe("unknown");
    expect(fake.calls).toBe(3);
    const defaults: BreachedPasswords = memoryBreachedPasswords();
    expect(await defaults.check("password1234")).toBe("breached");
  });
});
