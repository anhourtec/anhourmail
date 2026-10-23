// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { newNonce, SITE_API_CSP, siteCsp } from "./csp";

describe("site CSP", () => {
  it("is nonce-based with strict-dynamic and allows no other origin", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(nonce);
    const prod = siteCsp(nonce, false);
    expect(prod).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    for (const d of [
      "default-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(prod).toContain(d);
    }
    expect(prod).not.toMatch(/https?:|\*|unsafe-eval/);
  });

  it("adds unsafe-eval only in dev", () => {
    expect(siteCsp("n", true)).toContain("'strict-dynamic' 'unsafe-eval'");
  });

  it("gives the search API a data-only policy", () => {
    expect(SITE_API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
