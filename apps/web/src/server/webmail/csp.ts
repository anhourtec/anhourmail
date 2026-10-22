// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The webmail pages' Content-Security-Policy (docs/internal/05-webmail.md "Rendering safety"): nonce-based with
 * `'strict-dynamic'`, same-origin connections only, no plugins, no `<base>`, never framed. Message HTML renders in a
 * `srcdoc` frame, which inherits this policy on top of its own (`img-src` allows only this origin and `data:`, so
 * remote images can't load even if a sanitiser bug let one through). Styles stay `'unsafe-inline'` because message
 * HTML is styled inline. Dev adds `'unsafe-eval'` (React's dev tooling); production never does.
 */
export function webmailCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A fresh per-request nonce (128 bits, base64). Works in the proxy's edge-style runtime. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
