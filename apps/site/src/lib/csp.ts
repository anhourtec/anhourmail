// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The site's Content-Security-Policy (marketing pages, docs, changelog, credits). Nonce-based with `'strict-dynamic'`:
 * only the scripts Next renders with this request's nonce (and what they load) run. Everything else is same-origin —
 * self-hosted fonts and images, docs search against our own `/api/search` — so a third-party request is impossible
 * by policy, not only by habit (CLAUDE.md rule 29). Styles stay `'unsafe-inline'` (React `style` attributes and the
 * no-script reveal fallback). `connect-src 'self'` also covers the dev server's same-origin HMR websocket; dev adds
 * `'unsafe-eval'` (React's dev tooling), production never does.
 */
export function siteCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** API responses (docs search) are data, never pages. */
export const SITE_API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** A fresh per-request nonce (128 bits, base64). Works in the proxy's edge-style runtime. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
