// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The console pages' Content-Security-Policy (docs/internal/07-security.md): nonce-based with `'strict-dynamic'`, so
 * only the scripts Next renders with this request's nonce (and what they load) run; same-origin everything else, no
 * plugins, no `<base>`, never framed. Styles stay `'unsafe-inline'` (React `style` attributes and the components'
 * inline styles). `img-src data:` is for the CSS noise texture; the two-factor QR code is inline SVG and the
 * recovery-codes download is a `data:` link, which a CSP doesn't govern. Passkeys need nothing here. `connect-src
 * 'self'` also covers the dev server's same-origin HMR websocket; dev adds `'unsafe-eval'` (React's dev tooling),
 * production never does. The webmail has its own, wider policy (`webmail/csp.ts`: frames, blobs, workers).
 */
export function consoleCsp(nonce: string, dev: boolean): string {
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

/**
 * API responses are data, never pages. `route()` sets this on every console and webmail API response that doesn't
 * set its own; the proxy sets it on the console API too, so handlers outside `route()` (health) carry it as well.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
