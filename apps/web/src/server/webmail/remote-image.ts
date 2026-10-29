// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { REMOTE_IMAGES } from "@anhourmail/shared/webmail";

/**
 * The image proxy's outbound fetch (docs/internal/07-security.md "Image proxy (SSRF)"). A remote image address comes
 * from a stranger's email, so the fetch must never reach anything but a public web server:
 *
 * - **http/https on ports 80/443 only**, no credentials in the URL, at most 2,048 characters.
 * - **We resolve the name ourselves** and refuse it when *any* answer is a non-public address (private, loopback,
 *   link-local, CGNAT, multicast, reserved, documentation, IPv4-mapped / NAT64 / 6to4 / Teredo forms of those).
 * - **The connection is pinned** to the address we checked (our own `lookup` answers the socket), so a second DNS
 *   answer can't swap in an internal address between the check and the connect (DNS rebinding). TLS still verifies
 *   the certificate against the host name.
 * - **Redirects are followed by hand** (at most `REMOTE_IMAGES.maxRedirects`), each one checked again from scratch.
 * - **One deadline** for the whole chain, a **size cap** while reading (and from Content-Length), no compression
 *   (`Accept-Encoding: identity`), and only **raster images by their magic bytes** (PNG, JPEG, GIF, WebP, BMP) —
 *   never SVG, HTML or anything else, whatever the server's Content-Type says.
 * - **Nothing about the reader goes out:** no cookies, no Referer, no X-Forwarded-For, a generic User-Agent.
 *
 * Callers log only the outcome (`reason`), status and size — never the URL, its host or query (rule 24: an image
 * address can carry a tracking id).
 */

export const MAX_IMAGE_BYTES = REMOTE_IMAGES.maxMb * 1024 * 1024;
export const MAX_IMAGE_URL = 2048;

/** What we tell remote servers we are: an ordinary browser, nothing that identifies the reader. */
export const PROXY_USER_AGENT = "Mozilla/5.0";

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";

export type FetchFailure =
  | "bad_url"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "http_status"
  | "too_large"
  | "not_image"
  | "timeout"
  | "network";

export type FetchResult = { ok: true; type: ImageType; bytes: Buffer } | { ok: false; reason: FetchFailure };

// ---- addresses ----------------------------------------------------------------------------------------------

/** IPv4 dotted quad → 32-bit number; null when it isn't one. */
function v4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = n * 256 + b;
  }
  return n;
}

/** Non-public IPv4 ranges (RFC 6890 special-purpose registry and friends). */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];
const V4_RANGES = V4_BLOCKED.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: ((v4(base) ?? 0) & mask) >>> 0, mask };
});

function publicV4(n: number): boolean {
  return !V4_RANGES.some((r) => (n & r.mask) >>> 0 === r.net);
}

/** IPv6 text → eight 16-bit groups (handles `::` and a trailing dotted quad); null when it isn't IPv6. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  // A trailing IPv4 part (`::ffff:1.2.3.4`) becomes two groups.
  const quad = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (quad?.[1]) {
    const n = v4(quad[1]);
    if (n === null) return null;
    s = `${s.slice(0, -quad[1].length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = "", tail] = s.split("::");
  const a = head === "" ? [] : head.split(":");
  const b = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0) return null;
  const groups = [...a, ...Array<string>(fill).fill("0"), ...b].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Non-public ranges inside 2000::/3 (the only IPv6 space we allow at all): [prefix groups, prefix length]. */
const V6_BLOCKED: [number[], number][] = [
  [[0x2001, 0x0000], 23], // IETF protocol assignments: Teredo 2001::/32, benchmarking, ORCHID…
  [[0x2001, 0x0db8], 32], // documentation
  [[0x2002], 16], // 6to4 (embeds an IPv4 address)
  [[0x3fff, 0x0000], 20], // documentation (RFC 9637)
];

function inPrefix(groups: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((prefix[i] ?? 0) & mask)) return false;
    bits -= take;
  }
  return true;
}

/**
 * True only for a globally routable unicast address. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is judged as the IPv4
 * address it carries; every other IPv6 form outside 2000::/3 (loopback, unspecified, IPv4-compatible, NAT64
 * 64:ff9b::/96, unique-local fc00::/7, link-local fe80::/10, multicast ff00::/8, …) is refused.
 */
export function isPublicAddress(ip: string): boolean {
  const n4 = v4(ip);
  if (n4 !== null) return publicV4(n4);
  const g = v6Groups(ip);
  if (!g) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return publicV4(((g6 << 16) | g7) >>> 0);
  }
  if ((g0 & 0xe000) !== 0x2000) return false;
  return !V6_BLOCKED.some(([prefix, bits]) => inPrefix(g, prefix, bits));
}

// ---- URLs ---------------------------------------------------------------------------------------------------

/** The URL if it may be fetched at all (scheme, port, no credentials, length); null otherwise. */
export function imageUrl(raw: string, base?: URL): URL | null {
  if (raw.length > MAX_IMAGE_URL) return null;
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  // `port` is "" for the scheme's default; an explicit :80 on https (or :443 on http) is refused too.
  if (u.port !== "") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.hostname === "" || u.href.length > MAX_IMAGE_URL) return null;
  u.hash = "";
  return u;
}

/** The URL's host without IPv6 brackets. */
const bareHost = (u: URL) => u.hostname.replace(/^\[|\]$/g, "");

export type Resolved = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<Resolved[]>;

const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, order: "verbatim" })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

/**
 * The one address to connect to for `u`: an IP literal as written, or the first DNS answer — and only when every
 * answer is public (a name that also points inside is refused outright).
 */
export async function pinAddress(
  u: URL,
  resolve: Resolver,
  signal?: AbortSignal,
): Promise<{ ok: true; pin: Resolved } | { ok: false; reason: FetchFailure }> {
  const host = bareHost(u);
  const literal = isIP(host);
  if (literal !== 0) {
    return isPublicAddress(host)
      ? { ok: true, pin: { address: host, family: literal === 6 ? 6 : 4 } }
      : { ok: false, reason: "blocked_address" };
  }
  // Names that only mean something inside a network: refused before any lookup.
  if (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|home\.arpa)\.?$/i.test(host)) {
    return { ok: false, reason: "blocked_address" };
  }
  let answers: Resolved[];
  try {
    answers = await withDeadline(resolve(host), signal);
  } catch (err) {
    return { ok: false, reason: err === DEADLINE ? "timeout" : "dns_failed" };
  }
  const first = answers[0];
  if (!first) return { ok: false, reason: "dns_failed" };
  if (!answers.every((a) => isPublicAddress(a.address))) return { ok: false, reason: "blocked_address" };
  return { ok: true, pin: first };
}

// ---- content ------------------------------------------------------------------------------------------------

/** The raster type the bytes really are, by magic number; null for anything else (SVG, HTML, text, …). */
export function sniffImage(b: Uint8Array): ImageType | null {
  const at = (i: number) => b[i] ?? -1;
  const ascii = (i: number, s: string) => {
    for (let j = 0; j < s.length; j++) if (at(i + j) !== s.charCodeAt(j)) return false;
    return true;
  };
  if (at(0) === 0x89 && ascii(1, "PNG\r\n\x1a\n")) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "BM") && b.length >= 26) return "image/bmp";
  return null;
}

// ---- fetching -----------------------------------------------------------------------------------------------

export type FetchDeps = {
  resolve?: Resolver;
  /**
   * Tests only: where the pinned address really connects (a local server). Production connects to the pin itself.
   */
  connectTo?: (pin: Resolved, port: number) => { host: string; port: number };
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
};

type Hop = { status: number; location: string | null; bytes?: Buffer; failure?: FetchFailure };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** One request to a pinned address; reads the body only for a 200. */
function requestOnce(
  u: URL,
  pin: Resolved,
  deps: { maxBytes: number; connectTo: FetchDeps["connectTo"] | undefined },
  signal: AbortSignal,
): Promise<Hop> {
  const secure = u.protocol === "https:";
  const defaultPort = secure ? 443 : 80;
  const target = deps.connectTo ? deps.connectTo(pin, defaultPort) : { host: pin.address, port: defaultPort };
  const host = bareHost(u);
  // The socket connects to the checked address itself (an IP, so no second DNS lookup can happen); the Host header
  // and TLS (SNI and certificate check) still use the name.
  const options: https.RequestOptions = {
    method: "GET",
    host: target.host,
    port: target.port,
    path: `${u.pathname}${u.search}`,
    agent: false,
    signal,
    headers: {
      Host: u.host,
      "User-Agent": PROXY_USER_AGENT,
      Accept: "image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
      "Accept-Encoding": "identity",
    },
    ...(secure ? { servername: isIP(host) === 0 ? host : "" } : {}),
  };
  return new Promise<Hop>((resolve, reject) => {
    const req = (secure ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      if (status !== 200) {
        res.resume();
        resolve({ status, location });
        return;
      }
      const encoding = (res.headers["content-encoding"] ?? "identity").toLowerCase();
      const declared = Number(res.headers["content-length"] ?? "0");
      if (encoding !== "identity") {
        res.destroy();
        resolve({ status, location, failure: "not_image" });
        return;
      }
      if (declared > deps.maxBytes) {
        res.destroy();
        resolve({ status, location, failure: "too_large" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > deps.maxBytes) {
          res.destroy();
          resolve({ status, location, failure: "too_large" });
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ status, location, bytes: Buffer.concat(chunks, size) });
      });
      res.on("error", reject);
      // Cut off mid-body (deadline, reset): never a partial image.
      res.on("close", () => {
        if (!res.complete) reject(new Error("closed early"));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** The rejection a lookup gets when the fetch's deadline passes first. */
const DEADLINE = new Error("deadline");

/** A lookup that never answers must not outlive the fetch's deadline (it would hold a fetch slot meanwhile). */
function withDeadline<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(DEADLINE);
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      reject(DEADLINE);
    };
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(e instanceof Error ? e : new Error("lookup failed"));
      },
    );
  });
}

/** Fetches a remote image under every guard above. Never throws; the failure says why (for logs and tests). */
export async function fetchRemoteImage(raw: string, deps: FetchDeps = {}): Promise<FetchResult> {
  const resolve = deps.resolve ?? systemResolver;
  const maxBytes = deps.maxBytes ?? MAX_IMAGE_BYTES;
  const maxRedirects = deps.maxRedirects ?? REMOTE_IMAGES.maxRedirects;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? REMOTE_IMAGES.timeoutSeconds * 1000);
  const first = imageUrl(raw);
  if (!first) return { ok: false, reason: "bad_url" };
  let url: URL = first;
  try {
    for (let hop = 0; ; hop++) {
      const pinned = await pinAddress(url, resolve, signal);
      if (!pinned.ok) return pinned;
      if (signal.aborted) return { ok: false, reason: "timeout" };
      const res = await requestOnce(url, pinned.pin, { maxBytes, connectTo: deps.connectTo }, signal);
      if (REDIRECTS.has(res.status)) {
        if (hop >= maxRedirects) return { ok: false, reason: "too_many_redirects" };
        const next: URL | null = res.location === null ? null : imageUrl(res.location, url);
        if (!next) return { ok: false, reason: "bad_url" };
        url = next;
        continue;
      }
      if (res.failure) return { ok: false, reason: res.failure };
      if (res.status !== 200 || !res.bytes) return { ok: false, reason: "http_status" };
      const type = sniffImage(res.bytes);
      if (!type) return { ok: false, reason: "not_image" };
      return { ok: true, type, bytes: res.bytes };
    }
  } catch {
    return { ok: false, reason: signal.aborted ? "timeout" : "network" };
  }
}
