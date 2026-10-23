// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { API_CSP, consoleCsp } from "./console-csp";
import { newNonce, webmailCsp } from "./webmail/csp";

const directives = (csp: string) => csp.split("; ").map((d) => d.split(" ")[0]);

describe("console CSP", () => {
  it("is nonce-based with strict-dynamic, same-origin only, never framed", () => {
    const nonce = newNonce();
    const prod = consoleCsp(nonce, false);
    expect(prod).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    expect(prod).not.toMatch(/https?:|\*|unsafe-eval|blob:/);
  });

  it("adds unsafe-eval only in dev", () => {
    expect(consoleCsp("n", true)).toContain("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    expect(consoleCsp("n", false)).not.toContain("unsafe-eval");
  });

  it("names each directive once and is no wider than the webmail policy", () => {
    const own = directives(consoleCsp("n", false));
    expect(new Set(own).size).toBe(own.length);
    expect(own).not.toContain("frame-src");
    expect(own).not.toContain("worker-src");
    expect(directives(webmailCsp("n", false))).toEqual(expect.arrayContaining(own));
  });

  it("gives API responses a data-only policy", () => {
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
