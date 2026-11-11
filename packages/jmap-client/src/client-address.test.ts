// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { CLIENT_ADDRESS_HEADER, clientAddressHeaders, isClientAddress, withClientAddress } from "./client-address";

/** A fetch that records the headers each request went out with. */
function recording() {
  const sent: Headers[] = [];
  const f = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response("{}");
  }) as typeof fetch;
  return { f, sent };
}

describe("client address", () => {
  it("accepts one IPv4 or IPv6 address and nothing else", () => {
    for (const ok of ["203.0.113.7", "0.0.0.0", "2001:db8::1", "::1", "::ffff:198.51.100.2"]) {
      expect([ok, isClientAddress(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "",
      "203.0.113.7, 10.0.0.1",
      "203.0.113.256",
      "203.0.113.7:443",
      "example.org",
      "1::2::3",
      "fe80::1%eth0",
      "1.2.3",
      "abcd",
    ]) {
      expect([bad, isClientAddress(bad)]).toEqual([bad, false]);
    }
  });

  it("builds the header only for an address", () => {
    expect(clientAddressHeaders(" 198.51.100.4 ")).toEqual({ [CLIENT_ADDRESS_HEADER]: "198.51.100.4" });
    expect(clientAddressHeaders(null)).toEqual({});
    expect(clientAddressHeaders(undefined)).toEqual({});
    expect(clientAddressHeaders("evil\r\nX-Other: 1")).toEqual({});
  });

  it("sets the current request's address on every call, replacing one the request carried", async () => {
    const { f, sent } = recording();
    let current: string | null = "203.0.113.9";
    const wrapped = withClientAddress(f, async () => current);
    await wrapped("http://mail.internal/jmap", {
      method: "POST",
      headers: { Authorization: "Bearer t", "X-Forwarded-For": "6.6.6.6" },
    });
    current = "2001:db8::5";
    await wrapped(new Request("http://mail.internal/jmap/session", { headers: { Accept: "application/json" } }));
    expect(sent[0]?.get(CLIENT_ADDRESS_HEADER)).toBe("203.0.113.9");
    expect(sent[0]?.get("authorization")).toBe("Bearer t");
    expect(sent[1]?.get(CLIENT_ADDRESS_HEADER)).toBe("2001:db8::5");
    expect(sent[1]?.get("accept")).toBe("application/json");
  });

  it("removes a passed-on header when there is no address", async () => {
    const { f, sent } = recording();
    await withClientAddress(f, () => null)("http://mail.internal/jmap", { headers: { "X-Forwarded-For": "6.6.6.6" } });
    await withClientAddress(f, () => "not an address")("http://mail.internal/jmap");
    expect(sent.map((h) => h.get(CLIENT_ADDRESS_HEADER))).toEqual([null, null]);
  });
});
