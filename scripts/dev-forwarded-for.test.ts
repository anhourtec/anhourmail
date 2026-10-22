// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { forwardedFor, plainAddress } from "./dev-forwarded-for.mjs";

describe("dev forwarder X-Forwarded-For", () => {
  it("uses a LAN visitor's socket address and ignores what they claim", () => {
    expect(forwardedFor("192.168.1.20", undefined)).toBe("192.168.1.20");
    expect(forwardedFor("::ffff:192.168.1.20", "203.0.113.9")).toBe("192.168.1.20");
    expect(forwardedFor("fe80::1", ["1.2.3.4"])).toBe("fe80::1");
  });

  it("keeps a loopback visitor's own valid address (test tooling), else loopback", () => {
    expect(forwardedFor("127.0.0.1", "198.51.100.7")).toBe("198.51.100.7");
    expect(forwardedFor("::1", "10.0.0.1, 203.0.113.4")).toBe("203.0.113.4");
    expect(forwardedFor("::ffff:127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(forwardedFor("127.0.0.1", "not an ip<script>")).toBe("127.0.0.1");
    expect(forwardedFor(undefined, undefined)).toBe("127.0.0.1");
  });

  it("strips the IPv4-mapped prefix only from IPv4 addresses", () => {
    expect(plainAddress("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(plainAddress("::ffff:abcd")).toBe("::ffff:abcd");
    expect(plainAddress(undefined)).toBe("");
  });
});
