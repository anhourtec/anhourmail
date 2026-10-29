// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  fetchRemoteImage,
  type FetchDeps,
  imageUrl,
  isPublicAddress,
  MAX_IMAGE_URL,
  pinAddress,
  PROXY_USER_AGENT,
  type Resolved,
  type Resolver,
  sniffImage,
} from "./remote-image";

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

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

describe("imageUrl", () => {
  it("accepts http and https on their default ports and drops the fragment", () => {
    expect(imageUrl("https://cdn.example.org/a.png?x=1#frag")?.href).toBe("https://cdn.example.org/a.png?x=1");
    expect(imageUrl("http://cdn.example.org/a.png")?.href).toBe("http://cdn.example.org/a.png");
    // An explicit default port is the default.
    expect(imageUrl("https://cdn.example.org:443/a.png")?.href).toBe("https://cdn.example.org/a.png");
  });

  it("refuses other schemes, other ports, credentials and over-long addresses", () => {
    for (const u of [
      "ftp://cdn.example.org/a.png",
      "file:///etc/passwd",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "gopher://cdn.example.org/",
      "https://cdn.example.org:8443/a.png",
      "http://cdn.example.org:443/a.png",
      "http://cdn.example.org:6379/",
      "https://user:pass@cdn.example.org/a.png",
      "https://user@cdn.example.org/a.png",
      "not a url",
      `https://cdn.example.org/${"a".repeat(MAX_IMAGE_URL)}`,
    ]) {
      expect(imageUrl(u)).toBeNull();
    }
  });

  it("resolves a relative redirect against the current address", () => {
    expect(imageUrl("/b.png", new URL("https://cdn.example.org/a/x.png"))?.href).toBe("https://cdn.example.org/b.png");
  });
});

describe("pinAddress", () => {
  const resolver =
    (answers: Record<string, string[]>): Resolver =>
    async (host) => {
      const list = answers[host];
      if (!list) throw new Error("ENOTFOUND");
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    };

  it("pins the first answer when every answer is public", async () => {
    const r = await pinAddress(
      new URL("https://img.example.org/"),
      resolver({ "img.example.org": ["8.8.8.8", "1.1.1.1"] }),
    );
    expect(r).toEqual({ ok: true, pin: { address: "8.8.8.8", family: 4 } });
  });

  it("refuses a name when any answer is internal (one public, one private)", async () => {
    const r = await pinAddress(
      new URL("https://img.example.org/"),
      resolver({ "img.example.org": ["8.8.8.8", "10.0.0.5"] }),
    );
    expect(r).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("refuses IP literals in private ranges (v4, v6, mapped, bracketed) without asking DNS", async () => {
    const never: Resolver = () => Promise.reject(new Error("must not resolve"));
    for (const u of [
      "http://127.0.0.1/",
      "http://2130706433/", // 127.0.0.1 as one number
      "http://0x7f.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]/",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(await pinAddress(new URL(u), never)).toEqual({ ok: false, reason: "blocked_address" });
    }
    expect(await pinAddress(new URL("http://[2606:4700::1111]/"), never)).toEqual({
      ok: true,
      pin: { address: "2606:4700::1111", family: 6 },
    });
  });

  it("refuses internal-only names before any lookup, and names that don't resolve", async () => {
    const never: Resolver = () => Promise.reject(new Error("must not resolve"));
    for (const u of [
      "http://localhost/",
      "http://a.localhost/",
      "http://postgres/",
      "http://nas.local/",
      "http://x.internal/",
    ]) {
      expect(await pinAddress(new URL(u), never)).toEqual({ ok: false, reason: "blocked_address" });
    }
    expect(await pinAddress(new URL("http://nowhere.example/"), resolver({}))).toEqual({
      ok: false,
      reason: "dns_failed",
    });
    expect(await pinAddress(new URL("http://empty.example/"), resolver({ "empty.example": [] }))).toEqual({
      ok: false,
      reason: "dns_failed",
    });
  });
});

describe("sniffImage", () => {
  it("knows raster images by their bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("GIF87a\x01\x00", "latin1"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImage(Buffer.concat([Buffer.from("BM"), Buffer.alloc(30)]))).toBe("image/bmp");
  });

  it("refuses SVG, HTML, text and anything else", () => {
    for (const s of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><svg/>',
      "<!doctype html><html>",
      "hello",
      "RIFF\x10\x00\x00\x00WAVE",
      "BM",
      "",
    ]) {
      expect(sniffImage(Buffer.from(s, "latin1"))).toBeNull();
    }
  });
});

// ---- the fetch, against a local server ------------------------------------------------------------------------

type Route = (
  headers: IncomingHttpHeaders,
  send: (status: number, headers: Record<string, string>, body?: Buffer | string) => void,
  raw: ServerResponse,
) => void;

let server: Server;
let port = 0;
const routes = new Map<string, Route>();
const seen: { host: string | undefined; path: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ host: req.headers.host, path: req.url ?? "", headers: req.headers });
    const route = routes.get(`${req.headers.host ?? ""}${req.url ?? ""}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(
      req.headers,
      (status, headers, body) => {
        res.writeHead(status, headers).end(body);
      },
      res,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

/** Public names → public addresses (documentation-free, never contacted: `connectTo` sends every pin to the test server). */
const PUBLIC: Record<string, string[]> = {
  "img.example.org": ["93.184.215.14"],
  "other.example.org": ["1.1.1.1"],
  "inside.example.org": ["10.1.2.3"],
  "metadata.example.org": ["169.254.169.254"],
  "mapped.example.org": ["::ffff:127.0.0.1"],
};

function deps(
  extra: Partial<FetchDeps> = {},
  answers = PUBLIC,
): FetchDeps & { dialled: Resolved[]; lookups: string[] } {
  const dialled: Resolved[] = [];
  const lookups: string[] = [];
  return {
    resolve: async (host) => {
      lookups.push(host);
      const list = answers[host];
      if (!list) throw new Error("ENOTFOUND");
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    connectTo: (pin) => {
      dialled.push(pin);
      return { host: "127.0.0.1", port };
    },
    timeoutMs: 2_000,
    ...extra,
    dialled,
    lookups,
  };
}

describe("fetchRemoteImage", () => {
  it("fetches an image from the pinned address with nothing about the reader", async () => {
    routes.set("img.example.org/a.png?u=1", (_h, send) => {
      send(200, { "Content-Type": "image/png", "Set-Cookie": "track=1" }, PNG);
    });
    const d = deps();
    const r = await fetchRemoteImage("http://img.example.org/a.png?u=1#x", d);
    expect(r).toEqual({ ok: true, type: "image/png", bytes: PNG });
    expect(d.dialled).toEqual([{ address: "93.184.215.14", family: 4 }]);
    const req = seen.at(-1);
    expect(req?.host).toBe("img.example.org");
    expect(req?.path).toBe("/a.png?u=1");
    expect(req?.headers["user-agent"]).toBe(PROXY_USER_AGENT);
    expect(req?.headers["accept-encoding"]).toBe("identity");
    for (const h of ["cookie", "referer", "x-forwarded-for", "x-real-ip", "forwarded", "authorization", "origin"]) {
      expect(req?.headers[h]).toBeUndefined();
    }
  });

  it("serves the type the bytes are, whatever the server claims", async () => {
    routes.set("img.example.org/claims-html", (_h, send) => {
      send(200, { "Content-Type": "text/html" }, JPEG);
    });
    expect(await fetchRemoteImage("http://img.example.org/claims-html", deps())).toMatchObject({
      ok: true,
      type: "image/jpeg",
    });
  });

  it("refuses SVG and HTML even when they claim to be images", async () => {
    routes.set("img.example.org/a.svg", (_h, send) => {
      send(200, { "Content-Type": "image/svg+xml" }, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    });
    routes.set("img.example.org/page", (_h, send) => {
      send(200, { "Content-Type": "image/png" }, "<html><script>alert(1)</script></html>");
    });
    expect(await fetchRemoteImage("http://img.example.org/a.svg", deps())).toEqual({ ok: false, reason: "not_image" });
    expect(await fetchRemoteImage("http://img.example.org/page", deps())).toEqual({ ok: false, reason: "not_image" });
  });

  it("refuses compressed bodies (no decompression bombs)", async () => {
    routes.set("img.example.org/gz", (_h, send) => {
      send(200, { "Content-Type": "image/png", "Content-Encoding": "gzip" }, PNG);
    });
    expect(await fetchRemoteImage("http://img.example.org/gz", deps())).toEqual({ ok: false, reason: "not_image" });
  });

  it("caps the size from Content-Length and while reading a body without one", async () => {
    routes.set("img.example.org/big", (_h, send) => {
      send(200, { "Content-Type": "image/png" }, Buffer.concat([PNG, Buffer.alloc(2_000)]));
    });
    routes.set("img.example.org/stream", (_h, _send, res) => {
      res.writeHead(200, { "Content-Type": "image/png", "Transfer-Encoding": "chunked" });
      res.write(PNG);
      const t = setInterval(() => {
        if (!res.write(Buffer.alloc(512))) return;
      }, 1);
      res.on("close", () => {
        clearInterval(t);
      });
    });
    expect(await fetchRemoteImage("http://img.example.org/big", deps({ maxBytes: 1_000 }))).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(await fetchRemoteImage("http://img.example.org/stream", deps({ maxBytes: 4_000 }))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("follows a few redirects, checking every hop again", async () => {
    routes.set("img.example.org/r1", (_h, send) => {
      send(302, { Location: "http://other.example.org/r2" });
    });
    routes.set("other.example.org/r2", (_h, send) => {
      send(301, { Location: "/final.png" });
    });
    routes.set("other.example.org/final.png", (_h, send) => {
      send(200, { "Content-Type": "image/png" }, PNG);
    });
    const d = deps();
    expect(await fetchRemoteImage("http://img.example.org/r1", d)).toMatchObject({ ok: true, type: "image/png" });
    expect(d.lookups).toEqual(["img.example.org", "other.example.org", "other.example.org"]);
    expect(d.dialled.map((p) => p.address)).toEqual(["93.184.215.14", "1.1.1.1", "1.1.1.1"]);
  });

  it("refuses a redirect to an internal address, a metadata service, a mapped loopback or another scheme", async () => {
    for (const target of [
      "http://inside.example.org/x.png",
      "http://metadata.example.org/latest/meta-data/",
      "http://mapped.example.org/x.png",
      "http://127.0.0.1/x.png",
      "http://[::1]/x.png",
      "http://localhost/x.png",
    ]) {
      routes.set("img.example.org/to-inside", (_h, send) => {
        send(302, { Location: target });
      });
      const d = deps();
      expect(await fetchRemoteImage("http://img.example.org/to-inside", d)).toEqual({
        ok: false,
        reason: "blocked_address",
      });
      // Nothing was ever sent to the internal address.
      expect(d.dialled.map((p) => p.address)).toEqual(["93.184.215.14"]);
    }
    for (const target of ["file:///etc/passwd", "ftp://img.example.org/x", "http://img.example.org:8080/x", ""]) {
      routes.set("img.example.org/to-other", (_h, send) => {
        send(302, target === "" ? {} : { Location: target });
      });
      expect(await fetchRemoteImage("http://img.example.org/to-other", deps())).toEqual({
        ok: false,
        reason: "bad_url",
      });
    }
  });

  it("stops after the redirect limit", async () => {
    routes.set("img.example.org/loop", (_h, send) => {
      send(307, { Location: "/loop" });
    });
    const d = deps();
    expect(await fetchRemoteImage("http://img.example.org/loop", d)).toEqual({
      ok: false,
      reason: "too_many_redirects",
    });
    expect(d.dialled).toHaveLength(4); // the first request and three redirects
  });

  it("is not fooled by DNS rebinding: each hop connects to the address it checked", async () => {
    // The first answer is public, every later one internal: the connection uses the checked one, and a later hop
    // that resolves inside is refused.
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      return [{ address: calls === 1 ? "93.184.215.14" : "127.0.0.1", family: 4 }];
    };
    routes.set("img.example.org/rebind.png", (_h, send) => {
      send(200, { "Content-Type": "image/png" }, PNG);
    });
    const d = deps({ resolve: rebinding });
    expect(await fetchRemoteImage("http://img.example.org/rebind.png", d)).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    expect(d.dialled).toEqual([{ address: "93.184.215.14", family: 4 }]);

    calls = 0;
    routes.set("img.example.org/rebind-hop", (_h, send) => {
      send(302, { Location: "http://img.example.org/rebind.png" });
    });
    const d2 = deps({ resolve: rebinding });
    expect(await fetchRemoteImage("http://img.example.org/rebind-hop", d2)).toEqual({
      ok: false,
      reason: "blocked_address",
    });
    expect(d2.dialled).toHaveLength(1);
  });

  it("refuses an internal name or address up front, without connecting", async () => {
    for (const u of ["http://inside.example.org/a.png", "http://10.0.0.1/a.png", "http://[fe80::1]/a.png"]) {
      const d = deps();
      expect(await fetchRemoteImage(u, d)).toEqual({ ok: false, reason: "blocked_address" });
      expect(d.dialled).toEqual([]);
    }
    expect(await fetchRemoteImage("https://img.example.org:8443/a.png", deps())).toEqual({
      ok: false,
      reason: "bad_url",
    });
    expect(await fetchRemoteImage("http://unknown.example.org/a.png", deps())).toEqual({
      ok: false,
      reason: "dns_failed",
    });
  });

  it("gives up at the deadline and on error statuses", async () => {
    routes.set("img.example.org/slow", (_h, _send, res) => {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.write(PNG.subarray(0, 8)); // and never finishes
    });
    routes.set("img.example.org/missing", (_h, send) => {
      send(404, {}, "no");
    });
    expect(await fetchRemoteImage("http://img.example.org/slow", deps({ timeoutMs: 200 }))).toEqual({
      ok: false,
      reason: "timeout",
    });
    // A name whose lookup never answers ends at the same deadline.
    const stuck = deps({ timeoutMs: 200, resolve: () => new Promise<never>(() => undefined) });
    expect(await fetchRemoteImage("http://img.example.org/a.png", stuck)).toEqual({ ok: false, reason: "timeout" });
    expect(await fetchRemoteImage("http://img.example.org/missing", deps())).toEqual({
      ok: false,
      reason: "http_status",
    });
  });

  it("reports a connection failure", async () => {
    const d = deps({ connectTo: () => ({ host: "127.0.0.1", port: 1 }) });
    expect(await fetchRemoteImage("http://img.example.org/a.png", d)).toEqual({ ok: false, reason: "network" });
  });
});
