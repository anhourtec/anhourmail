// SPDX-License-Identifier: MIT
/**
 * Client IP for rate limits and audit. X-Forwarded-For is only trusted when TRUST_PROXY=true (production, behind
 * our NGINX), otherwise anyone reaching the app directly could set it. We take the RIGHT-most entry — the address
 * our own proxy saw — so a client-supplied left-hand value can't be used to dodge per-IP limits even if the proxy
 * appends instead of overwriting (security audit 2026-10-21).
 */
export function clientIp(headers: Headers, trustProxy = process.env.TRUST_PROXY === "true"): string | null {
  if (!trustProxy) return null;
  const last = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return last && /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : null;
}
