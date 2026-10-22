// SPDX-License-Identifier: MIT
import { createHash, randomBytes } from "node:crypto";

import { type StalwartManagement } from "./management";

/**
 * Stalwart's OAuth server (v0.16), used by the webmail BFF to hold a per-user session without ever storing the
 * mailbox password (docs/internal/05-webmail.md "Session acquisition", ADR-0018):
 *
 *   1. `POST /api/auth {type:"authCode", …}`  — mailbox address + password (used once) → one-time `client_code`
 *   2. `POST /auth/token` authorization_code + PKCE S256 verifier → access + refresh tokens
 *   3. `POST /auth/token` refresh_token → a new access token
 *
 * Stalwart v0.16 advertises no revocation endpoint; signing out drops our copy of the tokens (the access token
 * expires within the hour, and a mailbox password change revokes everything server-side).
 */

/** The webmail's registered client id (`x:OAuthClient`). */
export const WEBMAIL_OAUTH_CLIENT_ID = "anhourmail-webmail";

/** The redirect URI the BFF names in the headless flow; it is never visited, but must be registered exactly. */
export const webmailRedirectUri = (webmailOrigin: string): string =>
  `${webmailOrigin.replace(/\/+$/, "")}/oauth/callback`;

export type OAuthClientInput = { clientId: string; description: string; redirectUris: string[] };

/** Creates or updates an `x:OAuthClient` by client id (idempotent). Returns its object id. */
export async function upsertOAuthClient(mgmt: StalwartManagement, input: OAuthClientInput): Promise<string> {
  const t = mgmt.transport;
  const fields = {
    description: input.description,
    redirectUris: Object.fromEntries(input.redirectUris.map((u) => [u, true])),
  };
  const clients = await t.getAll<{ id: string; clientId: string }>("x:OAuthClient", ["clientId"]);
  const existing = clients.find((c) => c.clientId === input.clientId);
  if (existing) {
    await t.set("x:OAuthClient", { update: { [existing.id]: fields } });
    return existing.id;
  }
  const { created } = await t.set("x:OAuthClient", { create: { c: { clientId: input.clientId, ...fields } } });
  const id = created.c?.id;
  if (!id) throw new Error(`OAuth client ${input.clientId} was not created`);
  return id;
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
};

/** The flow failed because the credentials or the grant are no good (wrong password, revoked refresh token). */
export class OAuthDeniedError extends Error {
  override readonly name = "OAuthDeniedError";
}

/** Stalwart is throttling or has banned the caller (HTTP 429 / 403): not a verdict on the password. */
export class OAuthThrottledError extends Error {
  override readonly name = "OAuthThrottledError";
}

/** Stalwart could not be reached or answered something unexpected (not the user's fault). */
export class OAuthUnavailableError extends Error {
  override readonly name = "OAuthUnavailableError";
}

export type StalwartOAuthOptions = {
  /** Stalwart's HTTP base URL (internal network in production). */
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  now?: () => number;
};

/** PKCE S256 pair (RFC 7636): a 43-char verifier and its SHA-256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };

export class StalwartOAuth {
  readonly #opts: StalwartOAuthOptions;
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(opts: StalwartOAuthOptions) {
    this.#opts = opts;
    this.#fetch = opts.fetch ?? fetch;
    this.#base = opts.baseUrl.replace(/\/+$/, "");
  }

  /**
   * `clientIp` is the end user's address (already validated by the caller's trusted-proxy logic). Stalwart applies
   * its anonymous rate limit and its failed-login ban per client address, so without it every webmail user would
   * share — and could get banned on — the app's own address. Stalwart honours it only with `x:Http.useXForwarded`,
   * which is safe only because its HTTP listener is reachable from the app's network alone.
   */
  async #post(path: string, init: RequestInit, clientIp?: string | null): Promise<Response> {
    const headers = new Headers(init.headers);
    if (clientIp) headers.set("X-Forwarded-For", clientIp);
    try {
      return await this.#fetch(`${this.#base}${path}`, {
        ...init,
        headers,
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#opts.timeoutMs ?? 10_000),
      });
    } catch {
      throw new OAuthUnavailableError(`Stalwart ${path} unreachable`);
    }
  }

  #tokens(body: TokenResponse): OAuthTokens {
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new OAuthUnavailableError("Token response without an access token");
    }
    const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
      expiresAt: (this.#opts.now ?? Date.now)() + expiresIn * 1000,
    };
  }

  async #token(form: Record<string, string>, clientIp?: string | null): Promise<OAuthTokens> {
    const res = await this.#post(
      "/auth/token",
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      },
      clientIp,
    );
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (res.status === 429 || res.status === 403) throw new OAuthThrottledError("token endpoint throttled");
    if (res.status === 400 || res.status === 401) throw new OAuthDeniedError(`token grant refused`);
    if (!res.ok) throw new OAuthUnavailableError(`token endpoint HTTP ${String(res.status)}`);
    return this.#tokens(body);
  }

  /**
   * Signs in with the mailbox address and password (used once, never stored or logged) and returns tokens.
   * Wrong credentials → `OAuthDeniedError` (Stalwart answers HTTP 200 `{type:"failure"}`); throttling or a ban
   * (429 / 403) → `OAuthThrottledError`, never "wrong password".
   */
  async signIn(accountName: string, accountSecret: string, clientIp?: string | null): Promise<OAuthTokens> {
    const { verifier, challenge } = pkcePair();
    const res = await this.#post(
      "/api/auth",
      {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          type: "authCode",
          accountName,
          accountSecret,
          clientId: this.#opts.clientId,
          redirectUri: this.#opts.redirectUri,
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        }),
      },
      clientIp,
    );
    if (res.status === 429 || res.status === 403) throw new OAuthThrottledError("sign-in throttled");
    if (res.status === 401) throw new OAuthDeniedError("sign-in refused");
    if (!res.ok) throw new OAuthUnavailableError(`auth endpoint HTTP ${String(res.status)}`);
    const body = (await res.json().catch(() => ({}))) as { type?: unknown; client_code?: unknown };
    if (body.type !== "authenticated" || typeof body.client_code !== "string") {
      // `failure`, or a second factor we don't support yet (`mfaRequired`): both are a refusal to the user.
      throw new OAuthDeniedError("sign-in refused");
    }
    return this.#token(
      {
        grant_type: "authorization_code",
        code: body.client_code,
        client_id: this.#opts.clientId,
        redirect_uri: this.#opts.redirectUri,
        code_verifier: verifier,
      },
      clientIp,
    );
  }

  /** Exchanges a refresh token for a new access token; a revoked grant → `OAuthDeniedError`. */
  async refresh(refreshToken: string, clientIp?: string | null): Promise<OAuthTokens> {
    const t = await this.#token(
      { grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.#opts.clientId },
      clientIp,
    );
    return { ...t, refreshToken: t.refreshToken ?? refreshToken };
  }
}
