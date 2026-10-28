// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { authEndpoint } from "./endpoints";

describe("auth endpoint allow-list", () => {
  it("gives second steps the tight tier and factor changes the sensitive one", () => {
    expect(authEndpoint("POST", "/api/auth/sign-in/email")).toEqual({ tier: "auth" });
    expect(authEndpoint("POST", "/api/auth/two-factor/verify-totp")).toEqual({ tier: "authFactor" });
    expect(authEndpoint("POST", "/api/auth/two-factor/verify-backup-code")).toEqual({ tier: "authFactor" });
    expect(authEndpoint("POST", "/api/auth/passkey/verify-authentication")).toEqual({ tier: "authFactor" });
    expect(authEndpoint("POST", "/api/auth/two-factor/disable")).toEqual({ tier: "sensitive" });
    expect(authEndpoint("POST", "/api/auth/step-up")).toEqual({ tier: "sensitive" });
    expect(authEndpoint("GET", "/api/auth/passkey/generate-register-options")).toEqual({ tier: "sensitive" });
    expect(authEndpoint("GET", "/api/auth/reset-password/abcDEF_123-x")).toEqual({ tier: "auth" });
    expect(authEndpoint("GET", "/api/auth/verify-email")).toEqual({ tier: "auth" });
    expect(authEndpoint("POST", "/api/auth/change-password")).toEqual({ tier: "sensitive" });
  });

  it("exposes the emailed confirmation link but never the public send endpoint (the console has its own route)", () => {
    expect(authEndpoint("POST", "/api/auth/send-verification-email")).toBeNull();
    expect(authEndpoint("POST", "/api/auth/verify-email")).toBeNull();
    expect(authEndpoint("POST", "/api/auth/change-email")).toBeNull();
  });

  it("refuses endpoints the console replaces or doesn't use", () => {
    for (const [method, path] of [
      ["GET", "/api/auth/list-sessions"],
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/revoke-session"],
      ["POST", "/api/auth/revoke-other-sessions"],
      ["POST", "/api/auth/passkey/delete-passkey"],
      ["POST", "/api/auth/passkey/update-passkey"],
      ["GET", "/api/auth/passkey/list-user-passkeys"],
      ["POST", "/api/auth/two-factor/get-totp-uri"],
      ["POST", "/api/auth/two-factor/send-otp"],
      ["POST", "/api/auth/two-factor/view-backup-codes"],
      ["POST", "/api/auth/update-user"],
      ["GET", "/api/auth/sign-in/email"],
      ["GET", "/api/auth/change-password"],
      ["GET", "/api/auth/reset-password/../x"],
      ["POST", "/api/other/sign-in/email"],
    ] as const) {
      expect(authEndpoint(method, path), `${method} ${path}`).toBeNull();
    }
  });
});
