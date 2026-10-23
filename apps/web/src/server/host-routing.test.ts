// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { hostKind, routeHost, WEBMAIL_COOKIE_NAMES, webmailSignedOutRedirect } from "./host-routing";

describe("host routing", () => {
  it("classifies hosts, including the dev webmail port", () => {
    expect(hostKind("mail.anhourmail.com")).toBe("mail");
    expect(hostKind("app.anhourmail.com")).toBe("app");
    expect(hostKind("localhost:43300", "43300")).toBe("mail");
    expect(hostKind("localhost:43200", "43300")).toBe("bare");
    expect(hostKind("192.168.1.20:43300", "43300")).toBe("mail");
  });

  it("serves health on every host; the webmail host serves no other API", () => {
    for (const host of ["mail.anhourmail.com", "app.anhourmail.com", "localhost:43200"]) {
      expect(routeHost(host, "/api/health/ready", true)).toEqual({ action: "next" });
    }
    expect(routeHost("mail.anhourmail.com", "/api/public/example", true)).toEqual({ action: "not_found" });
  });

  it("serves the brand files (icons, manifest, logos) on every host", () => {
    for (const path of [
      "/site.webmanifest",
      "/favicon.svg",
      "/favicon-32x32.png",
      "/apple-touch-icon.png",
      "/icon-512.png",
      "/icon-maskable-512.png",
      "/og-image.png",
      "/anhourmail-logo-dark.svg",
    ]) {
      expect(routeHost("mail.anhourmail.com", path, true)).toEqual({ action: "next" });
      expect(routeHost("localhost:43300", path, false, "43300")).toEqual({ action: "next" });
    }
    expect(routeHost("mail.anhourmail.com", "/anhourtec-logo-dark-bg.svg", true)).toEqual({ action: "next" });
    expect(routeHost("mail.anhourmail.com", "/site.webmanifest.bak", true)).toEqual({
      action: "rewrite",
      path: "/webmail/site.webmanifest.bak",
    });
  });

  it("the webmail origin only serves the webmail", () => {
    expect(routeHost("mail.anhourmail.com", "/", true)).toEqual({ action: "rewrite", path: "/webmail" });
    expect(routeHost("mail.anhourmail.com", "/inbox", true)).toEqual({ action: "rewrite", path: "/webmail/inbox" });
    expect(routeHost("mail.anhourmail.com", "/webmail/x", true)).toEqual({ action: "next" });
    expect(routeHost("mail.anhourmail.com", "/api/me", true)).toEqual({ action: "not_found" });
    expect(routeHost("localhost:43300", "/", false, "43300")).toEqual({ action: "rewrite", path: "/webmail" });
  });

  it("the webmail API is served on the webmail origin (and dev bare hosts) only", () => {
    expect(routeHost("mail.anhourmail.com", "/api/webmail/jmap", true)).toEqual({ action: "next" });
    expect(routeHost("localhost:43300", "/api/webmail/session", false, "43300")).toEqual({ action: "next" });
    expect(routeHost("app.anhourmail.com", "/api/webmail/jmap", true)).toEqual({ action: "not_found" });
    expect(routeHost("app.localhost:43200", "/api/webmail/jmap", false, "43300")).toEqual({ action: "not_found" });
    expect(routeHost("localhost:43200", "/api/webmail/jmap", false, "43300")).toEqual({ action: "next" });
    expect(routeHost("localhost:43200", "/api/webmail/jmap", true)).toEqual({ action: "not_found" });
    expect(routeHost("mail.anhourmail.com", "/api/webmailx", true)).toEqual({ action: "not_found" });
  });

  it("the console origin never serves the webmail; dev bare hosts may", () => {
    expect(routeHost("app.anhourmail.com", "/webmail", true)).toEqual({ action: "not_found" });
    expect(routeHost("app.anhourmail.com", "/sign-in", true)).toEqual({ action: "next" });
    expect(routeHost("localhost:43200", "/webmail", false, "43300")).toEqual({ action: "next" });
    expect(routeHost("localhost:43200", "/webmail", true)).toEqual({ action: "not_found" });
    expect(routeHost("localhost:43300", "/", true, "43300")).toEqual({ action: "next" });
  });
});

describe("signed-out webmail visits", () => {
  it("go to sign-in before the page renders, on the webmail origin and on dev bare hosts", () => {
    expect(webmailSignedOutRedirect("/webmail", false, "")).toBe("/sign-in");
    expect(webmailSignedOutRedirect("/webmail/", false, "")).toBe("/sign-in");
    expect(webmailSignedOutRedirect("/webmail", false, "/webmail")).toBe("/webmail/sign-in");
  });

  it("leave everything else alone: a session cookie, the sign-in page itself, the API", () => {
    expect(webmailSignedOutRedirect("/webmail", true, "")).toBeNull();
    expect(webmailSignedOutRedirect("/webmail/sign-in", false, "")).toBeNull();
    expect(webmailSignedOutRedirect("/api/webmail/session", false, "")).toBeNull();
    expect(webmailSignedOutRedirect("/", false, "")).toBeNull();
    expect(WEBMAIL_COOKIE_NAMES).toEqual(["__Host-am.webmail", "am.webmail"]);
  });
});

describe("webmail paths", async () => {
  const { webmailBasePath } = await import("./webmail/paths");
  it("serves the webmail at the root of its origin, under /webmail elsewhere", () => {
    expect(webmailBasePath("mail.anhourmail.com", true)).toBe("");
    expect(webmailBasePath("localhost:43300", false, "43300")).toBe("");
    expect(webmailBasePath("localhost:43200", false, "43300")).toBe("/webmail");
    expect(webmailBasePath(null, true)).toBe("/webmail");
  });
});

describe("webmail CSP", async () => {
  const { newNonce, webmailCsp } = await import("./webmail/csp");
  it("is nonce-based, same-origin only, never framed, and adds unsafe-eval only in dev", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(nonce);
    const prod = webmailCsp(nonce, false);
    expect(prod).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(prod).not.toContain("unsafe-eval");
    for (const d of ["connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(prod).toContain(d);
    }
    expect(webmailCsp(nonce, true)).toContain("'unsafe-eval'");
  });
});
