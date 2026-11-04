// SPDX-License-Identifier: AGPL-3.0-only
import "server-only";

import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { pinHost, type Resolved, type Resolver, systemResolver } from "@anhourmail/server/net-guard";
import { REMOTE_IMAGES } from "@anhourmail/shared/webmail";

/**
 * The image proxy's outbound fetch (docs/internal/07-security.md "Image proxy (SSRF)"). A remote image address comes
 * from a stranger's email, so the fetch must never reach anything but a public web server:
 *
 * - **http/https on ports 80/443 only**, no credentials in the URL, at most 2,048 characters.
 * - **We resolve the name ourselves** and refuse it when *any* answer is a non-public address (private, loopback,
 *   link-local, CGNAT, multicast, reserved, documentation, IPv4-mapped / NAT64 / 6to4 / Teredo forms of those) —
 *   the shared guard `@anhourmail/server/net-guard` (`pinHost`, `isPublicAddress`).
 * - **The connection is pinned** to the address we checked (the socket connects to that IP), so a second DNS
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

export type { Resolved, Resolver };

/**
 * The one address to connect to for `u`: an IP literal as written, or the first DNS answer — and only when every
 * answer is public (a name that also points inside is refused outright). The URL form of the net guard's `pinHost`.
 */
export async function pinAddress(
  u: URL,
  resolve: Resolver,
  signal?: AbortSignal,
): Promise<{ ok: true; pin: Resolved } | { ok: false; reason: FetchFailure }> {
  return pinHost(bareHost(u), resolve, signal);
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
