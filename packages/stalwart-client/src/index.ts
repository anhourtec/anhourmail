// SPDX-License-Identifier: MIT
import { StalwartTransport } from "./client";
import { StalwartManagement } from "./management";

export {
  type MethodCall,
  type StalwartAuth,
  type StalwartClientOptions,
  StalwartError,
  StalwartTransport,
} from "./client";
export {
  appPasswordPermissions,
  type AppPasswordScope,
  isAppPasswordSecret,
  KNOWN_PERMISSIONS,
  PRINCIPAL_READ_PERMISSIONS,
  SCOPE_ALLOW,
  scopesOf,
  SELF_SERVICE_PERMISSIONS,
} from "./app-passwords";
export {
  type AppPasswordRecord,
  type DomainInput,
  type RelayRouteInput,
  StalwartManagement,
  CUSTOMER_PERMISSIONS,
  SUSPENDED_PERMISSIONS,
  type UserInput,
} from "./management";
export {
  OAuthDeniedError,
  OAuthThrottledError,
  type OAuthClientInput,
  type OAuthTokens,
  OAuthUnavailableError,
  pkcePair,
  StalwartOAuth,
  type StalwartOAuthOptions,
  upsertOAuthClient,
  WEBMAIL_OAUTH_CLIENT_ID,
  webmailRedirectUri,
} from "./oauth";
export {
  applySenderIdentityPolicy,
  SENDER_IDENTITY_DATA_SCRIPT_EXPRESSION,
  SENDER_IDENTITY_SCRIPT,
  SENDER_IDENTITY_SIEVE,
} from "./sender";

const globalForStalwart = globalThis as unknown as { amStalwart?: StalwartManagement };

/**
 * The shared management client, configured from the environment:
 * STALWART_URL plus STALWART_API_KEY (production), or STALWART_DEV_ADMIN_USER / _PASSWORD (dev only).
 */
export function stalwart(): StalwartManagement {
  if (!globalForStalwart.amStalwart) {
    const baseUrl = process.env.STALWART_URL;
    if (!baseUrl) throw new Error("STALWART_URL is not set");
    const token = process.env.STALWART_API_KEY;
    const username = process.env.STALWART_DEV_ADMIN_USER;
    const password = process.env.STALWART_DEV_ADMIN_PASSWORD;
    const auth =
      token !== undefined && token !== ""
        ? ({ type: "bearer", token } as const)
        : username && password
          ? ({ type: "basic", username, password } as const)
          : null;
    if (!auth) throw new Error("Set STALWART_API_KEY (or the dev admin credentials)");
    globalForStalwart.amStalwart = new StalwartManagement(new StalwartTransport({ baseUrl, auth }));
  }
  return globalForStalwart.amStalwart;
}
