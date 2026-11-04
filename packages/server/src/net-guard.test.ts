// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import {
  guardTarget,
  hostName,
  isInternalName,
  isPublicAddress,
  MAX_HOST_NAME,
  NetGuardError,
  parseDevAllowList,
  pinHost,
  type Resolver,
} from "./net-guard";

const resolver =
  (answers: Record<string, string[]>): Resolver =>
  async (host) => {
    const list = answers[host];
    if (!list) throw new Error("ENOTFOUND");
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
const never: Resolver = () => Promise.reject(new Error("must not resolve"));
const IMAP = [993, 143] as const;

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("refuses the IPv4 address %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.0.1",
    "::127.0.0.1", // IPv4-compatible (deprecated)
    "64:ff9b::a00:1", // NAT64
    "64:ff9b:1::1",
    "100::1", // discard
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "2001::1", // Teredo
    "2001:2::1", // benchmarking
    "2001:db8::1", // documentation
    "2002:7f00:1::1", // 6to4 of 127.0.0.1
    "3fff::1", // documentation
    "4000::1", // outside 2000::/3
  ])("refuses the IPv6 address %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.215.14", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows the public address %s",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );

  it("refuses anything that isn't an address", () => {
    for (const v of ["", "localhost", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4x", "::g", "1::2::3"]) {
      expect(isPublicAddress(v)).toBe(false);
    }
  });
});

describe("isInternalName", () => {
  it("knows names that only mean something inside a network", () => {
    for (const n of [
      "localhost",
      "a.localhost",
      "postgres",
      "stalwart",
      "nas.local",
      "x.internal",
      "r.home.arpa",
      "x.local.",
    ]) {
      expect(isInternalName(n)).toBe(true);
    }
    for (const n of ["imap.example.org", "localhost.example.org", "internal.example.com"]) {
      expect(isInternalName(n)).toBe(false);
    }
  });
});

describe("pinHost", () => {
  it("pins the first answer when every answer is public, and refuses mixed answers", async () => {
    expect(await pinHost("imap.example.org", resolver({ "imap.example.org": ["8.8.8.8", "1.1.1.1"] }))).toEqual({
      ok: true,
      pin: { address: "8.8.8.8", family: 4 },
    });
    expect(await pinHost("imap.example.org", resolver({ "imap.example.org": ["8.8.8.8", "fd00::1"] }))).toEqual({
      ok: false,
      reason: "blocked_address",
    });
  });

  it("judges IP literals without DNS and refuses internal names before any lookup", async () => {
    expect(await pinHost("10.0.0.1", never)).toEqual({ ok: false, reason: "blocked_address" });
    expect(await pinHost("2606:4700::1111", never)).toEqual({
      ok: true,
      pin: { address: "2606:4700::1111", family: 6 },
    });
    expect(await pinHost("localhost", never)).toEqual({ ok: false, reason: "blocked_address" });
    expect(await pinHost("nowhere.example", resolver({}))).toEqual({ ok: false, reason: "dns_failed" });
    expect(await pinHost("empty.example", resolver({ "empty.example": [] }))).toEqual({
      ok: false,
      reason: "dns_failed",
    });
  });

  it("gives up at the caller's deadline when the lookup never answers", async () => {
    const hang: Resolver = () => new Promise(() => undefined);
    expect(await pinHost("slow.example", hang, AbortSignal.timeout(20))).toEqual({ ok: false, reason: "timeout" });
    const aborted = AbortSignal.abort();
    expect(await pinHost("slow.example", hang, aborted)).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("hostName", () => {
  it("normalises what a person typed: case, trailing dot, IDN, brackets and numeric IPv4 forms", () => {
    expect(hostName("  IMAP.Example.ORG. ")).toBe("imap.example.org");
    expect(hostName("mail.bücher.example")).toBe("mail.xn--bcher-kva.example");
    expect(hostName("[2606:4700::1111]")).toBe("2606:4700::1111");
    expect(hostName("2606:4700::1111")).toBe("2606:4700::1111");
    expect(hostName("127.1")).toBe("127.0.0.1");
    expect(hostName("0x7f000001")).toBe("127.0.0.1");
    expect(hostName("2130706433")).toBe("127.0.0.1");
  });

  it("refuses userinfo, ports, paths, escapes, spaces, bad labels and over-long names", () => {
    for (const v of [
      "",
      "   ",
      "user@imap.example.org",
      "imap.example.org:993",
      "imap.example.org/x",
      "imap.example.org?x",
      "imap.example.org#x",
      "ex%41mple.org",
      "imap example.org",
      "imap\u0000.example.org",
      "-imap.example.org",
      "imap-.example.org",
      "im_ap.example.org",
      "x..example.org",
      "[imap.example.org]",
      "fe80::1%eth0",
      "1.2.3.4.5",
      `${"a".repeat(64)}.example.org`,
      `${"a.".repeat(MAX_HOST_NAME / 2)}org`,
    ]) {
      expect({ v, out: hostName(v) }).toEqual({ v, out: null });
    }
    expect(hostName(`${"a".repeat(63)}.example.org`)).toBe(`${"a".repeat(63)}.example.org`);
  });
});

describe("parseDevAllowList", () => {
  it("reads exact host:port pairs, normalised", () => {
    const list = parseDevAllowList(" 127.0.0.1:993, Stalwart.Dev.Test:143 ,[::1]:993", { NODE_ENV: "test" }, "X");
    expect([...list].sort()).toEqual(["127.0.0.1:993", "[::1]:993", "stalwart.dev.test:143"]);
    expect(parseDevAllowList(undefined, { NODE_ENV: "production" }, "X").size).toBe(0);
    expect(parseDevAllowList(" , ", { NODE_ENV: "production" }, "X").size).toBe(0);
  });

  it("is refused in production, and an entry that isn't host:port never widens anything", () => {
    expect(() => parseDevAllowList("127.0.0.1:993", { NODE_ENV: "production" }, "IMPORT_DEV_ALLOW_SOURCES")).toThrow(
      /IMPORT_DEV_ALLOW_SOURCES is for development only/,
    );
    for (const bad of ["127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000", "a@b.test:993", ":993", "*:993"]) {
      expect(() => parseDevAllowList(bad, { NODE_ENV: "development" }, "X")).toThrow(NetGuardError);
    }
  });
});

describe("guardTarget", () => {
  it("connects to the pinned public address and keeps the name for TLS", async () => {
    const r = await guardTarget(
      { host: "IMAP.example.org", port: 993 },
      { ports: IMAP, resolve: resolver({ "imap.example.org": ["8.8.4.4"] }) },
    );
    expect(r).toEqual({
      ok: true,
      target: { address: "8.8.4.4", family: 4, port: 993, servername: "imap.example.org", devAllowed: false },
    });
    // A public IP literal is allowed; there is no name to send as SNI.
    expect(await guardTarget({ host: "8.8.8.8", port: 143 }, { ports: IMAP, resolve: never })).toEqual({
      ok: true,
      target: { address: "8.8.8.8", family: 4, port: 143, servername: "", devAllowed: false },
    });
  });

  it("allows only the caller's ports and refuses bad or internal hosts", async () => {
    const pub = resolver({ "imap.example.org": ["8.8.4.4"] });
    for (const port of [25, 80, 443, 465, 587, 995, 4190, 0, 65536]) {
      expect(await guardTarget({ host: "imap.example.org", port }, { ports: IMAP, resolve: pub })).toEqual({
        ok: false,
        reason: "bad_port",
      });
    }
    expect(await guardTarget({ host: "a@b", port: 993 }, { ports: IMAP, resolve: never })).toEqual({
      ok: false,
      reason: "bad_host",
    });
    const hosts = ["localhost", "stalwart", "127.0.0.1", "127.1", "169.254.169.254", "[::1]", "10.1.2.3"];
    const got = [];
    for (const host of hosts) got.push([host, await guardTarget({ host, port: 993 }, { ports: IMAP, resolve: never })]);
    expect(got).toEqual(hosts.map((h) => [h, { ok: false, reason: "blocked_address" }]));
    expect(
      await guardTarget(
        { host: "rebind.example.org", port: 993 },
        { ports: IMAP, resolve: resolver({ "rebind.example.org": ["8.8.8.8", "192.168.0.10"] }) },
      ),
    ).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("checks again on every call: a later answer pointing inside is refused", async () => {
    let answer = "8.8.8.8";
    const changing: Resolver = async () => [{ address: answer, family: 4 }];
    const opts = { ports: IMAP, resolve: changing };
    expect((await guardTarget({ host: "imap.example.org", port: 993 }, opts)).ok).toBe(true);
    answer = "10.0.0.7";
    expect(await guardTarget({ host: "imap.example.org", port: 993 }, opts)).toEqual({
      ok: false,
      reason: "blocked_address",
    });
  });

  it("lets exactly the dev allow-list's host:port through, marked as such", async () => {
    const allow = parseDevAllowList("127.0.0.1:993,stalwart:143", { NODE_ENV: "test" }, "X");
    expect(await guardTarget({ host: "127.0.0.1", port: 993 }, { ports: IMAP, resolve: never, allow })).toEqual({
      ok: true,
      target: { address: "127.0.0.1", family: 4, port: 993, servername: "", devAllowed: true },
    });
    expect(
      await guardTarget(
        { host: "stalwart", port: 143 },
        { ports: IMAP, resolve: resolver({ stalwart: ["172.19.0.4"] }), allow },
      ),
    ).toEqual({
      ok: true,
      target: { address: "172.19.0.4", family: 4, port: 143, servername: "stalwart", devAllowed: true },
    });
    // Never in production, however the list was made.
    await expect(
      guardTarget(
        { host: "127.0.0.1", port: 993 },
        { ports: IMAP, resolve: never, allow: new Set(["127.0.0.1:993"]), env: { NODE_ENV: "production" } },
      ),
    ).rejects.toThrow(NetGuardError);
    // Another port on an allowed host, or the allowed port on another private host: refused as usual.
    expect(await guardTarget({ host: "127.0.0.1", port: 143 }, { ports: IMAP, resolve: never, allow })).toEqual({
      ok: false,
      reason: "blocked_address",
    });
    expect(await guardTarget({ host: "127.0.0.2", port: 993 }, { ports: IMAP, resolve: never, allow })).toEqual({
      ok: false,
      reason: "blocked_address",
    });
    // The port rule still applies to allowed hosts.
    expect(
      await guardTarget(
        { host: "127.0.0.1", port: 25 },
        { ports: IMAP, resolve: never, allow: parseDevAllowList("127.0.0.1:25", { NODE_ENV: "test" }, "X") },
      ),
    ).toEqual({ ok: false, reason: "bad_port" });
    expect(
      await guardTarget(
        { host: "gone.test", port: 993 },
        {
          ports: IMAP,
          resolve: resolver({}),
          allow: parseDevAllowList("gone.test:993", { NODE_ENV: "test" }, "X"),
        },
      ),
    ).toEqual({ ok: false, reason: "dns_failed" });
  });
});
