// SPDX-License-Identifier: MIT
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/**
 * Outbound connections to hosts someone else chose (docs/internal/07-security.md "Image proxy (SSRF)" and "Mail import
 * sources"): the image proxy fetches addresses from strangers' email, the importer connects to the IMAP server a
 * person typed. Neither may ever reach anything but a public server:
 *
 * - **We resolve the name ourselves** and refuse it when *any* answer is a non-public address (private, loopback,
 *   link-local, CGNAT, multicast, reserved, documentation, IPv4-mapped / NAT64 / 6to4 / Teredo forms of those), and
 *   names that only mean something inside a network (`localhost`, `.local`, `.internal`, `home.arpa`, no dot).
 * - **The caller connects to the pinned address** we checked (an IP, so no second lookup can happen), with the name
 *   kept for TLS (SNI and the certificate check), so a DNS answer can't change between the check and the connect
 *   (DNS rebinding). Callers check again on every connect.
 * - Host names a person types are normalised first (`hostName`): at most 253 characters, IDN to punycode, no userinfo,
 *   port, path or percent-escapes; numeric IPv4 forms (`127.1`, `0x7f000001`) become the address they mean.
 * - Only the caller's ports (`guardTarget`): IMAP 993/143 for imports, so a guarded connection can't scan ports.
 * - **Development and tests only:** an allow-list of exact `host:port` pairs (`parseDevAllowList`) lets those through
 *   whatever they resolve to; it is refused outright when `NODE_ENV=production`.
 *
 * Nothing here logs: callers log only the outcome, never the host (it can be personal).
 */

export type Resolved = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<Resolved[]>;

/** The operating system's resolver, every answer in its own order. */
export const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, order: "verbatim" })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

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

/** Names that only mean something inside a network: refused before any lookup. */
export function isInternalName(host: string): boolean {
  return !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|home\.arpa)\.?$/i.test(host);
}

// ---- pinning ------------------------------------------------------------------------------------------------

export type PinFailure = "blocked_address" | "dns_failed" | "timeout";

/** The rejection a lookup gets when the caller's deadline passes first. */
const DEADLINE = new Error("deadline");

/** A lookup that never answers must not outlive the caller's deadline (it would hold a slot meanwhile). */
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

/**
 * The one address to connect to for `host` (a name or an IP literal without brackets): a literal as written, or the
 * first DNS answer — and only when every answer is public (a name that also points inside is refused outright).
 */
export async function pinHost(
  host: string,
  resolve: Resolver,
  signal?: AbortSignal,
): Promise<{ ok: true; pin: Resolved } | { ok: false; reason: PinFailure }> {
  const literal = isIP(host);
  if (literal !== 0) {
    return isPublicAddress(host)
      ? { ok: true, pin: { address: host, family: literal === 6 ? 6 : 4 } }
      : { ok: false, reason: "blocked_address" };
  }
  if (isInternalName(host)) return { ok: false, reason: "blocked_address" };
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

// ---- host names a person typed ------------------------------------------------------------------------------

export const MAX_HOST_NAME = 253;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A host name or IP literal as typed (e.g. an IMAP server), normalised: trimmed, lower-case, without a trailing dot,
 * IDN as punycode, IPv6 without brackets, numeric IPv4 forms as the dotted quad. Null for anything else: empty, over
 * 253 characters, with userinfo, a port, a path, percent-escapes, spaces or characters a host name can't have.
 * Whether the address is public is `pinHost`'s question, asked on every connect.
 */
export function hostName(raw: string): string | null {
  const s = raw.trim();
  if (s === "" || s.length > MAX_HOST_NAME + 2) return null;
  if (/[\s@/\\?#%]/.test(s) || /\p{Cc}/u.test(s)) return null;
  const bare = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  if (isIP(bare) === 6) return bare.toLowerCase();
  if (s.includes(":") || s.includes("[") || s.includes("]")) return null;
  const ascii = domainToASCII(s).replace(/\.$/, "");
  if (ascii === "" || ascii.length > MAX_HOST_NAME) return null;
  if (isIP(ascii) === 4) return ascii;
  return ascii.split(".").every((l) => LABEL.test(l)) ? ascii : null;
}

// ---- guarded targets ----------------------------------------------------------------------------------------

export class NetGuardError extends Error {
  override readonly name = "NetGuardError";
}

/** Exact `host:port` pairs (normalised host) that development and tests may reach whatever they resolve to. */
export type DevAllowList = ReadonlySet<string>;

const pair = (host: string, port: number) => `${host.includes(":") ? `[${host}]` : host}:${String(port)}`;

/**
 * Parses a development allow-list (`name`, e.g. `IMPORT_DEV_ALLOW_SOURCES`): a comma list of `host:port`. Throws when
 * it is set at all in production, or when an entry isn't a host and a port, so a typo never widens what's allowed.
 */
export function parseDevAllowList(
  value: string | undefined,
  env: { NODE_ENV?: string | undefined },
  name: string,
): DevAllowList {
  const entries = (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (entries.length === 0) return new Set();
  if (env.NODE_ENV === "production") throw new NetGuardError(`${name} is for development only; unset it in production`);
  const out = new Set<string>();
  for (const e of entries) {
    const m = /^(.+):(\d{1,5})$/.exec(e);
    const host = m?.[1] === undefined ? null : hostName(m[1]);
    const port = Number(m?.[2]);
    if (host === null || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new NetGuardError(`${name}: "${e}" is not host:port`);
    }
    out.add(pair(host, port));
  }
  return out;
}

export type GuardFailure = "bad_host" | "bad_port" | PinFailure;

/**
 * Where to connect for a host and port someone else chose: the pinned address (`address`) and the name for TLS
 * (`servername`, empty for an IP literal: SNI can't carry one; the certificate is then checked against the address).
 * `devAllowed` is true only for an allow-list entry (development and tests), whose address isn't checked; callers
 * may relax certificate checks for exactly those. Call it again for every connect.
 */
export async function guardTarget(
  input: { host: string; port: number },
  opts: {
    ports: readonly number[];
    resolve?: Resolver;
    allow?: DevAllowList;
    signal?: AbortSignal;
    /** For tests; defaults to the process environment. */
    env?: { NODE_ENV?: string | undefined };
  },
): Promise<
  | { ok: true; target: { address: string; family: 4 | 6; port: number; servername: string; devAllowed: boolean } }
  | { ok: false; reason: GuardFailure }
> {
  // However the allow-list was made, it never applies in production.
  if (opts.allow && opts.allow.size > 0 && (opts.env ?? process.env).NODE_ENV === "production") {
    throw new NetGuardError("A development allow-list is never used in production");
  }
  const host = hostName(input.host);
  if (host === null) return { ok: false, reason: "bad_host" };
  if (!opts.ports.includes(input.port)) return { ok: false, reason: "bad_port" };
  const resolve = opts.resolve ?? systemResolver;
  const servername = isIP(host) === 0 ? host : "";
  if (opts.allow?.has(pair(host, input.port))) {
    const literal = isIP(host);
    if (literal !== 0) {
      return {
        ok: true,
        target: { address: host, family: literal === 6 ? 6 : 4, port: input.port, servername, devAllowed: true },
      };
    }
    try {
      const first = (await withDeadline(resolve(host), opts.signal))[0];
      if (!first) return { ok: false, reason: "dns_failed" };
      return { ok: true, target: { ...first, port: input.port, servername, devAllowed: true } };
    } catch (err) {
      return { ok: false, reason: err === DEADLINE ? "timeout" : "dns_failed" };
    }
  }
  const pinned = await pinHost(host, resolve, opts.signal);
  if (!pinned.ok) return pinned;
  return { ok: true, target: { ...pinned.pin, port: input.port, servername, devAllowed: false } };
}
