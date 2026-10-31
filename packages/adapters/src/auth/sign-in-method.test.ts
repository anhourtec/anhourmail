// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { signInMethodFor } from ".";
import { sessionMethod } from "./security-plugin";

describe("how a new session signed in (ADR-0028)", () => {
  it("names the step that created it", () => {
    expect(signInMethodFor("/sign-in/email", null)).toBe("password");
    expect(signInMethodFor("/sign-up/email", null)).toBe("password");
    expect(signInMethodFor("/two-factor/verify-backup-code", null)).toBe("password+recovery_code");
    // A passkey is only ever the second step after the password.
    expect(signInMethodFor("/passkey/verify-authentication", null)).toBe("password+passkey");
  });

  it("turning on an authenticator app keeps a passkey session's method, otherwise records the code", () => {
    expect(signInMethodFor("/two-factor/verify-totp", { signInMethod: "password+passkey" })).toBe("password+passkey");
    // A passwordless session from before ADR-0028 is never carried over.
    expect(signInMethodFor("/two-factor/verify-totp", { signInMethod: "passkey" })).toBe("password+totp");
    expect(signInMethodFor("/change-password", { signInMethod: "passkey" })).toBe("password");
    expect(signInMethodFor("/two-factor/verify-totp", { signInMethod: "password" })).toBe("password+totp");
    expect(signInMethodFor("/two-factor/verify-totp", null)).toBe("password+totp");
  });

  it("re-created sessions keep the method they replace; unknown values count as the password alone", () => {
    expect(signInMethodFor("/change-password", { signInMethod: "password+passkey" })).toBe("password+passkey");
    expect(signInMethodFor("/change-password", { signInMethod: "made-up" })).toBe("password");
    expect(signInMethodFor(undefined, undefined)).toBe("password");
    expect(sessionMethod({ signInMethod: "password+passkey" })).toBe("password+passkey");
    expect(sessionMethod({ signInMethod: 1 })).toBe("password");
    expect(sessionMethod(null)).toBe("password");
  });
});
