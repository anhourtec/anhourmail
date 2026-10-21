// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { hostKind, routeHost } from "./host-routing";

describe("host routing", () => {
  it("classifies hosts, including the dev webmail port", () => {
    expect(hostKind("mail.anhourmail.com")).toBe("mail");
    expect(hostKind("app.anhourmail.com")).toBe("app");
    expect(hostKind("localhost:43300", "43300")).toBe("mail");
    expect(hostKind("localhost:43200", "43300")).toBe("bare");
    expect(hostKind("192.168.1.20:43300", "43300")).toBe("mail");
  });

  it("serves health and public API on every host", () => {
    for (const host of ["mail.anhourmail.com", "app.anhourmail.com", "localhost:43200"]) {
      expect(routeHost(host, "/api/health/ready", true)).toEqual({ action: "next" });
      expect(routeHost(host, "/api/public/waitlist", true)).toEqual({ action: "next" });
    }
  });

  it("the webmail origin only serves the webmail", () => {
    expect(routeHost("mail.anhourmail.com", "/", true)).toEqual({ action: "rewrite", path: "/webmail" });
    expect(routeHost("mail.anhourmail.com", "/inbox", true)).toEqual({ action: "rewrite", path: "/webmail/inbox" });
    expect(routeHost("mail.anhourmail.com", "/webmail/x", true)).toEqual({ action: "next" });
    expect(routeHost("mail.anhourmail.com", "/api/me", true)).toEqual({ action: "not_found" });
    expect(routeHost("localhost:43300", "/", false, "43300")).toEqual({ action: "rewrite", path: "/webmail" });
  });

  it("the console origin never serves the webmail; dev bare hosts may", () => {
    expect(routeHost("app.anhourmail.com", "/webmail", true)).toEqual({ action: "not_found" });
    expect(routeHost("app.anhourmail.com", "/sign-in", true)).toEqual({ action: "next" });
    expect(routeHost("localhost:43200", "/webmail", false, "43300")).toEqual({ action: "next" });
    expect(routeHost("localhost:43200", "/webmail", true)).toEqual({ action: "not_found" });
    expect(routeHost("localhost:43300", "/", true, "43300")).toEqual({ action: "next" });
  });
});
