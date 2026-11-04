// SPDX-License-Identifier: AGPL-3.0-only
import { isIPv4, isIPv6 } from "node:net";

/**
 * Client addresses for the sign-up gate (ADR-0031), normalised so one client can't count as several by spelling its
 * address differently: IPv4-mapped IPv6 (`::ffff:0:0/96`, in any spelling) and NAT64 (`64:ff9b::/96`) are the IPv4
 * address they carry; IPv6 is compared as eight lowercase groups.
 *
 * - `address`: the challenge binding and the per-address account tiers (exact address).
 * - `attempt`: the attempts tier — an IPv4 address, or an IPv6 /64 (a host can use any address in its /64).
 * - `network`: IPv4 /24, IPv6 /64. `network56` and `network48`: IPv6 only (one customer is usually given a /56 or /48).
 * - `audit`: what refusal audits are bounded by — IPv4 /24, IPv6 /48.
 *
 * Anything that isn't an IP address (only without a trusted proxy in dev: `direct`) is its own everything.
 */
export type SignUpClient = {
  address: string;
  attempt: string;
  network: string;
  network56: string | null;
  network48: string | null;
  audit: string;
};

export function signUpClient(ip: string | null): SignUpClient {
  const raw = (ip ?? "").trim();
  const v4 = isIPv4(raw) ? raw : isIPv6(raw) ? embeddedIpv4(ipv6Groups(raw)) : null;
  if (v4) {
    const net = v4.split(".").slice(0, 3).join(".");
    return {
      address: `ip4:${v4}`,
      attempt: `ip4:${v4}`,
      network: `net4:${net}`,
      network56: null,
      network48: null,
      audit: `net4:${net}`,
    };
  }
  if (isIPv6(raw)) {
    const g = ipv6Groups(raw);
    const prefix = (n: number) => g.slice(0, n).join(":");
    // A /56 ends inside the fourth group: keep its top byte.
    const g4 = parseInt(g[3] ?? "0", 16);
    const net56 = `${prefix(3)}:${(g4 >> 8).toString(16)}`;
    return {
      address: `ip6:${g.join(":")}`,
      attempt: `net6/64:${prefix(4)}`,
      network: `net6/64:${prefix(4)}`,
      network56: `net6/56:${net56}`,
      network48: `net6/48:${prefix(3)}`,
      audit: `net6/48:${prefix(3)}`,
    };
  }
  const other = `other:${raw === "" ? "direct" : raw.toLowerCase()}`;
  return { address: other, attempt: other, network: other, network56: null, network48: null, audit: other };
}

/** Eight lowercase, unpadded hex groups of a valid IPv6 address (`isIPv6` first), a trailing dotted quad included. */
function ipv6Groups(ip: string): string[] {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = Array.from({ length: 8 - left.length - right.length }, () => "0");
  return [...left, ...fill, ...right].map((x) => parseInt(x, 16).toString(16));
}

/** The IPv4 address inside an IPv4-mapped (`::ffff:0:0/96`) or NAT64 (`64:ff9b::/96`) address, else null. */
function embeddedIpv4(g: string[]): string | null {
  const head = g.slice(0, 6).join(":");
  if (head !== "0:0:0:0:0:ffff" && head !== "64:ff9b:0:0:0:0") return null;
  const hi = parseInt(g[6] ?? "0", 16);
  const lo = parseInt(g[7] ?? "0", 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}
