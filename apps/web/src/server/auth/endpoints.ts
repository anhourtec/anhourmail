// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The better-auth endpoints the console uses, with their rate-limit tier (docs/internal/rate-limits.md). The catch-all
 * auth route answers 404 for everything else: plugin endpoints we replace with audited core services (listing and
 * revoking sessions, renaming and removing passkeys) and ones we don't use (email OTP, showing the TOTP secret again,
 * `get-session`, which would hand the session token to page script) are never reachable.
 */
export type AuthTier = "auth" | "authFactor" | "sensitive";

const ENDPOINTS: Record<"GET" | "POST", Record<string, AuthTier>> = {
  GET: {
    // The emailed "confirm your email address" link (token in the query; lands on /email-verified).
    "/verify-email": "auth",
    "/passkey/generate-authenticate-options": "auth",
    "/passkey/generate-register-options": "sensitive",
  },
  POST: {
    "/sign-in/email": "auth",
    "/sign-up/email": "auth",
    "/sign-out": "auth",
    "/request-password-reset": "auth",
    "/reset-password": "auth",
    // The first-sign-in password change (`/change-password`): needs a session and the current password.
    "/change-password": "sensitive",
    "/two-factor/verify-totp": "authFactor",
    "/two-factor/verify-backup-code": "authFactor",
    "/passkey/verify-authentication": "authFactor",
    "/two-factor/enable": "sensitive",
    "/two-factor/disable": "sensitive",
    "/two-factor/generate-backup-codes": "sensitive",
    "/passkey/verify-registration": "sensitive",
    "/step-up": "sensitive",
  },
};

/** The emailed reset link lands here first (`GET /api/auth/reset-password/<token>`), then redirects to the page. */
const RESET_CALLBACK = /^\/reset-password\/[A-Za-z0-9_-]{1,128}$/;

/** The endpoint's tier, or null when the console doesn't expose it. `path` is the full request path. */
export function authEndpoint(method: "GET" | "POST", path: string): { tier: AuthTier } | null {
  if (!path.startsWith("/api/auth/")) return null;
  const rest = path.slice("/api/auth".length);
  if (method === "GET" && RESET_CALLBACK.test(rest)) return { tier: "auth" };
  const tier = ENDPOINTS[method][rest];
  return tier ? { tier } : null;
}
