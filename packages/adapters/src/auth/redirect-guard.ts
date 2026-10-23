// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Redirect targets the identity endpoints accept (XSS audit run-28 N2). better-auth 1.7 lets `redirectTo` on
 * request-password-reset and `callbackURL` on the emailed reset link point anywhere, so the link in our own email — or a
 * crafted one on our origin — could send a person to another site. Before any endpoint runs, every redirect field in
 * the body or query must be a path on this origin (one leading `/`, not `//` or `/\`, no backslashes, whitespace or
 * control characters) or an absolute http(s) URL on one of our own trusted origins. Anything else is refused (403
 * `INVALID_REDIRECT`) before better-auth looks at it.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/** Fields better-auth reads a redirect target from (body or query). */
export const REDIRECT_FIELDS = ["callbackURL", "redirectTo", "errorCallbackURL", "newUserCallbackURL"] as const;

/** True for a same-origin path like `/reset-password` or `/email-verified?x=1`. */
export function isSafeRedirectPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  // Backslashes act as slashes in browsers (`/\evil` → `//evil`); whitespace and controls are stripped by them.
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point of this pattern
  if (/[\\\u0000-\u0020\u007f-\u009f]/u.test(value)) return false;
  // A path never resolves to another origin.
  return new URL(value, "http://same.invalid").origin === "http://same.invalid";
}

/** A same-origin path, or an absolute http(s) URL whose origin is exactly one of `trustedOrigins`. */
export function isAllowedRedirect(value: string, trustedOrigins: readonly string[]): boolean {
  if (value.startsWith("/")) return isSafeRedirectPath(value);
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point of this pattern
  if (value.length > 2048 || /[\\\u0000-\u0020\u007f-\u009f]/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return trustedOrigins.some((o) => {
    try {
      return new URL(o).origin === url.origin;
    } catch {
      return false;
    }
  });
}

export function redirectGuardPlugin(trustedOrigins: readonly string[]): BetterAuthPlugin {
  return {
    id: "anhourmail-redirect-guard",
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const sources = [
              ctx.body as Record<string, unknown> | undefined,
              ctx.query as Record<string, unknown> | undefined,
            ];
            for (const source of sources) {
              if (!source || typeof source !== "object") continue;
              for (const field of REDIRECT_FIELDS) {
                const value = source[field];
                if (value === undefined || value === null || value === "") continue;
                if (typeof value !== "string" || !isAllowedRedirect(value, trustedOrigins)) {
                  throw new APIError("FORBIDDEN", {
                    code: "INVALID_REDIRECT",
                    message: "That link isn't valid here.",
                  });
                }
              }
            }
            return Promise.resolve();
          }),
        },
      ],
    },
  };
}
