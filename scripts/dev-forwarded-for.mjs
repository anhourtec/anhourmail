// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dev only: the X-Forwarded-For value `scripts/dev-mail-proxy.mjs` sends to the app, so the app (TRUST_PROXY=true
 * in dev) and Stalwart key rate limits and failed-login bans on the visitor, never on the shared forwarder.
 *
 * - A visitor on another machine (LAN): their socket address, replacing anything they sent.
 * - A visitor on this machine (loopback): a valid address they sent is kept (test tooling sets documentation-range
 *   addresses so deliberate wrong passwords never pile up on the shared loopback identity; anything on this machine
 *   could reach the app directly anyway), else the loopback address.
 */
const IP = /^[0-9a-fA-F:.]{2,45}$/;

/** `::ffff:127.0.0.1` → `127.0.0.1`. */
export function plainAddress(address) {
  return typeof address === "string" ? address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "") : "";
}

const isLoopback = (a) => a === "::1" || /^127\./.test(a);

/** @param {string | undefined} remoteAddress @param {string | string[] | undefined} sent */
export function forwardedFor(remoteAddress, sent) {
  const remote = plainAddress(remoteAddress);
  if (isLoopback(remote)) {
    const claimed = (Array.isArray(sent) ? sent.join(",") : (sent ?? "")).split(",").at(-1)?.trim() ?? "";
    if (IP.test(claimed)) return claimed;
  }
  return IP.test(remote) ? remote : "127.0.0.1";
}
