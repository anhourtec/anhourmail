// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { isAllowedRedirect, isSafeRedirectPath } from "./redirect-guard";

describe("redirect targets the identity endpoints accept", () => {
  it("accepts same-origin paths", () => {
    for (const ok of ["/reset-password", "/email-verified", "/email-verified?error=INVALID_TOKEN", "/a/b#c"]) {
      expect(isSafeRedirectPath(ok)).toBe(true);
    }
  });

  it("refuses other origins, protocol-relative and backslash tricks, schemes, whitespace and controls", () => {
    for (const bad of [
      "",
      "https://evil.example",
      "http://localhost:43200/x",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/ /evil.example",
      "/\n/evil.example",
      "javascript:alert(1)",
      "https:evil.example",
      "evil.example",
      `/${"a".repeat(600)}`,
    ]) {
      expect(isSafeRedirectPath(bad)).toBe(false);
    }
  });
});

describe("absolute redirect targets", () => {
  const trusted = ["http://localhost:43200", "https://app.example.test"];
  it("accepts our own trusted origins only", () => {
    expect(isAllowedRedirect("http://localhost:43200/reset-password", trusted)).toBe(true);
    expect(isAllowedRedirect("https://app.example.test/email-verified", trusted)).toBe(true);
    expect(isAllowedRedirect("/reset-password", trusted)).toBe(true);
  });

  it("refuses other origins, look-alikes, credentials, other schemes and tricks", () => {
    for (const bad of [
      "https://evil.example/reset-password",
      "http://localhost:43201/x",
      "https://app.example.test.evil.example/",
      "https://user@app.example.test/",
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.example",
      "/\\evil.example",
      "http://localhost:43200\\@evil.example",
      "not a url",
    ]) {
      expect(isAllowedRedirect(bad, trusted)).toBe(false);
    }
  });
});
