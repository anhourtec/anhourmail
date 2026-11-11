// SPDX-License-Identifier: MIT
/**
 * The end user's address on a server-side JMAP client's requests (a backend-for-frontend talking to the mail server
 * for its users). Mail servers apply their per-client limits and bans to the address a request comes from; behind a
 * BFF that is the BFF's own address for every user, so one user's failed sign-ins or a burst of requests would count
 * against everyone. A server that trusts `X-Forwarded-For` from the BFF (and only from it) counts each user separately
 * when the BFF sets it.
 *
 * The address must be the one the BFF itself trusts (taken from its own reverse proxy, never read from a header the
 * user could set), and is always written, replacing any `X-Forwarded-For` the request already carried. Nothing that
 * isn't an IP address is ever sent.
 */

/** The header the address travels in. */
export const CLIENT_ADDRESS_HEADER = "X-Forwarded-For";

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;

function isIpv6(value: string): boolean {
  if (value.length > 45) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = halves.map((h) => (h === "" ? [] : h.split(":")));
  const all = groups.flat();
  // An IPv4 tail (`::ffff:192.0.2.1`) stands for the last two groups.
  const last = all.at(-1);
  const v4Tail = last !== undefined && IPV4.test(last);
  const hextets = v4Tail ? all.slice(0, -1) : all;
  if (!hextets.every((g) => HEXTET.test(g))) return false;
  const count = hextets.length + (v4Tail ? 2 : 0);
  return halves.length === 2 ? count <= 7 : count === 8;
}

/** Whether `value` is one IPv4 or IPv6 address (no ports, lists, zones or names). */
export function isClientAddress(value: string): boolean {
  return IPV4.test(value) || (value.includes(":") && isIpv6(value));
}

/** The header to add for `address` (none when there is no address, or it isn't one). */
export function clientAddressHeaders(address: string | null | undefined): Record<string, string> {
  const a = address?.trim();
  return a && isClientAddress(a) ? { [CLIENT_ADDRESS_HEADER]: a } : {};
}

/**
 * Wraps `fetchImpl` so every request carries the address `address()` gives for the current request (read for each
 * call, e.g. from a request context). Without an address the header is removed, never passed on from the request.
 */
export function withClientAddress(
  fetchImpl: typeof fetch,
  address: () => string | null | undefined | Promise<string | null | undefined>,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete(CLIENT_ADDRESS_HEADER);
    for (const [k, v] of Object.entries(clientAddressHeaders(await address()))) headers.set(k, v);
    return fetchImpl(input, { ...init, headers });
  };
}
